from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

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
    self_person_id: UUID
    created_at: datetime


class MePatch(InputModel):
    display_name: Annotated[CleanStr, Field(min_length=1, max_length=60)] | None = None
    default_currency: Currency | None = None


PauseReason = Literal["scans_disabled", "user_quota", "global_page_cap", "llm_budget"]


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
