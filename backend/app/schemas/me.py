from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, Field

from app.schemas.common import CleanStr, Currency, DecimalStr, InputModel, OutputModel, Rate


class MeOut(OutputModel):
    id: UUID
    username: str
    display_name: str
    email: str | None
    role: Literal["admin", "member"]
    must_change_password: bool
    monthly_scan_quota: int
    default_currency: str
    payment_note: str | None  # e.g. "PayNow 9123 4567"; shown on share links when this user paid
    self_person_id: UUID
    created_at: datetime
    open_claims_count: int  # friends' "I've paid" waiting for a Confirm


def _blank_to_none(v: str | None) -> str | None:
    return v or None


class MePatch(InputModel):
    display_name: Annotated[CleanStr, Field(min_length=1, max_length=60)] | None = None
    default_currency: Currency | None = None
    # Trimmed; "" or null clears it.
    payment_note: Annotated[str | None, Field(max_length=200), AfterValidator(_blank_to_none)] = None


PauseReason = Literal["scans_disabled", "provider_quota", "user_quota", "global_page_cap", "llm_budget"]


class UsageOut(OutputModel):
    month: str
    timezone: str
    pages_used: int
    pages_quota: int
    pages_remaining: int
    llm_calls: int
    cost_micros: int
    scans_paused: bool
    pause_reason: PauseReason | None


class CurrencyBalance(OutputModel):
    currency: str
    owed_to_me_cents: int
    i_owe_cents: int


class PersonBalance(OutputModel):
    person_id: UUID
    name: str
    currency: str
    they_owe_me_cents: int
    i_owe_them_cents: int
    bill_count: int


class OutstandingBill(OutputModel):
    bill_id: UUID
    title: str | None
    bill_date: str | None
    currency: str
    owed_to_me_cents: int
    i_owe_cents: int
    unsettled_people: int


class SummaryOut(OutputModel):
    home: CurrencyBalance  # only bills whose effective currency is the user's default currency
    currencies: list[CurrencyBalance]  # every effective currency, never converted into each other
    people: list[PersonBalance]
    bills: list[OutstandingBill]


class FxRateIn(InputModel):
    rate: Rate  # 1 base = rate quote


class FxRateOut(OutputModel):
    base: str
    quote: str
    rate: DecimalStr
    derived: bool  # true when computed as 1 / (stored quote→base rate)
    updated_at: datetime


class FxRateList(OutputModel):
    items: list[FxRateOut]


class InboxClaim(OutputModel):
    id: UUID
    bill_id: UUID
    bill_title: str
    bill_date: date | None
    person_id: UUID
    person_name: str
    color_seed: int
    amount_cents: int
    currency: str
    expected_total_cents: int
    created_at: datetime


class InboxOut(OutputModel):
    items: list[InboxClaim]


class SettlePerson(OutputModel):
    person_id: UUID
    name: str
    color_seed: int
    is_self: bool


class SettlePayment(OutputModel):
    from_person: SettlePerson
    to_person: SettlePerson
    amount_cents: int  # the group's currency
    bill_count: int  # bills this payment closes (or chips at)


class SettleDebt(OutputModel):
    """One open bill debt behind the plan (for the per-person breakdown)."""

    bill_id: UUID
    title: str | None
    bill_date: date | None
    from_person: SettlePerson
    to_person: SettlePerson  # the bill's payer
    amount_cents: int  # the group's currency
    currency: str  # the bill's own (effective) currency
    original_cents: int  # in ``currency``; equals amount_cents unless currencies were merged


class SettleGroup(OutputModel):
    currency: str
    original: list[SettlePayment]  # who owes whom, as the bills say (one row per pair)
    simplified: list[SettlePayment]  # fewest payments, same net balances
    cancel_out: list[SettlePerson]  # people whose debts cancel in a loop: clear them, no money moves
    debts: list[SettleDebt]  # every open bill debt in this group, newest bill first


class SettlePiece(OutputModel):
    """Part of one bill debt that a recorded row marked paid (bill's own currency)."""

    bill_id: UUID
    person_id: UUID
    amount_cents: int


class SettleUpOut(OutputModel):
    combined_into: str | None  # set when every currency was merged into it with saved rates
    currencies: list[str]  # effective currencies with open debts
    missing_rates: list[str]  # asked to merge, but no saved rate from these into the target
    groups: list[SettleGroup]
    applied: list[SettlePiece] = []  # after recording a row: what it marked paid (send back to undo)


class SettlePieceIn(InputModel):
    bill_id: UUID
    person_id: UUID
    amount_cents: Annotated[int, Field(gt=0)]


class SettleUndoIn(InputModel):
    """Take back a recorded row: subtract exactly what it marked paid."""

    combine: Currency | None = None
    pieces: Annotated[list[SettlePieceIn], Field(min_length=1, max_length=500)]


class SettleRecordIn(InputModel):
    """Record one row of the plan as paid. The server recomputes the plan and refuses (409
    ``plan_changed``) unless the row still matches, so a stale screen can't settle the wrong debts."""

    view: Literal["original", "simplified", "cancel_out"]
    combine: Currency | None = None  # the merge target the plan was computed with
    currency: Currency  # the group's currency
    from_person_id: UUID | None = None  # null for cancel_out
    to_person_id: UUID | None = None
    amount_cents: int | None = None
