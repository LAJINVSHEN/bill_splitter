from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal
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


class LinkScope(InputModel):
    person_id: UUID | None = None  # null = the group (whole-bill) link


class EnsureLinksIn(InputModel):
    scopes: Annotated[list[LinkScope], Field(min_length=1, max_length=51)]


class EnsuredLink(OutputModel):
    link_id: UUID
    person_id: UUID | None
    token: str  # derived, so it's the same every time for this link
    path: str
    url: str | None


class EnsuredLinks(OutputModel):
    items: list[EnsuredLink]


class PublicClaim(OutputModel):
    status: Literal["claimed", "confirmed", "rejected"]
    amount_cents: int  # effective currency
    created_at: datetime


class PublicClaimIn(InputModel):
    person_key: Annotated[str, Field(max_length=32)] | None = None  # group links: who is claiming
    client_key: UUID  # idempotency: the same tap retried never makes two claims


class PublicItem(OutputModel):
    name: str
    share_cents: int


class PublicPerson(OutputModel):
    key: str  # opaque per-link handle (never the person's id)
    name: str
    color_seed: int
    is_payer: bool
    items: list[PublicItem]
    items_cents: int  # bill currency
    adjustment_cents: int
    total_cents: int
    settle_total_cents: int | None  # settle currency
    settled: bool
    outstanding_cents: int  # effective currency
    effective_total_cents: int
    claim: PublicClaim | None  # their latest "I've paid", if any


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
    payer_payment_note: str | None  # the bill owner's note, only when the owner's "Me" paid
    scope: str  # "person" | "bill"
    host_name: str  # who keeps the bill (claims go to them)
    payer_is_host: bool
    claims_open: bool  # "I've paid" is possible (bill finished, someone still owes)
    itemised: bool  # false for a quick split (its one item is just "Total")
    person: PublicPerson | None  # per-person link
    people: list[PublicPerson]  # whole-bill link (empty for per-person links)
