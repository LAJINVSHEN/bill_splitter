"""Accounts talking to each other: friendships, placeholder→account links, the Mailbox,
account requests, personal groups and the shared-bill edit log."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    SmallInteger,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, updated_at_col, uuid_pk

FRIENDSHIP_STATUSES = ("pending", "accepted", "declined", "cancelled", "ended", "blocked")
LINK_STATUSES = ("pending", "accepted", "declined", "cancelled")
ACCESS_STATUSES = ("pending", "approved", "rejected")
MAILBOX_KINDS = ("friend_accepted", "friend_declined", "link_accepted", "link_declined", "bill_added",
                 "bill_edited", "claim_confirmed", "claim_rejected", "plan_sent")
EDIT_KINDS = ("created", "details", "receipt", "shares", "people", "quick", "currency", "status", "settlement",
              "scan")


class Friendship(Base):
    """One row per request. ``addressee_id`` is NULL when the identifier matched no searchable
    account: the sender sees the same "sent" either way, and nothing is ever delivered."""

    __tablename__ = "friendships"

    id: Mapped[uuid.UUID] = uuid_pk()
    requester_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    addressee_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    identifier: Mapped[str] = mapped_column(Text, nullable=False)  # what the sender typed (lower-case)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    blocked_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created_at_col()
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(f"status IN {FRIENDSHIP_STATUSES}", name="status"),
        CheckConstraint("addressee_id IS NULL OR addressee_id <> requester_id", name="not_self"),
        # One live relationship per pair of accounts, whoever asked.
        Index("uq_friendships_live_pair", text("LEAST(requester_id, addressee_id)"),
              text("GREATEST(requester_id, addressee_id)"), unique=True,
              postgresql_where=text("addressee_id IS NOT NULL AND status IN ('pending', 'accepted', 'blocked')")),
        Index("uq_friendships_open_identifier", "requester_id", "identifier", unique=True,
              postgresql_where=text("status = 'pending'")),
        Index("ix_friendships_addressee_id", "addressee_id"),
    )


class PersonLink(Base):
    """An invite to take over a placeholder: "George's 'Jeff' is you". Accepting links the
    placeholder (and every bill it is on) to the invitee's account."""

    __tablename__ = "person_links"

    id: Mapped[uuid.UUID] = uuid_pk()
    person_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("people.id", ondelete="CASCADE"), nullable=False
    )
    inviter_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    invitee_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    created_at: Mapped[datetime] = created_at_col()
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(f"status IN {LINK_STATUSES}", name="status"),
        Index("uq_person_links_pending", "person_id", unique=True, postgresql_where=text("status = 'pending'")),
        Index("ix_person_links_invitee_id", "invitee_id"),
    )


class MailboxItem(Base):
    """A notice for one account. Requests that need an answer (friend requests, link invites,
    "I've paid") are read live from their own tables; these rows are the updates around them.
    ``count`` coalesces repeats (several edits to one bill are one unread line)."""

    __tablename__ = "mailbox_items"

    id: Mapped[uuid.UUID] = uuid_pk()
    recipient_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    bill_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("bills.id", ondelete="CASCADE"))
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        CheckConstraint(f"kind IN {MAILBOX_KINDS}", name="kind"),
        Index("ix_mailbox_items_recipient_id_updated_at", "recipient_id", "updated_at"),
        Index("ix_mailbox_items_unread", "recipient_id", postgresql_where=text("read_at IS NULL")),
    )


class AccessRequest(Base):
    """Someone signed in with Google but has no account yet. The admin approves (creating the
    profile for that same auth user) or rejects."""

    __tablename__ = "access_requests"

    id: Mapped[uuid.UUID] = uuid_pk()
    auth_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    created_at: Mapped[datetime] = created_at_col()
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )

    __table_args__ = (
        CheckConstraint(f"status IN {ACCESS_STATUSES}", name="status"),
        CheckConstraint("note IS NULL OR char_length(note) <= 300", name="note_len"),
        Index("ix_access_requests_status_created_at", "status", "created_at"),
    )


class Group(Base):
    """A personal saved set of people (friends or placeholders). Only its owner sees it."""

    __tablename__ = "groups"

    id: Mapped[uuid.UUID] = uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        CheckConstraint("char_length(name) BETWEEN 1 AND 60", name="name_len"),
        Index("ix_groups_owner_id", "owner_id"),
    )


class GroupMember(Base):
    __tablename__ = "group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True
    )
    person_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("people.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)


class BillEdit(Base):
    """Every write to a bill: who, which version it produced, and what it touched. Conflict checks
    read it (only overlapping edits by someone else reject a save)."""

    __tablename__ = "bill_edits"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    bill_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bills.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    item_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), nullable=False,
                                                      server_default=text("'{}'"))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint(f"kind IN {EDIT_KINDS}", name="kind"),
        Index("ix_bill_edits_bill_id_version", "bill_id", "version"),
    )


__all__ = ["AccessRequest", "BillEdit", "Friendship", "Group", "GroupMember", "MailboxItem", "PersonLink"]
