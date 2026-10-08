"""Anonymised real-receipt OCR fixtures (from the P4a model benchmark).

Each ``tests/fixtures/ocr/<name>.md`` is Azure DI ``prebuilt-layout`` markdown of a real
receipt with every identifying detail replaced by a placeholder (merchant, address, phone,
registration / invoice / transaction numbers, card digits, names, dates). The sibling
``<name>.expected.json`` is the hand-adjudicated extraction in the ``ReceiptExtraction``
schema, plus an optional ``_expect`` block (``tax_scenario``, ``warnings``) that the
validator result must match. Adjudicated item counts and minor-unit totals live in
``_expect`` too; coverage notes contain no private source text or identifiers.

* Offline (always): every expected extraction reconciles in the validator, and no fixture
  contains anything that looks like personal data.
* Live (opt-in, costs real money): ``RUN_LIVE_LLM=1`` runs the real primary model on each
  fixture and compares it with the expected values. conftest blanks ``OPENAI_API_KEY`` and
  fakes the model names, so the live test reads ``LIVE_OPENAI_API_KEY`` / ``LIVE_LLM_MODEL`` /
  ``LIVE_LLM_EFFORT`` or, failing those, the repo-root ``.env``::

      docker compose run --rm -e RUN_LIVE_LLM=1 -v "<repo>/.env:/app/.env:ro" test \\
          pytest tests/test_receipt_fixtures.py -k live
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import pytest

from app.config import DEFAULT_LLM_PRICES, Settings
from app.core.money import to_cents
from app.core.receipt_validation import infer_charge_kind
from app.schemas.extraction import ReceiptExtraction
from app.services.extraction import validate_extraction

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "ocr"
REPO_ROOT = Path(__file__).resolve().parents[2]
CASES = sorted(p.name.removesuffix(".md") for p in FIXTURES.glob("*.md")) if FIXTURES.is_dir() else []
TOLERANCE_CENTS = 5
LIVE = os.environ.get("RUN_LIVE_LLM") == "1"

# Patterns that must never appear in a committed fixture. Amounts ("1,234.50"), quantities
# and placeholder tokens ("<PHONE>") don't match these.
PLACEHOLDER_DATE = "2000-01-01"  # the only date allowed in a fixture (the schema wants YYYY-MM-DD)
PERSONAL_DATA = {
    "phone": re.compile(r"(?<![\d.,])(?!(?:19|20)\d\d-\d\d-\d\d\b)\+?\d(?:[ -]?\d){7,}(?![\d.,])"),
    "date": re.compile(rf"\b(?!{PLACEHOLDER_DATE}\b)(?:19|20)\d\d[-/.]\d{{1,2}}[-/.]\d{{1,2}}\b"
                       r"|\b\d{1,2}[-/.]\d{1,2}[-/.](?:19|20)?\d\d\b"),
    "card": re.compile(r"(?:[*xX#]{4,}[ -]?\d{3,4}\b)|\b(?:\d{4}[ -]){3}\d{4}\b"),
    "email": re.compile(r"[\w.+-]+@[\w-]+\.[A-Za-z]{2,}"),
    "url": re.compile(r"(?:https?://|www\.)\S+", re.I),
    "registration": re.compile(
        r"\b(?:GST|SST|ROC|UEN|BRN|TIN|SSM|Co\.?\s*Reg|Reg(?:istration)?\.?\s*No)\b[^\n]{0,25}?\d[\d-]{5,}", re.I),
    "street": re.compile(r"\b(?:jalan|jln|lorong|lrg|taman|persiaran|blk|block|road|street|avenue|ave)\b\.?\s+"
                         r"(?!<)[A-Za-z0-9]", re.I),
    "postcode": re.compile(r"\b(?:singapore|malaysia|kuala lumpur|selangor|penang|johor)\b\s*\d{5,6}\b", re.I),
}


def load_expected(name: str) -> tuple[ReceiptExtraction, dict[str, Any]]:
    data = json.loads((FIXTURES / f"{name}.expected.json").read_text("utf-8"))
    meta = data.pop("_expect", {})
    return ReceiptExtraction.model_validate(data), meta


def test_every_fixture_has_an_expected_extraction() -> None:
    assert CASES, "At least one adjudicated OCR fixture is required"
    texts = set(CASES)
    expected = {p.name.removesuffix(".expected.json") for p in FIXTURES.glob("*.expected.json")} \
        if FIXTURES.is_dir() else set()
    assert texts == expected


@pytest.mark.parametrize("name", CASES)
def test_expected_extraction_reconciles(name: str) -> None:
    extraction, meta = load_expected(name)
    result = validate_extraction(extraction)
    assert result.ok, [e.technical for e in result.errors]
    if "tax_scenario" in meta:
        assert result.tax_scenario == meta["tax_scenario"]
    if "warnings" in meta:
        assert len(result.warnings) == meta["warnings"], [w.message for w in result.warnings]
    if "items_count" in meta:
        assert len(extraction.items) == meta["items_count"]
    for field in ("items_total_cents", "charges_total_cents", "grand_total_cents"):
        if field in meta:
            assert getattr(result, field) == meta[field]


@pytest.mark.parametrize("name", CASES)
def test_expected_extraction_has_only_placeholder_identity(name: str) -> None:
    data = json.loads((FIXTURES / f"{name}.expected.json").read_text("utf-8"))
    assert data["receipt_number"] == "<RECEIPT>"
    assert data["date"] == PLACEHOLDER_DATE
    assert data["time"] == "00:00"
    assert data["store"] == {"name": "<MERCHANT>"}
    assert "transaction_id" not in data
    assert "card" not in data


def _assert_matches_expected(actual: ReceiptExtraction, expected: ReceiptExtraction, summary: str) -> None:
    want, got = validate_extraction(expected), validate_extraction(actual)
    assert got.ok, summary
    assert abs(got.grand_total_cents - want.grand_total_cents) <= TOLERANCE_CENTS, summary
    assert len(actual.items) == len(expected.items), "priced item count: " + summary
    assert abs(got.items_total_cents - want.items_total_cents) <= TOLERANCE_CENTS, summary
    want_items = [(item.name.strip().casefold(), item.quantity,
                   to_cents(item.unit_price), to_cents(item.total_price)) for item in expected.items]
    got_items = [(item.name.strip().casefold(), item.quantity,
                  to_cents(item.unit_price), to_cents(item.total_price)) for item in actual.items]
    assert got_items == want_items, "priced item lines: " + summary
    want_charges = sorted((infer_charge_kind(charge.name, to_cents(charge.amount)), to_cents(charge.amount))
                          for charge in expected.taxes_or_charges)
    got_charges = sorted((infer_charge_kind(charge.name, to_cents(charge.amount)), to_cents(charge.amount))
                         for charge in actual.taxes_or_charges)
    assert got_charges == want_charges, "charge lines: " + summary
    assert to_cents(actual.subtotal) == to_cents(expected.subtotal), "printed subtotal: " + summary
    assert got.tax_scenario == want.tax_scenario, "tax scenario: " + summary


@pytest.mark.parametrize(("name", "mistake", "message"), [
    ("bundle_extra_lines", "extra_line", "priced item count"),
    ("shifted_prices_tax_inclusive", "shifted_price", "priced item lines"),
    ("gst_service_quantities", "quantity", "priced item lines"),
    ("shifted_prices_tax_inclusive", "missing_tax", "charge lines"),
    ("service_positive_rounding", "missing_rounding", "charge lines"),
])
def test_matching_rejects_wrong_lines_even_when_totals_reconcile(name: str, mistake: str, message: str) -> None:
    expected, _ = load_expected(name)
    _assert_matches_expected(expected, expected, name)
    actual = expected.model_copy(deep=True)
    if mistake == "extra_line":
        actual.items.append(actual.items[0].model_copy(update={
            "name": "Unpriced bundle component", "unit_price": 0.0, "total_price": 0.0,
        }))
    elif mistake == "shifted_price":
        first, second = actual.items[3:5]
        first.unit_price, second.unit_price = second.unit_price, first.unit_price
        first.total_price, second.total_price = second.total_price, first.total_price
    elif mistake == "quantity":
        actual.items[0].quantity = 1
        actual.items[0].unit_price = actual.items[0].total_price
    elif mistake == "missing_tax":
        actual.taxes_or_charges.clear()
    elif mistake == "missing_rounding":
        actual.taxes_or_charges.pop()
    assert validate_extraction(actual).ok
    with pytest.raises(AssertionError, match=message):
        _assert_matches_expected(actual, expected, name)


@pytest.mark.parametrize("name", CASES)
def test_fixture_contains_no_personal_data(name: str) -> None:
    for path in (FIXTURES / f"{name}.md", FIXTURES / f"{name}.expected.json"):
        text = path.read_text("utf-8")
        hits = {label: rx.findall(text) for label, rx in PERSONAL_DATA.items() if rx.search(text)}
        assert not hits, f"{path.name}: {hits}"


# ----------------------------------------------------------------------------- live (opt-in)
def _live_config() -> tuple[str, str, str | None]:
    root_env: dict[str, str | None] = {}
    env_file = REPO_ROOT / ".env"
    if env_file.exists():
        from dotenv import dotenv_values

        root_env = dict(dotenv_values(env_file))
    fields = Settings.model_fields
    key = os.environ.get("LIVE_OPENAI_API_KEY") or root_env.get("OPENAI_API_KEY") or ""
    model = (os.environ.get("LIVE_LLM_MODEL") or root_env.get("LLM_PRIMARY_MODEL")
             or fields["llm_primary_model"].default)
    effort = (os.environ.get("LIVE_LLM_EFFORT") or root_env.get("LLM_PRIMARY_REASONING_EFFORT")
              or fields["llm_primary_reasoning_effort"].default)
    return key, model, effort or None


@pytest.mark.skipif(not LIVE, reason="live LLM test: set RUN_LIVE_LLM=1 (calls OpenAI, costs money)")
@pytest.mark.parametrize("name", CASES)
async def test_live_primary_model_matches_expected(name: str) -> None:
    from app.integrations.llm import OpenAIReceiptExtractor

    key, model, effort = _live_config()
    if not key:
        pytest.skip("no OpenAI key: set LIVE_OPENAI_API_KEY or mount the repo-root .env at /app/.env")
    fields = Settings.model_fields
    llm = OpenAIReceiptExtractor(key, timeout_seconds=fields["llm_timeout_seconds"].default,
                                 max_retries=fields["llm_max_retries"].default,
                                 max_output_tokens=fields["llm_max_output_tokens"].default,
                                 prices=DEFAULT_LLM_PRICES)
    try:
        call = await llm.extract_receipt((FIXTURES / f"{name}.md").read_text("utf-8"), model, effort)
    finally:
        await llm.aclose()
    assert call.ok and call.extraction is not None, call.error_code

    expected, _ = load_expected(name)
    want, got = validate_extraction(expected), validate_extraction(call.extraction)
    summary = (f"{model}/{effort}: total {got.grand_total_cents} vs {want.grand_total_cents}, "
               f"items {len(call.extraction.items)} vs {len(expected.items)}, "
               f"items sum {got.items_total_cents} vs {want.items_total_cents}, ok={got.ok}")
    _assert_matches_expected(call.extraction, expected, summary)
