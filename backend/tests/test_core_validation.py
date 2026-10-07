"""Receipt validation (same meaning as the original receipt_validator.py) + pricing + periods + OCR join."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from app.config import DEFAULT_LLM_PRICES
from app.core.ocr_text import join_pages, split_pages
from app.core.periods import current_month_bounds, month_bounds, month_key
from app.core.pricing import Price, cost_micros, estimate_cost_micros, resolve_price
from app.core.receipt_validation import (
    MSG_GRAND_MISMATCH,
    MSG_GRAND_MISSING,
    MSG_ITEMS_MISMATCH,
    ReceiptCharge,
    ReceiptItem,
    infer_charge_kind,
    validate_receipt,
)

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "shared" / "split-vectors.json").read_text("utf-8"))


def item(name: str, qty: str, unit: int, total: int) -> ReceiptItem:
    return ReceiptItem(name, Decimal(qty), unit, total)


def test_tax_exclusive_with_subtotal_and_percentages() -> None:
    r = validate_receipt([item("A", "2", 850, 1700), item("B", "1", 980, 980)],
                         [ReceiptCharge("Service 10%", 268), ReceiptCharge("GST 9%", 265)], 3213, 2680)
    assert r.ok and r.tax_scenario == "tax_exclusive"
    assert r.final_subtotal_cents == 2680
    assert r.charge_percents == (Decimal("10.00"), Decimal("9.89"))


def test_tax_inclusive_percent_uses_base_without_tax() -> None:
    # Items 32.70 == grand; GST 2.70 included → base 30.00 → 9.00%
    r = validate_receipt([item("A", "1", 2180, 2180), item("B", "1", 1090, 1090)], [ReceiptCharge("GST", 270)], 3270)
    assert r.ok and r.tax_scenario == "tax_inclusive" and r.final_subtotal_cents == 3270
    assert r.charge_percents == (Decimal("9.00"),)


def test_tolerance_is_five_cents() -> None:
    assert validate_receipt([item("A", "1", 1005, 1005)], [], 1000).ok
    bad = validate_receipt([item("A", "1", 1006, 1006)], [], 1000)
    assert not bad.ok and bad.errors[0].code == "items_grand_mismatch"


def test_user_friendly_messages_match_old_mapping() -> None:
    r = validate_receipt([item("A", "1", 1000, 1000)], [ReceiptCharge("GST", 135)], 1735, 1600)
    assert r.errors[0].message == MSG_ITEMS_MISMATCH
    assert r.errors[0].technical == ("Items total (10.00) does not match provided subtotal (16.00). "
                                     "Difference: 6.00.")
    r = validate_receipt([item("A", "1", 1000, 1000)], [ReceiptCharge("GST", 90)], 1200, 1000)
    assert r.errors[0].message == MSG_GRAND_MISMATCH
    assert "Grand total validation failed. Expected: 10.90" in r.errors[0].technical
    r = validate_receipt([item("A", "1", 1000, 1000)], [], 0)
    assert r.errors[0].message == MSG_GRAND_MISSING
    r = validate_receipt([item("A", "1", 1000, 1000)], [ReceiptCharge("GST", 90)], 1500)
    assert r.errors[0].code == "no_scenario_matches" and r.errors[0].message.startswith("Items total (10.00) matches")


def test_item_math_is_a_warning_not_an_error() -> None:
    r = validate_receipt([item("A", "3", 400, 1000), item("B", "1", 500, 500)], [], 1500)
    assert r.ok
    assert [(w.item_index, w.expected_cents, w.actual_cents) for w in r.warnings] == [(0, 1200, 1000)]


@pytest.mark.parametrize(("name", "amount", "kind"), [
    ("GST 9%", 100, "tax"), ("SST", 50, "tax"), ("VAT incl", 10, "tax"), ("Service Charge 10%", 300, "service"),
    ("Member Discount", -200, "discount"), ("10% off", -100, "discount"), ("Rounding", -2, "rounding"),
    ("Coffee", 0, "other"), ("Takeaway box", 50, "other"),
])
def test_infer_charge_kind(name: str, amount: int, kind: str) -> None:
    assert infer_charge_kind(name, amount) == kind


@pytest.mark.parametrize("case", VECTORS["validation_cases"], ids=lambda c: c["id"])
def test_golden_validation_vector(case: dict) -> None:
    i = case["input"]
    r = validate_receipt([item(x["name"], x["quantity"], x["unit_price_cents"], x["total_price_cents"])
                          for x in i["items"]],
                         [ReceiptCharge(c["name"], c["amount_cents"]) for c in i["charges"]],
                         i["grand_total_cents"], i["subtotal_cents"])
    e = case["expected"]
    assert r.ok == e["ok"]
    assert r.tax_scenario == e["tax_scenario"]
    assert r.items_total_cents == e["items_total_cents"]
    assert r.charges_total_cents == e["charges_total_cents"]
    assert r.final_subtotal_cents == e["final_subtotal_cents"]
    assert [x.code for x in r.errors] == e["error_codes"]
    assert [w.item_index for w in r.warnings] == e["warning_item_indexes"]
    assert [None if p is None else f"{p:.2f}" for p in r.charge_percents] == e["charge_percents"]


# ------------------------------------------------------------------------- pricing
def test_cost_micros_worked_example() -> None:
    # gpt-6-luna: $0.10 in / $0.01 cached / $0.50 out per 1M → 782 in, 318 out = 78.2 + 159 = 237.2 → 237 µ$
    price = DEFAULT_LLM_PRICES["gpt-6-luna"]
    assert cost_micros(782, 318, price) == 237
    # 1000 cached of 1782 input: 782×0.10 + 1000×0.01 + 318×0.50 = 78.2 + 10 + 159 = 247.2 → 247
    assert cost_micros(1782, 318, price, cached_input_tokens=1000) == 247


def test_resolve_price_handles_snapshots_and_unknown_models() -> None:
    table = {"gpt-x": Price(Decimal("1"), Decimal("2")), "gpt-x-mini": Price(Decimal("0.1"), Decimal("0.2"))}
    assert resolve_price("gpt-x-mini-2026-03-17", table) is table["gpt-x-mini"]
    assert resolve_price("gpt-x-2026-01-01", table) is table["gpt-x"]
    cost, known = estimate_cost_micros("mystery-model", 1000, 1000, table)
    assert not known and cost == 3000  # priced at the most expensive entry (conservative)


# ------------------------------------------------------------------------- periods
def test_month_bounds_in_singapore() -> None:
    start, end = month_bounds("2026-10", "Asia/Singapore")
    assert start == datetime(2026, 9, 30, 16, 0, tzinfo=UTC)
    assert end == datetime(2026, 10, 31, 16, 0, tzinfo=UTC)
    start, end = month_bounds("2026-12", "Asia/Singapore")
    assert end == datetime(2026, 12, 31, 16, 0, tzinfo=UTC)


def test_month_key_uses_local_time() -> None:
    # 2026-09-30 17:00 UTC is already 1 October in Singapore.
    assert month_key(datetime(2026, 9, 30, 17, 0, tzinfo=UTC), "Asia/Singapore") == "2026-10"
    key, start, _ = current_month_bounds(datetime(2026, 9, 30, 15, 59, tzinfo=UTC), "Asia/Singapore")
    assert key == "2026-09" and start == datetime(2026, 8, 31, 16, 0, tzinfo=UTC)


# ------------------------------------------------------------------------- OCR join
def test_join_pages_marks_every_page() -> None:
    assert join_pages(["only page"]) == "only page"
    joined = join_pages(["photo one", "pdf p1\n<!-- PageBreak -->\npdf p2"])
    assert joined == "--- Page 1 of 3 ---\nphoto one\n\n--- Page 2 of 3 ---\npdf p1\n\n--- Page 3 of 3 ---\npdf p2"
    assert split_pages("") == [""]
    assert join_pages(["", "  "]) == ""
