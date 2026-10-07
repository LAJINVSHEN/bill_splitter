from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, created_at_col, updated_at_col, uuid_pk
from app.models.profile import Person

BILL_STATUSES = ("draft", "scanning", "review", "assigning", "complete")
BILL_SOURCES = ("scan", "manual", "quick")
TAX_SCENARIOS = ("tax_exclusive", "tax_inclusive", "no_taxes")


class Bill(Base):
    __tablename__ = "bills"

    id: Mapped[uuid.UUID] = uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str | None] = mapped_column(Text)
    merchant: Mapped[str | None] = mapped_column(Text)
    bill_date: Mapped[date | None] = mapped_column(Date)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="draft")
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default="manual")
    payer_person_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("people.id", ondelete="SET NULL")
    )
    subtotal_cents: Mapped[int | None] = mapped_column(BigInteger)
    grand_total_cents: Mapped[int | None] = mapped_column(BigInteger)
    tax_scenario: Mapped[str | None] = mapped_column(Text)
    receipt_meta: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    items: Mapped[list[BillItem]] = relationship(
        back_populates="bill", order_by="BillItem.position", cascade="all, delete-orphan", lazy="raise"
    )
    charges: Mapped[list[BillCharge]] = relationship(
        order_by="BillCharge.position", cascade="all, delete-orphan", lazy="raise"
    )
    participants: Mapped[list[BillParticipant]] = relationship(
        order_by="BillParticipant.position", cascade="all, delete-orphan", lazy="raise"
    )

    __table_args__ = (
        CheckConstraint(f"status IN {BILL_STATUSES}", name="status"),
        CheckConstraint(f"source IN {BILL_SOURCES}", name="source"),
        CheckConstraint(f"tax_scenario IS NULL OR tax_scenario IN {TAX_SCENARIOS}", name="tax_scenario"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency"),
        CheckConstraint("grand_total_cents IS NULL OR grand_total_cents >= 0", name="grand_total_nonneg"),
        Index("ix_bills_owner_id_created_at", "owner_id", "created_at"),
    )


class BillItem(Base):
    __tablename__ = "bill_items"

    id: Mapped[uuid.UUID] = uuid_pk()
    bill_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bills.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False, server_default="1")
    unit_price_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    total_price_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    split_mode: Mapped[str | None] = mapped_column(Text)

    bill: Mapped[Bill] = relationship(back_populates="items", lazy="raise")
    shares: Mapped[list[ItemShare]] = relationship(
        order_by="ItemShare.position", cascade="all, delete-orphan", lazy="raise", passive_deletes=True
    )

    __table_args__ = (
        CheckConstraint("split_mode IS NULL OR split_mode IN ('single', 'equal', 'weighted', 'custom')",
                        name="split_mode"),
        Index("ix_bill_items_bill_id", "bill_id"),
    )


class BillParticipant(Base):
    __tablename__ = "bill_participants"

    bill_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bills.id", ondelete="CASCADE"), primary_key=True
    )
    # Deferred (checked at COMMIT): a person can't be deleted while on a bill, but deleting a
    # whole profile cascades through people *and* bills → participants without tripping it.
    person_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("people.id", deferrable=True, initially="DEFERRED"), primary_key=True
    )
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    settled_amount_cents: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = created_at_col()

    person: Mapped[Person] = relationship(lazy="raise")

    __table_args__ = (Index("ix_bill_participants_person_id", "person_id"),)


class ItemShare(Base):
    """Who shares an item: ``weight`` for equal/weighted, ``amount_cents`` for custom."""

    __tablename__ = "item_shares"

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bill_items.id", ondelete="CASCADE"), primary_key=True
    )
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    bill_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    weight: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    amount_cents: Mapped[int | None] = mapped_column(BigInteger)

    __table_args__ = (
        # A share can only point at someone who is on the bill; removing a participant removes their shares.
        ForeignKeyConstraint(
            ["bill_id", "person_id"],
            ["bill_participants.bill_id", "bill_participants.person_id"],
            ondelete="CASCADE",
            name="fk_item_shares_participant",
        ),
        CheckConstraint("weight IS NULL OR weight >= 0", name="weight_nonneg"),
        Index("ix_item_shares_bill_id_person_id", "bill_id", "person_id"),
    )


class BillCharge(Base):
    __tablename__ = "bill_charges"

    id: Mapped[uuid.UUID] = uuid_pk()
    bill_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bills.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="other")
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    percent: Mapped[Decimal | None] = mapped_column(Numeric(9, 2))

    __table_args__ = (
        CheckConstraint("kind IN ('tax', 'service', 'discount', 'rounding', 'other')", name="kind"),
        Index("ix_bill_charges_bill_id", "bill_id"),
    )
