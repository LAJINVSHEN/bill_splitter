from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, updated_at_col, uuid_pk

JOB_STATUSES = ("queued", "ocr", "llm", "validating", "succeeded", "needs_review", "failed", "cancelled")
ACTIVE_JOB_STATUSES = ("queued", "ocr", "llm", "validating")


class ExtractionJob(Base):
    __tablename__ = "extraction_jobs"

    id: Mapped[uuid.UUID] = uuid_pk()
    bill_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bills.id", ondelete="CASCADE"), nullable=False
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    error_code: Mapped[str | None] = mapped_column(Text)
    error_message: Mapped[str | None] = mapped_column(Text)
    retryable: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    ocr_text: Mapped[str | None] = mapped_column(Text)
    extracted: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    validation: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    model_used: Mapped[str | None] = mapped_column(Text)
    # Currency the model read off the receipt when it differs from the bill's (not auto-applied).
    detected_currency: Mapped[str | None] = mapped_column(String(3))
    idempotency_key: Mapped[str | None] = mapped_column(Text)
    pages_billed: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # OCR pages reserved by the atomic quota gate and not yet billed (released per Azure call / at the end).
    pages_reserved: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # Worst-case cost of the model call in flight, held against the monthly LLM budget.
    llm_reserved_micros: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    cost_micros: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    timings: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        CheckConstraint(f"status IN {JOB_STATUSES}", name="status"),
        CheckConstraint("llm_reserved_micros >= 0", name="llm_reserved_nonneg"),
        UniqueConstraint("owner_id", "idempotency_key"),
        Index("ix_extraction_jobs_bill_id_created_at", "bill_id", "created_at"),
        Index("ix_extraction_jobs_status", "status"),
    )


class ReceiptFile(Base):
    __tablename__ = "receipt_files"

    id: Mapped[uuid.UUID] = uuid_pk()
    bill_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bills.id", ondelete="CASCADE"), nullable=False
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("extraction_jobs.id", ondelete="SET NULL")
    )
    storage_path: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    mime: Mapped[str] = mapped_column(Text, nullable=False)
    bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    pages: Mapped[int | None] = mapped_column(Integer)  # pages actually analysed/billed
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        Index("ix_receipt_files_bill_id", "bill_id"),
        Index("ix_receipt_files_job_id", "job_id"),
        Index("ix_receipt_files_expires_at", "expires_at"),
    )


class OcrCache(Base):
    """OCR markdown by content hash, per owner – a retry never re-bills Azure."""

    __tablename__ = "ocr_cache"

    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), primary_key=True
    )
    content_sha256: Mapped[str] = mapped_column(String(64), primary_key=True)
    ocr_text: Mapped[str] = mapped_column(Text, nullable=False)
    pages: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = created_at_col()


class UsageEvent(Base):
    """One row per OCR call (pages) or LLM call (tokens), successful or not."""

    __tablename__ = "usage_events"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("extraction_jobs.id", ondelete="SET NULL")
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str | None] = mapped_column(Text)
    pages: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    cached_input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    cost_micros: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False)
    error_code: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint("kind IN ('ocr', 'llm')", name="kind"),
        Index("ix_usage_events_created_at", "created_at"),
        Index("ix_usage_events_user_id_created_at", "user_id", "created_at"),
    )


class ShareLink(Base):
    __tablename__ = "share_links"

    id: Mapped[uuid.UUID] = uuid_pk()
    bill_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bills.id", ondelete="CASCADE"), nullable=False
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    person_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("people.id", ondelete="CASCADE")
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # 'random' = legacy token shown once; 'derived' = HMAC of the link id, so it can be shown again
    token_kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="random")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_viewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        Index("ix_share_links_bill_id", "bill_id"),
        CheckConstraint("token_kind IN ('random', 'derived')", name="token_kind"),
        # one active derived link per scope: per person, and one for the whole bill (the group link)
        Index("uq_share_links_active_person", "bill_id", "person_id", unique=True,
              postgresql_where=text("revoked_at IS NULL AND token_kind = 'derived' AND person_id IS NOT NULL")),
        Index("uq_share_links_active_group", "bill_id", unique=True,
              postgresql_where=text("revoked_at IS NULL AND token_kind = 'derived' AND person_id IS NULL")),
    )


CLAIM_STATUSES = ("claimed", "confirmed", "rejected", "withdrawn", "superseded", "reverted")


class PaymentClaim(Base):
    """A friend saying "I've paid" through a share link. A request, not a settlement: only the
    owner's Confirm writes the participant's settled amount."""

    __tablename__ = "payment_claims"

    id: Mapped[uuid.UUID] = uuid_pk()
    bill_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    share_link_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("share_links.id", ondelete="SET NULL")
    )
    via: Mapped[str] = mapped_column(Text, nullable=False)
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)  # effective currency
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    expected_total_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)  # their total when they claimed
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="claimed")
    client_key: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = created_at_col()
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        ForeignKeyConstraint(["bill_id", "person_id"], ["bill_participants.bill_id", "bill_participants.person_id"],
                             ondelete="CASCADE"),
        CheckConstraint("via IN ('person_link', 'group_link')", name="via"),
        CheckConstraint("amount_cents > 0", name="amount_positive"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency"),
        CheckConstraint(f"status IN {CLAIM_STATUSES}", name="status"),
        UniqueConstraint("share_link_id", "client_key"),
        Index("uq_payment_claims_open", "bill_id", "person_id", unique=True, postgresql_where=text("status = 'claimed'")),
        Index("ix_payment_claims_owner_open", "owner_id", postgresql_where=text("status = 'claimed'")),
        Index("ix_payment_claims_share_link_id", "share_link_id"),
    )
