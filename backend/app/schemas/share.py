from __future__ import annotations

from datetime import date, datetime
from typing import Annotated
from uuid import UUID

from pydantic import Field

from app.schemas.common import DecimalStr, InputModel, OutputModel


class ShareLinkCreate(InputModel):
    person_id: UUID | None = None  # null = whole-bill link
    expires_in_days: Annotated[int, Field(ge=1, le=365)] | None = None


class ShareLinkOut(OutputModel):
    id: UUID
    person_id: UUID | None
    created_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    last_viewed_at: datetime | None


class ShareLinkCreated(ShareLinkOut):
    token: str  # shown once; only its SHA-256 is stored
    path: str  # "/s/{token}" – the frontend route
    url: str | None  # PUBLIC_APP_URL + path when configured


class ShareLinkList(OutputModel):
    items: list[ShareLinkOut]


class PublicItem(OutputModel):
    name: str
    share_cents: int


class PublicPerson(OutputModel):
    name: str
    is_payer: bool
    items: list[PublicItem]
    items_cents: int  # bill currency
    adjustment_cents: int
    total_cents: int
    settle_total_cents: int | None  # settle currency
    settled: bool
    outstanding_cents: int  # effective currency


class PublicShareOut(OutputModel):
    title: str | None
    merchant: str | None
    bill_date: date | None
    currency: str
    settle_currency: str | None
    fx_rate: DecimalStr | None
    effective_currency: str
    grand_total_cents: int
    settle_grand_total_cents: int | None
    payer_name: str | None
    scope: str  # "person" | "bill"
    person: PublicPerson | None  # per-person link
    people: list[PublicPerson]  # whole-bill link (empty for per-person links)
