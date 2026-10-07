"""Bill split maths. PURE: no I/O, no framework imports.

Behaviour carried over from the original frontend (``useCalculations.ts`` +
``useItemAssignment.ts``), made exact in integer cents:

* Each item's total is shared among people according to its ``mode``:

  - ``single``   – one person pays the whole item;
  - ``equal``    – ``allocate(total, [1] * n)``;
  - ``weighted`` – ``allocate(total, weights)`` (percentages, "by shares", quick split);
  - ``custom``   – fixed ``amount_cents`` per person (should sum to the item total; if
    they don't, the amounts are still used as given and an issue is reported, exactly
    like the old UI did before it blocked "Next").

* A person's ``items_cents`` is the sum of their item shares.
* Every person pays ``grand_total × items_cents / Σ items_cents`` – i.e.
  ``allocate(grand_total, [items_cents per participant])`` – so tax, service charge,
  discounts and rounding are spread proportionally and the totals sum **exactly** to
  the grand total (remainder to the largest share, first on ties).

Unassigned items do not count towards anyone's subtotal (their cost is spread
proportionally over the assigned items); they are reported so the UI can block.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal

from app.core.money import allocate

SplitMode = Literal["single", "equal", "weighted", "custom"]
SPLIT_MODES: tuple[str, ...] = ("single", "equal", "weighted", "custom")


@dataclass(frozen=True)
class ShareInput:
    person_id: str
    weight: Decimal | None = None
    amount_cents: int | None = None


@dataclass(frozen=True)
class ItemInput:
    id: str
    total_cents: int
    mode: str | None = None
    shares: tuple[ShareInput, ...] = ()
    name: str = ""


@dataclass(frozen=True)
class SplitInput:
    participants: tuple[str, ...]
    items: tuple[ItemInput, ...]
    grand_total_cents: int


@dataclass(frozen=True)
class Issue:
    code: str
    message: str
    item_id: str | None = None
    person_id: str | None = None
    expected_cents: int | None = None
    actual_cents: int | None = None


@dataclass(frozen=True)
class PersonResult:
    person_id: str
    items_cents: int
    total_cents: int
    item_shares: tuple[tuple[str, int], ...]  # (item_id, cents) in item order

    @property
    def adjustment_cents(self) -> int:
        """Share of tax / service / discount / rounding (total − items)."""
        return self.total_cents - self.items_cents


@dataclass(frozen=True)
class SplitResult:
    grand_total_cents: int
    all_items_cents: int
    assigned_items_cents: int
    people: tuple[PersonResult, ...]
    item_allocations: dict[str, dict[str, int]] = field(default_factory=dict)
    unassigned_item_ids: tuple[str, ...] = ()
    issues: tuple[Issue, ...] = ()

    @property
    def is_complete(self) -> bool:
        return bool(self.people) and not self.unassigned_item_ids and not self.issues

    def person(self, person_id: str) -> PersonResult | None:
        return next((p for p in self.people if p.person_id == person_id), None)


def _allocate_item(item: ItemInput, participants: set[str], issues: list[Issue]) -> dict[str, int] | None:
    """Return {person_id: cents} for one item, or None when it is unassigned."""
    shares = [s for s in item.shares if s.person_id in participants]
    dropped = [s for s in item.shares if s.person_id not in participants]
    for s in dropped:
        issues.append(Issue("share_not_participant", "A share references someone who is not on this bill.",
                            item_id=item.id, person_id=s.person_id))
    if not item.mode or not shares:
        return None

    if item.mode == "single":
        if len(shares) > 1:
            issues.append(Issue("single_has_many_shares", "Single assignment has more than one person; using the first.",
                                item_id=item.id))
        return {shares[0].person_id: item.total_cents}

    if item.mode == "equal":
        amounts = allocate(item.total_cents, [1] * len(shares))
        return {s.person_id: a for s, a in zip(shares, amounts, strict=True)}

    if item.mode == "weighted":
        weights = [s.weight if s.weight is not None and s.weight > 0 else Decimal(0) for s in shares]
        if sum(weights, Decimal(0)) <= 0:
            issues.append(Issue("zero_weights", "Weighted split needs at least one positive weight.", item_id=item.id))
            return None
        amounts = allocate(item.total_cents, weights)
        return {s.person_id: a for s, a in zip(shares, amounts, strict=True)}

    if item.mode == "custom":
        result = {s.person_id: int(s.amount_cents or 0) for s in shares}
        actual = sum(result.values())
        if actual != item.total_cents:
            issues.append(Issue("custom_amounts_mismatch", "Custom amounts don't add up to the item total.",
                                item_id=item.id, expected_cents=item.total_cents, actual_cents=actual))
        return result

    issues.append(Issue("unknown_mode", f"Unknown split mode {item.mode!r}.", item_id=item.id))
    return None


def compute_split(inp: SplitInput) -> SplitResult:
    participants = list(dict.fromkeys(inp.participants))  # de-dupe, keep order
    pset = set(participants)
    issues: list[Issue] = []
    items_cents = {p: 0 for p in participants}
    per_person_items: dict[str, list[tuple[str, int]]] = {p: [] for p in participants}
    allocations: dict[str, dict[str, int]] = {}
    unassigned: list[str] = []

    for item in inp.items:
        alloc = _allocate_item(item, pset, issues)
        if alloc is None:
            unassigned.append(item.id)
            continue
        allocations[item.id] = alloc
        for pid, cents in alloc.items():
            items_cents[pid] += cents
            per_person_items[pid].append((item.id, cents))

    if not participants:
        issues.append(Issue("no_participants", "Add at least one person to split this bill."))

    subtotals = [items_cents[p] for p in participants]
    assigned_total = sum(subtotals)
    if participants and assigned_total == 0 and inp.grand_total_cents != 0:
        issues.append(Issue("zero_items_subtotal",
                            "Assigned items add up to zero, so the total can't be shared proportionally."))
    totals = allocate(inp.grand_total_cents, subtotals)

    people = tuple(
        PersonResult(person_id=p, items_cents=items_cents[p], total_cents=t, item_shares=tuple(per_person_items[p]))
        for p, t in zip(participants, totals, strict=True)
    )
    for item_id in unassigned:
        issues.append(Issue("unassigned_item", "This item isn't assigned to anyone yet.", item_id=item_id))

    return SplitResult(
        grand_total_cents=inp.grand_total_cents,
        all_items_cents=sum(i.total_cents for i in inp.items),
        assigned_items_cents=assigned_total,
        people=people,
        item_allocations=allocations,
        unassigned_item_ids=tuple(unassigned),
        issues=tuple(issues),
    )


def quick_split_item(total_cents: int, person_ids: Sequence[str], weights: Sequence[Decimal] | None = None,
                     item_id: str = "quick", name: str = "Total") -> ItemInput:
    """The synthetic single item used by quick split (equal or by shares)."""
    if weights is None:
        return ItemInput(id=item_id, name=name, total_cents=total_cents, mode="equal",
                         shares=tuple(ShareInput(p) for p in person_ids))
    return ItemInput(id=item_id, name=name, total_cents=total_cents, mode="weighted",
                     shares=tuple(ShareInput(p, weight=w) for p, w in zip(person_ids, weights, strict=True)))
