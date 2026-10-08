"""The OpenAI structured-output schema – kept exactly as in the original
``openai_service.py`` (the owner confirmed it works), plus one optional field:
``currency`` (P1b multi-currency)."""

from __future__ import annotations

from typing import List, Optional  # noqa: UP035 - kept verbatim from the original schema

from pydantic import BaseModel, Field


class StoreInfo(BaseModel):
    name: str
    address: Optional[str] = None  # noqa: UP045
    phone: Optional[str] = None  # noqa: UP045


class BillItem(BaseModel):
    name: str
    quantity: int = 1
    unit_price: float
    total_price: float


class TaxOrCharge(BaseModel):
    name: str
    amount: float


class ReceiptExtraction(BaseModel):
    """Schema for OpenAI structured extraction."""
    receipt_number: str = Field(description="Receipt/order number, generate 'RCP-001' if missing")
    date: str = Field(description="Date in YYYY-MM-DD format")
    time: str = Field(description="Time in HH:MM format")
    store: StoreInfo
    items: List[BillItem]  # noqa: UP006
    subtotal: float = Field(description="Subtotal before taxes, use 0.00 if not shown")
    taxes_or_charges: List[TaxOrCharge] = Field(  # noqa: UP006
        description="All taxes, charges, discounts (negative for discounts)"
    )
    grand_total: float = Field(description="Final total amount - MANDATORY")
    payment_method: str = "Unknown"
    transaction_id: Optional[str] = None  # noqa: UP045
    notes: Optional[str] = None  # noqa: UP045
    currency: Optional[str] = Field(  # noqa: UP045
        default=None,
        description="ISO 4217 code only if printed or clearly implied by symbols or the address, else null",
    )
