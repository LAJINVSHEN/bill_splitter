from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import Field, model_validator

from app.schemas.common import (
    MAX_ITEM_CENTS,
    CleanStr,
    Currency,
    DecimalStr,
    InputModel,
    NonNegCents,
    OutputModel,
    Rate,
)

BillStatus = Literal["draft", "scanning", "review", "assigning", "complete"]
ClientBillStatus = Literal["draft", "review", "assigning", "complete"]  # "scanning" is server-only
BillSource = Literal["scan", "manual", "quick"]
SplitMode = Literal["single", "equal", "weighted", "custom"]
ChargeKind = Literal["tax", "service", "discount", "rounding", "other"]
TaxScenario = Literal["tax_exclusive", "tax_inclusive", "no_taxes"]

Title = Annotated[CleanStr, Field(max_length=120)]
ItemCents = Annotated[int, Field(ge=-MAX_ITEM_CENTS, le=MAX_ITEM_CENTS)]
Quantity = Annotated[Decimal, Field(gt=0, le=Decimal(100000), max_digits=12, decimal_places=3)]
Weight = Annotated[Decimal, Field(ge=0, le=Decimal(1_000_000), max_digits=12, decimal_places=4)]


# --------------------------------------------------------------------------- inputs
class BillCreate(InputModel):
    title: Title | None = None
    merchant: Title | None = None
    bill_date: date | None = None
    currency: Currency | None = None  # default: the user's default currency
    source: BillSource = "manual"


class BillPatch(InputModel):
    title: Title | None = None
    merchant: Title | None = None
    bill_date: date | None = None
    # Relabels the amounts (same major-unit values, rescaled minor units if the exponent differs)
    # and clears any conversion unless one is given in the same request.
    currency: Currency | None = None
    status: ClientBillStatus | None = None
    payer_person_id: UUID | None = None
    # Conversion snapshot: 1 unit of the bill currency = fx_rate units of settle_currency.
    # settle_currency without fx_rate copies the user's saved rate; null clears the conversion.
    settle_currency: Currency | None = None
    fx_rate: Rate | None = None
    save_rate: bool = False  # also store the rate in /me/fx-rates


class ItemIn(InputModel):
    id: UUID | None = None  # keep an existing item (and its assignment); omit for a new one
    name: Annotated[CleanStr, Field(min_length=1, max_length=200)]
    quantity: Quantity = Decimal(1)
    unit_price_cents: ItemCents
    total_price_cents: ItemCents


class ChargeIn(InputModel):
    name: Annotated[CleanStr, Field(min_length=1, max_length=120)]
    amount_cents: ItemCents
    kind: ChargeKind | None = None  # inferred from the name when omitted


class ReceiptIn(InputModel):
    items: Annotated[list[ItemIn], Field(max_length=200)]
    charges: Annotated[list[ChargeIn], Field(max_length=30)] = []
    subtotal_cents: NonNegCents | None = None  # as printed on the receipt; null/0 = not shown
    grand_total_cents: NonNegCents
    merchant: Title | None = None
    bill_date: date | None = None

    @model_validator(mode="after")
    def _unique_ids(self) -> ReceiptIn:
        ids = [i.id for i in self.items if i.id is not None]
        if len(ids) != len(set(ids)):
            raise ValueError("item ids must be unique")
        return self


class ParticipantsIn(InputModel):
    person_ids: Annotated[list[UUID], Field(max_length=50)]

    @model_validator(mode="after")
    def _unique(self) -> ParticipantsIn:
        if len(self.person_ids) != len(set(self.person_ids)):
            raise ValueError("person_ids must be unique")
        return self


class ShareIn(InputModel):
    person_id: UUID
    weight: Weight | None = None
    amount_cents: ItemCents | None = None


class AssignmentIn(InputModel):
    item_id: UUID
    mode: SplitMode | None = None  # null = unassign
    shares: Annotated[list[ShareIn], Field(max_length=50)] = []

    @model_validator(mode="after")
    def _check(self) -> AssignmentIn:
        people = [s.person_id for s in self.shares]
        if len(people) != len(set(people)):
            raise ValueError("a person can appear only once per item")
        if self.mode is None:
            if self.shares:
                raise ValueError("shares must be empty when mode is null")
        elif not self.shares:
            raise ValueError("at least one share is required")
        elif self.mode == "single" and len(self.shares) != 1:
            raise ValueError("single mode takes exactly one share")
        elif self.mode == "weighted":
            if any(s.weight is None for s in self.shares):
                raise ValueError("weighted mode needs a weight for every share")
            if sum((s.weight or Decimal(0)) for s in self.shares) <= 0:
                raise ValueError("weights must add up to more than zero")
        elif self.mode == "custom" and any(s.amount_cents is None for s in self.shares):
            raise ValueError("custom mode needs amount_cents for every share")
        return self


class AssignmentsIn(InputModel):
    assignments: Annotated[list[AssignmentIn], Field(max_length=200)]

    @model_validator(mode="after")
    def _unique(self) -> AssignmentsIn:
        ids = [a.item_id for a in self.assignments]
        if len(ids) != len(set(ids)):
            raise ValueError("each item may appear once")
        return self


class QuickParticipantIn(InputModel):
    person_id: UUID
    weight: Weight | None = None


