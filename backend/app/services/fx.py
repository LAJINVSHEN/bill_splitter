"""The user's saved conversion rates (typed by hand – there is no FX feed, ever).

One row per *unordered* pair: saving SGD→MYR replaces a stored MYR→SGD row, and asking
for the inverse of a stored pair returns ``1 / rate`` (12 significant digits, flagged
``derived``). Bills never point at these rows: they copy a snapshot (``bills.fx_rate``).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP, Context, Decimal
from uuid import UUID

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import BadRequest, NotFound
from app.models import FxRate
from app.schemas.me import FxRateList, FxRateOut

DERIVED_PRECISION = 12


def invert(rate: Decimal) -> Decimal:
    return Context(prec=DERIVED_PRECISION, rounding=ROUND_HALF_UP).divide(Decimal(1), rate).normalize()


@dataclass(frozen=True)
class FoundRate:
    rate: Decimal
    derived: bool
    updated_at: datetime


def _check_pair(base: str, quote: str) -> None:
    if base == quote:
        raise BadRequest("same_currency", "A rate needs two different currencies.")


def _pair(owner_id: UUID, base: str, quote: str):  # noqa: ANN202 - SQL expression
    return and_(FxRate.owner_id == owner_id,
                or_(and_(FxRate.base == base, FxRate.quote == quote),
                    and_(FxRate.base == quote, FxRate.quote == base)))


async def lookup(db: AsyncSession, owner_id: UUID, base: str, quote: str) -> FoundRate | None:
    row = await db.scalar(select(FxRate).where(_pair(owner_id, base, quote)))
    if row is None:
        return None
    if row.base == base:
        return FoundRate(rate=row.rate, derived=False, updated_at=row.updated_at)
    return FoundRate(rate=invert(row.rate), derived=True, updated_at=row.updated_at)


async def list_rates(db: AsyncSession, owner_id: UUID) -> FxRateList:
    rows = await db.scalars(select(FxRate).where(FxRate.owner_id == owner_id).order_by(FxRate.base, FxRate.quote))
    return FxRateList(items=[FxRateOut(base=r.base, quote=r.quote, rate=r.rate, derived=False,
                                       updated_at=r.updated_at) for r in rows])


async def get_rate(db: AsyncSession, owner_id: UUID, base: str, quote: str) -> FxRateOut:
    _check_pair(base, quote)
    found = await lookup(db, owner_id, base, quote)
    if found is None:
        raise NotFound("Rate")
    return FxRateOut(base=base, quote=quote, rate=found.rate, derived=found.derived, updated_at=found.updated_at)


async def save_rate(db: AsyncSession, owner_id: UUID, base: str, quote: str, rate: Decimal) -> None:
    """Upsert base→quote and drop a stored quote→base row (flushes, doesn't commit)."""
    _check_pair(base, quote)
    await db.execute(delete(FxRate).where(FxRate.owner_id == owner_id, FxRate.base == quote, FxRate.quote == base)
                     .execution_options(synchronize_session=False))
    stmt = pg_insert(FxRate).values(owner_id=owner_id, base=base, quote=quote, rate=rate)
    await db.execute(stmt.on_conflict_do_update(
        index_elements=["owner_id", "base", "quote"], set_={"rate": rate, "updated_at": func.now()}))


async def put_rate(db: AsyncSession, owner_id: UUID, base: str, quote: str, rate: Decimal) -> FxRateOut:
    await save_rate(db, owner_id, base, quote, rate)
    await db.commit()
    return await get_rate(db, owner_id, base, quote)


async def delete_rate(db: AsyncSession, owner_id: UUID, base: str, quote: str) -> None:
    _check_pair(base, quote)
    result = await db.execute(delete(FxRate).where(_pair(owner_id, base, quote)).returning(FxRate.id))
    if result.first() is None:
        raise NotFound("Rate")
    await db.commit()

