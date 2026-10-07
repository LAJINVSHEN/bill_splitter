"""Extract → validate with model escalation (primary → fallback).

The fallback runs when the primary errors, times out, or its output can't be
reconciled by the validator. Every call is reported to ``on_call`` (usage logging)
before the next one starts.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from decimal import Decimal

from app.core.money import to_cents
from app.core.receipt_validation import ReceiptCharge, ReceiptItem, ValidationResult, validate_receipt
from app.integrations.llm import LlmCall, LlmClient
from app.schemas.extraction import ReceiptExtraction


def extraction_to_core(x: ReceiptExtraction) -> tuple[list[ReceiptItem], list[ReceiptCharge], int, int | None]:
    items = [ReceiptItem(name=i.name.strip() or "Item", quantity=Decimal(i.quantity if i.quantity > 0 else 1),
                         unit_price_cents=to_cents(i.unit_price), total_price_cents=to_cents(i.total_price))
             for i in x.items]
    charges = [ReceiptCharge(name=c.name.strip() or "Charge", amount_cents=to_cents(c.amount))
               for c in x.taxes_or_charges]
    subtotal = to_cents(x.subtotal) if x.subtotal else None
    return items, charges, max(to_cents(x.grand_total), 0), subtotal


def validate_extraction(x: ReceiptExtraction) -> ValidationResult:
    items, charges, grand, subtotal = extraction_to_core(x)
    return validate_receipt(items, charges, grand, subtotal)


@dataclass(frozen=True)
class ExtractionOutcome:
    extraction: ReceiptExtraction | None
    validation: ValidationResult | None
    model: str | None
    calls: list[LlmCall]

    @property
    def ok(self) -> bool:
        return self.validation is not None and self.validation.ok


async def extract_with_escalation(
    llm: LlmClient,
    text: str,
    models: list[tuple[str, str]],
    on_call: Callable[[LlmCall], Awaitable[None]],
    before_call: Callable[[str], Awaitable[None]] | None = None,
) -> ExtractionOutcome:
    """Try each (model, reasoning_effort) in order until one reconciles.

    If none reconciles, the last *parsed* extraction wins (it goes to needs_review);
    if nothing parsed at all, ``extraction`` is None.
    """
    calls: list[LlmCall] = []
    best: tuple[ReceiptExtraction, ValidationResult, str] | None = None
    for model, effort in models:
        if before_call is not None:
            await before_call(model)
        call = await llm.extract_receipt(text, model, effort or None)
        calls.append(call)
        await on_call(call)
        if not call.ok or call.extraction is None:
            continue
        validation = validate_extraction(call.extraction)
        best = (call.extraction, validation, call.model or model)
        if validation.ok:
            break
    if best is None:
        return ExtractionOutcome(None, None, None, calls)
    return ExtractionOutcome(best[0], best[1], best[2], calls)