class QuickSplitIn(InputModel):
    total_cents: Annotated[int, Field(gt=0, le=MAX_ITEM_CENTS)]
    mode: Literal["equal", "shares"] = "equal"
    participants: Annotated[list[QuickParticipantIn], Field(min_length=1, max_length=50)]
    title: Title | None = None

    @model_validator(mode="after")
    def _check(self) -> QuickSplitIn:
        ids = [p.person_id for p in self.participants]
        if len(ids) != len(set(ids)):
            raise ValueError("participants must be unique")
        if self.mode == "shares":
            if any(p.weight is None for p in self.participants):
                raise ValueError("shares mode needs a weight per person")
            if sum((p.weight or Decimal(0)) for p in self.participants) <= 0:
                raise ValueError("weights must add up to more than zero")
        return self


class SettlementIn(InputModel):
    amount_cents: NonNegCents | None = None  # default: everything they currently owe


# --------------------------------------------------------------------------- outputs
class ShareOut(OutputModel):
    person_id: UUID
    weight: DecimalStr | None
    amount_cents: int | None


class ItemOut(OutputModel):
    id: UUID
    position: int
    name: str
    quantity: DecimalStr
    unit_price_cents: int
    total_price_cents: int
    split_mode: SplitMode | None
    shares: list[ShareOut]


class ChargeOut(OutputModel):
    id: UUID
    position: int
    name: str
    kind: ChargeKind
    amount_cents: int
    percent: DecimalStr | None


class ParticipantOut(OutputModel):
    person_id: UUID
    name: str
    color_seed: int
    is_self: bool
    position: int
    settled_at: datetime | None
    settled_amount_cents: int | None


class ValidationErrorOut(OutputModel):
    code: str
    message: str
    technical: str


class ValidationWarningOut(OutputModel):
    code: str
    item_index: int
    item_id: UUID | None = None
    message: str
    expected_cents: int
    actual_cents: int


class ValidationOut(OutputModel):
    ok: bool
    tax_scenario: TaxScenario | None
    items_total_cents: int
    charges_total_cents: int
    grand_total_cents: int
    provided_subtotal_cents: int | None
    final_subtotal_cents: int | None
    message: str | None
    errors: list[ValidationErrorOut]
    warnings: list[ValidationWarningOut]


class SplitItemShareOut(OutputModel):
    item_id: UUID
    name: str
    share_cents: int


class SplitPersonOut(OutputModel):
    person_id: UUID
    name: str
    color_seed: int
    is_self: bool
    is_payer: bool
    items_cents: int  # bill currency
    adjustment_cents: int  # their share of tax / service / discounts / rounding (bill currency)
    total_cents: int  # bill currency
    settle_total_cents: int | None  # settle currency (null without a conversion)
    effective_total_cents: int  # what they owe, in effective_currency
    items: list[SplitItemShareOut]
    settled_at: datetime | None
    settled_amount_cents: int | None  # effective currency
    outstanding_cents: int  # still owed to the payer, effective currency (0 for the payer)


class SplitIssueOut(OutputModel):
    code: str
    message: str
    item_id: UUID | None = None
    person_id: UUID | None = None
    expected_cents: int | None = None
    actual_cents: int | None = None


class SplitOut(OutputModel):
    currency: str  # bill currency: grand_total_cents, items, total_cents
    settle_currency: str | None
    fx_rate: DecimalStr | None  # 1 currency = fx_rate settle_currency
    effective_currency: str  # settle_currency if set, else currency (settlements, outstanding)
    grand_total_cents: int
    settle_grand_total_cents: int | None
    all_items_cents: int
    assigned_items_cents: int
    payer_person_id: UUID | None
    people: list[SplitPersonOut]
    unassigned_item_ids: list[UUID]
    issues: list[SplitIssueOut]
    is_complete: bool
    outstanding_total_cents: int  # effective currency


class JobBrief(OutputModel):
    id: UUID
    status: str
    error_code: str | None
    retryable: bool
    detected_currency: str | None  # receipt currency when it differs from the bill's


class FileOut(OutputModel):
    id: UUID
    job_id: UUID | None
    mime: str
    bytes: int
    pages: int | None
    position: int
    created_at: datetime
    expires_at: datetime
    available: bool


class BillSummaryOut(OutputModel):
    id: UUID
    title: str | None
    merchant: str | None
    bill_date: date | None
    currency: str
    status: BillStatus
    source: BillSource
    grand_total_cents: int | None
    settle_currency: str | None
    participant_count: int
    unsettled_count: int
    created_at: datetime
    updated_at: datetime


class BillOut(OutputModel):
    id: UUID
    title: str | None
    merchant: str | None
    bill_date: date | None
    currency: str
    status: BillStatus
    source: BillSource
    payer_person_id: UUID | None
    subtotal_cents: int | None
    grand_total_cents: int | None
    tax_scenario: TaxScenario | None
    settle_currency: str | None
    fx_rate: DecimalStr | None
    effective_currency: str
    currency_locked: bool  # true once anyone has settled: currency/conversion can't change
    receipt_meta: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    items: list[ItemOut]
    charges: list[ChargeOut]
    participants: list[ParticipantOut]
    validation: ValidationOut | None
    split: SplitOut
    latest_job: JobBrief | None
    files: list[FileOut]
