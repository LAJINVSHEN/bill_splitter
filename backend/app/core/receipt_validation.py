"""Receipt validation. PURE: no I/O, no framework imports.

Ported from the original ``receipt_validator.py`` with the same meaning, in cents:

* tolerance: 5 cents;
* **subtotal shown** (> 0): items must equal the subtotal, and subtotal + charges must
  equal the grand total → ``tax_exclusive``;
* **no subtotal, no charges**: items must equal the grand total → ``no_taxes``;
* **no subtotal, with charges**: items == grand total → ``tax_inclusive``;
  items == grand total − charges (≥ 0) → ``tax_exclusive``; otherwise neither matches;
* item lines where ``quantity × unit_price`` differs from ``total_price`` by more than
  the tolerance are reported as **warnings** (never fatal – same as before);
* charge percentages are computed for display (inclusive: base = subtotal − charges).

User-facing messages are the ones the old ``_format_user_friendly_error`` produced;
the original technical text is kept in ``technical``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from app.core.money import format_cents

TOLERANCE_CENTS = 5

TaxScenario = Literal["tax_exclusive", "tax_inclusive", "no_taxes"]
ChargeKind = Literal["tax", "service", "discount", "rounding", "other"]
CHARGE_KINDS: tuple[str, ...] = ("tax", "service", "discount", "rounding", "other")

MSG_ITEMS_MISMATCH = (
    "The individual item prices don't add up to the subtotal shown on the receipt. "
    "Please review and correct the amounts."
)
MSG_GRAND_MISMATCH = (
    "The subtotal plus taxes doesn't equal the grand total. Please verify all amounts match the receipt."
)
MSG_GRAND_MISSING = "Could not find the total amount on the receipt. Please enter it manually."
MSG_NO_ITEMS = "No items were found on the receipt. Please add them manually."

_DISCOUNT_RE = re.compile(r"discount|promo|voucher|coupon|rebate|\boff\b|%\s*off")


@dataclass(frozen=True)
class ReceiptItem:
    name: str
    quantity: Decimal
    unit_price_cents: int
    total_price_cents: int


@dataclass(frozen=True)
class ReceiptCharge:
    name: str
    amount_cents: int


@dataclass(frozen=True)
class ValidationError:
    code: str
    message: str
    technical: str


@dataclass(frozen=True)
class ItemWarning:
    code: str
    item_index: int
    message: str
    expected_cents: int
    actual_cents: int


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    tax_scenario: TaxScenario | None
    items_total_cents: int
    charges_total_cents: int
    grand_total_cents: int
    provided_subtotal_cents: int | None
    final_subtotal_cents: int | None
    errors: tuple[ValidationError, ...] = ()
    warnings: tuple[ItemWarning, ...] = ()
    charge_percents: tuple[Decimal | None, ...] = field(default_factory=tuple)

    @property
    def message(self) -> str | None:
        return self.errors[0].message if self.errors else None


def _pct(amount: int, base: int) -> Decimal:
    return (Decimal(amount) * 100 / Decimal(base)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def infer_charge_kind(name: str, amount_cents: int) -> ChargeKind:
    """Classify a charge line by its name (used when the LLM / client gives no kind)."""
    n = name.lower()
    if "round" in n:
        return "rounding"
    if amount_cents < 0 or _DISCOUNT_RE.search(n):
        return "discount"
    if any(k in n for k in ("tax", "gst", "vat", "sst")):
        return "tax"
    if "service" in n or "svc" in n or "charge" in n:
        return "service"
    return "other"


def _fmt(cents: int) -> str:
    return format_cents(cents)


def validate_receipt(
    items: Sequence[ReceiptItem],
    charges: Sequence[ReceiptCharge],
    grand_total_cents: int | None,
    subtotal_cents: int | None = None,
) -> ValidationResult:
    items_total = sum(i.total_price_cents for i in items)
    charges_total = sum(c.amount_cents for c in charges)
    grand = grand_total_cents or 0
    provided_subtotal = subtotal_cents if subtotal_cents and subtotal_cents > 0 else None

    warnings: list[ItemWarning] = []
    for idx, item in enumerate(items):
        expected = int((item.quantity * item.unit_price_cents).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        if abs(item.total_price_cents - expected) > TOLERANCE_CENTS:
            warnings.append(ItemWarning(
                code="item_math_mismatch",
                item_index=idx,
                message=(f"{item.name}: {item.quantity} × {_fmt(item.unit_price_cents)} = {_fmt(expected)}, "
                         f"but the line total is {_fmt(item.total_price_cents)}."),
                expected_cents=expected,
                actual_cents=item.total_price_cents,
            ))

    def result(ok: bool, scenario: TaxScenario | None, final_subtotal: int | None,
               errors: Sequence[ValidationError] = ()) -> ValidationResult:
        percents: tuple[Decimal | None, ...] = tuple(None for _ in charges)
        if ok and final_subtotal is not None and charges_total != 0 and final_subtotal > 0:
            if scenario == "tax_inclusive":
                base = final_subtotal - charges_total
                percents = tuple(_pct(c.amount_cents, base) if base > 0 else Decimal("0.00") for c in charges)
            else:
                percents = tuple(_pct(c.amount_cents, final_subtotal) for c in charges)
        return ValidationResult(
            ok=ok, tax_scenario=scenario, items_total_cents=items_total, charges_total_cents=charges_total,
            grand_total_cents=grand, provided_subtotal_cents=provided_subtotal, final_subtotal_cents=final_subtotal,
            errors=tuple(errors), warnings=tuple(warnings), charge_percents=percents,
        )

    def fail(code: str, message: str, technical: str) -> ValidationResult:
        return result(False, None, None, [ValidationError(code, message, technical)])

    if not items:
        return fail("no_items", MSG_NO_ITEMS, "Invalid JSON structure received")
    if grand <= 0:
        return fail("grand_total_missing", MSG_GRAND_MISSING, "Grand total is missing or invalid - this is mandatory")

    if provided_subtotal is not None:
        diff = abs(items_total - provided_subtotal)
        if diff > TOLERANCE_CENTS:
            return fail("items_subtotal_mismatch", MSG_ITEMS_MISMATCH,
                        f"Items total ({_fmt(items_total)}) does not match provided subtotal "
                        f"({_fmt(provided_subtotal)}). Difference: {_fmt(diff)}.")
        expected_grand = provided_subtotal + charges_total
        gdiff = abs(expected_grand - grand)
        if gdiff > TOLERANCE_CENTS:
            return fail("grand_total_mismatch", MSG_GRAND_MISMATCH,
                        f"Grand total validation failed. Expected: {_fmt(expected_grand)} "
                        f"(subtotal {_fmt(provided_subtotal)} + taxes {_fmt(charges_total)}), "
                        f"but got: {_fmt(grand)}. Difference: {_fmt(gdiff)}.")
        return result(True, "tax_exclusive", provided_subtotal)

    if charges_total == 0:
        diff = abs(items_total - grand)
        if diff <= TOLERANCE_CENTS:
            return result(True, "no_taxes", grand)
        return fail("items_grand_mismatch", MSG_ITEMS_MISMATCH,
                    f"Items total ({_fmt(items_total)}) does not match grand total ({_fmt(grand)}) "
                    f"and no taxes present. Difference: {_fmt(diff)}.")

    items_vs_grand = abs(items_total - grand)
    calculated_subtotal = grand - charges_total
    items_vs_subtotal = abs(items_total - calculated_subtotal)
    if items_vs_grand <= TOLERANCE_CENTS:
        return result(True, "tax_inclusive", grand)
    if items_vs_subtotal <= TOLERANCE_CENTS and calculated_subtotal >= 0:
        return result(True, "tax_exclusive", calculated_subtotal)
    technical = (
        f"Items total ({_fmt(items_total)}) matches neither scenario:\n"
        f"• Tax-inclusive: Items should equal Grand Total ({_fmt(grand)}) - Diff: {_fmt(items_vs_grand)}\n"
        f"• Tax-exclusive: Items should equal Subtotal ({_fmt(calculated_subtotal)}) - Diff: {_fmt(items_vs_subtotal)}"
    )
    # The old UI showed this technical text verbatim (no friendly mapping existed).
    return fail("no_scenario_matches", technical, technical)
