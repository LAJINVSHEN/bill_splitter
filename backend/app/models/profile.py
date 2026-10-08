from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at_col, updated_at_col, uuid_pk


class Profile(Base):
    """One row per Supabase auth user that is allowed to use the app (id = auth.users.id)."""

    __tablename__ = "profiles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    username: Mapped[str] = mapped_column(Text, nullable=False, unique=True)  # stored lower-case
    email: Mapped[str | None] = mapped_column(Text)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False, server_default="member")
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    monthly_scan_quota: Mapped[int] = mapped_column(Integer, nullable=False, server_default="30")
    default_currency: Mapped[str] = mapped_column(String(3), nullable=False, server_default="SGD")
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # How friends pay this user back, e.g. "PayNow 9123 4567" (shown on share links they're the payer of).
    payment_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        CheckConstraint("role IN ('admin', 'member')", name="role"),
        CheckConstraint("payment_note IS NULL OR char_length(payment_note) BETWEEN 1 AND 200", name="payment_note_len"),
        CheckConstraint("username = lower(username)", name="username_lower"),
        CheckConstraint("monthly_scan_quota >= 0", name="quota_nonneg"),
        CheckConstraint("default_currency ~ '^[A-Z]{3}$'", name="currency"),
    )


class Person(Base):
    """Per-account address book entry. Exactly one per owner has ``is_self``."""

    __tablename__ = "people"

    id: Mapped[uuid.UUID] = uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    color_seed: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    is_self: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        CheckConstraint("char_length(name) BETWEEN 1 AND 60", name="name_len"),
        CheckConstraint("color_seed BETWEEN 0 AND 359", name="color_seed"),
        Index("ix_people_owner_id", "owner_id"),
        Index("uq_people_owner_self", "owner_id", unique=True, postgresql_where=text("is_self")),
    )


class AppSettings(Base):
    """Singleton row (id = 1) with admin-editable global caps."""

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    global_monthly_page_cap: Mapped[int] = mapped_column(Integer, nullable=False)
    global_monthly_llm_budget_micros: Mapped[int] = mapped_column(BigInteger, nullable=False)
    default_user_quota: Mapped[int] = mapped_column(Integer, nullable=False)
    scans_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    # "YYYY-MM" (APP_TIMEZONE) when Azure answered "quota exceeded": scans stay paused for that month.
    provider_paused_month: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        CheckConstraint("id = 1", name="singleton"),
        CheckConstraint("global_monthly_page_cap >= 0", name="page_cap_nonneg"),
        CheckConstraint("global_monthly_llm_budget_micros >= 0", name="budget_nonneg"),
        CheckConstraint("default_user_quota >= 0", name="quota_nonneg"),
    )


class FxRate(Base):
    """A user's saved conversion rate: 1 ``base`` = ``rate`` ``quote`` (typed by the user –
    there is no FX feed). One row per unordered pair; the inverse is derived, not stored."""

    __tablename__ = "fx_rates"

    id: Mapped[uuid.UUID] = uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    base: Mapped[str] = mapped_column(String(3), nullable=False)
    quote: Mapped[str] = mapped_column(String(3), nullable=False)
    rate: Mapped[Decimal] = mapped_column(Numeric, nullable=False)  # arbitrary precision (≥ 10 significant digits)
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        UniqueConstraint("owner_id", "base", "quote"),
        CheckConstraint("base ~ '^[A-Z]{3}$' AND quote ~ '^[A-Z]{3}$' AND base <> quote", name="pair"),
        CheckConstraint("rate > 0", name="rate_positive"),
    )


__all__ = ["AppSettings", "FxRate", "Person", "Profile"]
