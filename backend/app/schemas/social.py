from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import Field, model_validator

from app.schemas.admin import Username
from app.schemas.common import CleanStr, Currency, InputModel, OutputModel


class AccountBrief(OutputModel):
    id: UUID
    name: str  # your name for them when they're in your people, else their display name
    username: str
    color_seed: int


# ---------------------------------------------------------------------------- friends
class FriendRequestIn(InputModel):
    # Exact email or user id ("@" optional). Or, for someone you already share a bill with, their account id.
    identifier: Annotated[CleanStr, Field(min_length=2, max_length=254)] | None = None
    account_id: UUID | None = None

    @model_validator(mode="after")
    def _one(self) -> FriendRequestIn:
        if (self.identifier is None) == (self.account_id is None):
            raise ValueError("send either identifier or account_id")
        return self


class FriendRequestSent(OutputModel):
    # "sent" whether or not an account matched (so nobody can probe who has one); "accepted" when
    # they had already asked you.
    status: Literal["sent", "accepted"]


class FriendOut(OutputModel):
    account: AccountBrief
    person_id: UUID | None  # your entry for them (their balances live there)
    since: datetime


class OutgoingRequest(OutputModel):
    id: UUID
    identifier: str  # what you typed: whether it matched an account is never shown
    created_at: datetime


class BlockedOut(OutputModel):
    account: AccountBrief
    at: datetime


class Suggestion(OutputModel):
    account: AccountBrief
    shared_bills: int


class FriendsOut(OutputModel):
    friends: list[FriendOut]
    outgoing: list[OutgoingRequest]
    blocked: list[BlockedOut]
    suggestions: list[Suggestion]  # people you share bills with: one tap to ask


# ---------------------------------------------------------------------------- placeholder links
class PersonLinkIn(InputModel):
    account_id: UUID  # one of your friends


# ---------------------------------------------------------------------------- mailbox
class MailRequest(OutputModel):
    """Something waiting on you. It stays until you answer it."""

    kind: Literal["friend_request", "link_invite", "payment_claim"]
    id: UUID
    created_at: datetime
    actor: AccountBrief | None = None  # who asked (a share-link claim has no account)
    person_id: UUID | None = None  # payment_claim: who says they paid (your entry)
    person_name: str | None = None  # link_invite: the placeholder's name; payment_claim: who paid
    color_seed: int | None = None
    bill_id: UUID | None = None
    bill_title: str | None = None
    bill_date: date | None = None
    bill_count: int | None = None  # link_invite: bills that come with it
    amount_cents: int | None = None
    currency: str | None = None
    expected_total_cents: int | None = None


class MailUpdate(OutputModel):
    id: UUID
    kind: str
    actor: AccountBrief | None
    bill_id: UUID | None
    bill_title: str | None
    count: int
    data: dict[str, Any]
    unread: bool
    at: datetime


class MailSent(OutputModel):
    kind: Literal["friend_request", "link_invite"]
    id: UUID
    label: str  # the identifier you typed, or the friend you invited
    person_name: str | None = None  # link_invite: your placeholder
    person_id: UUID | None = None  # link_invite: take it back with DELETE /people/{person_id}/link
    created_at: datetime


class MailboxOut(OutputModel):
    requests: list[MailRequest]
    updates: list[MailUpdate]
    sent: list[MailSent]
    unread_count: int


class MailReadIn(InputModel):
    ids: Annotated[list[UUID], Field(max_length=200)] | None = None  # omit = everything


# ---------------------------------------------------------------------------- groups
GroupName = Annotated[CleanStr, Field(min_length=1, max_length=60)]


class GroupIn(InputModel):
    name: GroupName
    person_ids: Annotated[list[UUID], Field(max_length=50)]

    @model_validator(mode="after")
    def _unique(self) -> GroupIn:
        if len(self.person_ids) != len(set(self.person_ids)):
            raise ValueError("person_ids must be unique")
        return self


class GroupPatch(InputModel):
    name: GroupName | None = None
    person_ids: Annotated[list[UUID], Field(max_length=50)] | None = None


class GroupOut(OutputModel):
    id: UUID
    name: str
    person_ids: list[UUID]
    created_at: datetime


class GroupList(OutputModel):
    items: list[GroupOut]


class SendPlanIn(InputModel):
    currency: Currency
    combine: Currency | None = None


class SendPlanOut(OutputModel):
    sent_to: int


# ---------------------------------------------------------------------------- access requests
class AccessRequestIn(InputModel):
    note: Annotated[CleanStr, Field(max_length=300)] | None = None


class AccessRequestOut(OutputModel):
    id: UUID
    email: str
    name: str | None
    note: str | None
    status: Literal["pending", "approved", "rejected"]
    created_at: datetime
    decided_at: datetime | None


class AccessRequestList(OutputModel):
    items: list[AccessRequestOut]


class AccessApproveIn(InputModel):
    username: Username
    display_name: Annotated[CleanStr, Field(min_length=1, max_length=60)] | None = None


# ---------------------------------------------------------------------------- live bill
class Viewer(OutputModel):
    name: str
    color_seed: int
    is_self: bool


class LiveOut(OutputModel):
    version: int
    updated_at: datetime
    updated_by: str | None  # display name of whoever saved last
    viewers: list[Viewer]  # who has the bill open right now (you included)
    bill: Any | None = None  # the full BillOut when it changed since ?version=
