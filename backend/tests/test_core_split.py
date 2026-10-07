"""Pure split maths: worked examples, invariants, and the shared golden vectors."""

from __future__ import annotations

import json
import random
from decimal import Decimal
from pathlib import Path

import pytest

from app.core.money import allocate, format_cents, round_half_up, to_cents
from app.core.split import ItemInput, ShareInput, SplitInput, compute_split, quick_split_item

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "shared" / "split-vectors.json").read_text("utf-8"))


# ------------------------------------------------------------------------- money
@pytest.mark.parametrize(("amount", "cents"), [
    ("12.34", 1234), ("0.005", 1), ("-0.005", -1), ("2.675", 268), (2.675, 268), (0.1, 10), (19.999, 2000), (7, 700),
])
def test_to_cents_half_up(amount: object, cents: int) -> None:
    assert to_cents(amount) == cents  # type: ignore[arg-type]


def test_round_half_up_is_away_from_zero() -> None:
    assert round_half_up(Decimal("2.5")) == 3
    assert round_half_up(Decimal("-2.5")) == -3
    assert round_half_up(Decimal("2.4999")) == 2


def test_format_cents() -> None:
    assert format_cents(1234) == "12.34"
    assert format_cents(-5) == "-0.05"
    assert format_cents(0) == "0.00"


@pytest.mark.parametrize(("total", "weights", "expected"), [
    (1000, [1, 1, 1], [334, 333, 333]),          # 333.33 x3 = 999 → +1 to first (tie)
    (2000, [1, 1, 1], [666, 667, 667]),          # 666.67→667 x3 = 2001 → -1 to first
    (701, [100, 200, 300], [117, 234, 350]),     # 116.83→117, 233.67→234, 350.5→351 → -1 to C (largest)
    (1001, [500, 500], [500, 501]),              # 500.5→501 x2 → -1 to first
    (1200, [0, 0], [1200, 0]),                   # zero weights → all to first ("largest" tie)
    (0, [1, 2], [0, 0]),
    (-400, [1, 1], [-200, -200]),
    (-500, [1, 1, 1], [-166, -167, -167]),       # -166.67→-167 x3 = -501 → +1 to the largest (first, -167)
])
def test_allocate_worked_examples(total: int, weights: list[int], expected: list[int]) -> None:
    assert allocate(total, weights) == expected
    assert sum(allocate(total, weights)) == total


def test_allocate_property_sum_is_exact() -> None:
    rng = random.Random(42)
    for _ in range(2000):
        n = rng.randint(1, 12)
        weights = [Decimal(rng.randint(0, 5000)) / Decimal(rng.choice([1, 10, 100])) for _ in range(n)]
        total = rng.randint(-10_000, 10_000_000)
        shares = allocate(total, weights)
        assert sum(shares) == total
        assert len(shares) == n


# ------------------------------------------------------------------------- bill split
def _inp(participants: list[str], items: list[ItemInput], grand: int) -> SplitInput:
    return SplitInput(participants=tuple(participants), items=tuple(items), grand_total_cents=grand)


def test_worked_example_tax_exclusive_proportional() -> None:
    """A had 10.00, B 20.00; +10% service +9% GST = 35.97 → A 11.99, B 23.98 (exactly a third / two thirds)."""
    r = compute_split(_inp(["A", "B"], [
        ItemInput("i1", 1000, "single", (ShareInput("A"),)),
        ItemInput("i2", 2000, "single", (ShareInput("B"),)),
    ], 3597))
    assert [(p.person_id, p.items_cents, p.total_cents, p.adjustment_cents) for p in r.people] == [
        ("A", 1000, 1199, 199), ("B", 2000, 2398, 398)]
    assert r.is_complete


def test_worked_example_mixed_modes_with_discount() -> None:
    """Laksa 17.00 (A,B equal), tea 7.80 (A,B,C equal), CKT 9.80 C, wanton 6.00 D → items 40.60, grand 46.68."""
    r = compute_split(_inp(["A", "B", "C", "D"], [
        ItemInput("laksa", 1700, "equal", (ShareInput("A"), ShareInput("B"))),
        ItemInput("ckt", 980, "single", (ShareInput("C"),)),
        ItemInput("tea", 780, "equal", (ShareInput("A"), ShareInput("B"), ShareInput("C"))),
        ItemInput("wanton", 600, "single", (ShareInput("D"),)),
    ], 4668))
    items = {p.person_id: p.items_cents for p in r.people}
    assert items == {"A": 1110, "B": 1110, "C": 1240, "D": 600}
    # 4668 × 1110/4060 = 1276.21 → 1276; ×1240/4060 = 1425.69 → 1426; ×600/4060 = 689.85 → 690
    assert {p.person_id: p.total_cents for p in r.people} == {"A": 1276, "B": 1276, "C": 1426, "D": 690}
    assert sum(p.total_cents for p in r.people) == 4668


