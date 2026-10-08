"""Unpriced component/modifier lines fold into their priced item (owner report 2026-10-08:
bundle components showed up as separate 1× items to assign)."""

from __future__ import annotations

from decimal import Decimal

from app.core.item_folding import MAX_DETAILS_LEN, fold_unpriced_items
from app.core.receipt_validation import ReceiptItem
from app.services.extraction import extraction_to_core, validate_extraction
from tests.conftest import make_extraction


def item(name: str, cents: int, qty: int = 1) -> ReceiptItem:
    return ReceiptItem(name, Decimal(qty), cents // qty if qty else cents, cents)


def summary(items: list[ReceiptItem]) -> list[tuple[str, int, str | None]]:
    return [(i.name, i.total_price_cents, i.details) for i in items]


def test_bundle_receipt_folds_to_priced_lines() -> None:
    # Line order as the model returns it for a fast-food bundle receipt.
    raw = [item("4pc Chicken", 0), item("Extra Spicy", 0), item("4pc Bundle", 2190),
           item("2pc Tenders", 0), item("Mustard Dip", 0), item("Mashed Potatoes (Reg)", 0, qty=2),
           item("Large Drink", 60), item("Reg Drink", 0), item("No Add Ons", 0)]
    assert summary(fold_unpriced_items(raw)) == [
        ("4pc Bundle", 2190, "4pc Chicken, Extra Spicy, 2pc Tenders, Mustard Dip, Mashed Potatoes (Reg) ×2"),
        ("Large Drink", 60, "Reg Drink, No Add Ons"),
    ]


def test_model_annotations_and_duplicates_read_once() -> None:
    raw = [item("Set A", 1290), item("Fries", 0), item("Fries (included)", 0), item("Cola (bundle item)", 0)]
    assert summary(fold_unpriced_items(raw)) == [("Set A", 1290, "Fries, Cola")]


def test_nothing_to_fold_or_nothing_priced_is_unchanged() -> None:
    priced = [item("Laksa", 850), item("Tea", 260)]
    assert fold_unpriced_items(priced) == priced
    free = [item("Free water", 0), item("Napkins", 0)]
    assert fold_unpriced_items(free) == free


def test_negative_lines_are_not_folded() -> None:
    raw = [item("Pizza", 2000), item("Member discount", -200), item("Extra cheese", 0)]
    assert summary(fold_unpriced_items(raw)) == [
        ("Pizza", 2000, None), ("Member discount", -200, "Extra cheese")]


def test_details_are_capped() -> None:
    raw = [item("Platter", 5000)] + [item(f"Component number {n}", 0) for n in range(60)]
    (only,) = fold_unpriced_items(raw)
    assert only.details is not None and len(only.details) <= MAX_DETAILS_LEN and only.details.endswith("…")


def test_extraction_folds_without_changing_validation() -> None:
    x = make_extraction([("Bundle", 1, 21.9, 21.9), ("2pc Tenders", 1, 0.0, 0.0), ("Upsize", 1, 0.6, 0.6),
                         ("No Add Ons", 1, 0.0, 0.0)], subtotal=22.5, grand=22.5)
    items, _, grand, subtotal = extraction_to_core(x)
    assert summary(items) == [("Bundle", 2190, "2pc Tenders"), ("Upsize", 60, "No Add Ons")]
    assert (grand, subtotal) == (2250, 2250)
    result = validate_extraction(x)
    assert result.ok and result.tax_scenario == "tax_exclusive" and result.items_total_cents == 2250
