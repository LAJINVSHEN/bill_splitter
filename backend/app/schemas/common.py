from __future__ import annotations

import re
from decimal import Decimal
from typing import Annotated, Generic, TypeVar

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, PlainSerializer

from app.core.currencies import is_currency

T = TypeVar("T")

MAX_CENTS = 10_000_000_000  # 100M major units – far above any real bill
MAX_ITEM_CENTS = 1_000_000_000

_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


def _currency(v: str) -> str:
    v = v.strip().upper()
    if not _CURRENCY_RE.match(v) or not is_currency(v):
        raise ValueError("currency must be an ISO 4217 code from shared/currencies.json")
    return v


MAX_RATE_DIGITS = 15


def _rate(v: Decimal) -> Decimal:
    """A user-typed conversion rate: > 0, sane magnitude, ≤ 15 significant digits."""
    if not v.is_finite() or v <= 0:
        raise ValueError("rate must be greater than 0")
    if not Decimal("1e-12") <= v <= Decimal("1e12"):
        raise ValueError("rate must be between 1e-12 and 1e12")
    if len(v.normalize().as_tuple().digits) > MAX_RATE_DIGITS:
        raise ValueError(f"rate can have at most {MAX_RATE_DIGITS} significant digits")
    return v.normalize()


def _strip(v: str) -> str:
    return " ".join(v.split())


def _normalize_decimal(d: Decimal) -> str:
    """``Decimal('2.000')`` → ``"2"``, ``Decimal('0.500')`` → ``"0.5"``."""
    text = format(d.normalize(), "f")
    return text if text != "-0" else "0"


Currency = Annotated[str, AfterValidator(_currency)]
Rate = Annotated[Decimal, AfterValidator(_rate)]
CleanStr = Annotated[str, AfterValidator(_strip)]
DecimalStr = Annotated[Decimal, PlainSerializer(_normalize_decimal, return_type=str, when_used="json")]
Cents = Annotated[int, Field(ge=-MAX_CENTS, le=MAX_CENTS)]
NonNegCents = Annotated[int, Field(ge=0, le=MAX_CENTS)]


class InputModel(BaseModel):
    """Request bodies: unknown fields are rejected so typos fail loudly."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class OutputModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(OutputModel, Generic[T]):
    items: list[T]
    next_cursor: str | None = None