def test_custom_mismatch_is_reported_but_used() -> None:
    r = compute_split(_inp(["A", "B"], [
        ItemInput("i1", 3000, "custom", (ShareInput("A", amount_cents=1000), ShareInput("B", amount_cents=1500))),
    ], 3000))
    assert [i.code for i in r.issues] == ["custom_amounts_mismatch"]
    assert r.issues[0].expected_cents == 3000 and r.issues[0].actual_cents == 2500
    assert {p.person_id: p.total_cents for p in r.people} == {"A": 1200, "B": 1800}
    assert not r.is_complete


def test_unassigned_items_are_excluded_and_flagged() -> None:
    r = compute_split(_inp(["A", "B"], [
        ItemInput("i1", 1000, "single", (ShareInput("A"),)),
        ItemInput("i2", 500, None, ()),
    ], 1500))
    assert r.unassigned_item_ids == ("i2",)
    assert r.assigned_items_cents == 1000 and r.all_items_cents == 1500
    assert r.person("A").total_cents == 1500  # type: ignore[union-attr]


def test_quick_split_item_equal_and_shares() -> None:
    eq = compute_split(_inp(["A", "B", "C"], [quick_split_item(10000, ["A", "B", "C"])], 10000))
    assert [p.total_cents for p in eq.people] == [3334, 3333, 3333]
    sh = compute_split(_inp(["A", "B"], [quick_split_item(9000, ["A", "B"], [Decimal(2), Decimal(1)])], 9000))
    assert [p.total_cents for p in sh.people] == [6000, 3000]


def test_split_property_totals_always_sum_to_grand() -> None:
    rng = random.Random(7)
    people = ["A", "B", "C", "D", "E"]
    for _ in range(500):
        parts = rng.sample(people, rng.randint(1, 5))
        items = []
        for k in range(rng.randint(1, 8)):
            total = rng.randint(0, 20000)
            mode = rng.choice(["single", "equal", "weighted"])
            sharers = rng.sample(parts, rng.randint(1, len(parts)))
            shares = tuple(ShareInput(p, weight=Decimal(rng.randint(1, 5))) for p in sharers)
            items.append(ItemInput(f"i{k}", total, mode, shares[:1] if mode == "single" else shares))
        grand = rng.randint(0, 50000)
        r = compute_split(_inp(parts, items, grand))
        assert sum(p.total_cents for p in r.people) == grand
        for item in items:
            assert sum(r.item_allocations[item.id].values()) == item.total_cents


# ------------------------------------------------------------------------- golden vectors
def _vector_input(case: dict) -> SplitInput:
    inp = case["input"]
    items = tuple(
        ItemInput(id=i["id"], name=i["name"], total_cents=i["total_cents"], mode=i["mode"],
                  shares=tuple(ShareInput(person_id=s["person"],
                                          weight=Decimal(s["weight"]) if "weight" in s else None,
                                          amount_cents=s.get("amount_cents")) for s in i["shares"]))
        for i in inp["items"])
    return SplitInput(participants=tuple(inp["participants"]), items=items, grand_total_cents=inp["grand_total_cents"])


def test_vectors_file_is_substantial() -> None:
    assert VECTORS["version"] == 1
    assert len(VECTORS["split_cases"]) >= 25
    tags = {t for c in VECTORS["split_cases"] for t in c["tags"]}
    assert {"single", "multi-equal", "multi-custom", "multi-percentage", "tax-exclusive", "tax-inclusive",
            "discount", "rounding", "zero-subtotal", "quick-split"} <= tags


@pytest.mark.parametrize("case", VECTORS["split_cases"], ids=lambda c: c["id"])
def test_golden_split_vector(case: dict) -> None:
    r = compute_split(_vector_input(case))
    exp = case["expected"]
    assert {p.person_id: p.items_cents for p in r.people} == exp["items_cents"]
    assert {p.person_id: p.total_cents for p in r.people} == exp["totals_cents"]
    assert r.item_allocations == exp["item_allocations"]
    assert list(r.unassigned_item_ids) == exp["unassigned_item_ids"]
    assert sorted({i.code for i in r.issues}) == exp["issue_codes"]
    assert r.is_complete == exp["is_complete"]
