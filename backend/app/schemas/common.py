from __future__ import annotations

import re
from decimal import Decimal
from typing import Annotated, Generic, TypeVar

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, PlainSerializer

T = TypeVar("T")

MAX_CENTS = 10_000_000_000  # 100M major units – far above any real bill
MAX_ITEM_CENTS = 1_000_000_000

_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


def _currency(v: str) -> str:
    v = v.strip().upper()
    if not _CURRENCY_RE.match(v):
        raise ValueError("currency must be a 3-letter ISO 4217 code")
    return v


def _strip(v: str) -> str:
    return " ".join(v.split())


def _normalize_decimal(d: Decimal) -> str:
    """``Decimal('2.000')`` → ``"2"``, ``Decimal('0.500')`` → ``"0.5"``."""
    text = format(d.normalize(), "f")
    return text if text != "-0" else "0"


Currency = Annotated[str, AfterValidator(_currency)]
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
