from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import Select, and_, func, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Bill, BillItem, BillParticipant


def _full(stmt: Select[tuple[Bill]]) -> Select[tuple[Bill]]:
    return stmt.options(
        selectinload(Bill.items).selectinload(BillItem.shares),
        selectinload(Bill.charges),
        selectinload(Bill.participants).selectinload(BillParticipant.person),
    )


async def get_bill(db: AsyncSession, owner_id: UUID, bill_id: UUID, *, full: bool = False,
                   for_update: bool = False) -> Bill | None:
    stmt = select(Bill).where(Bill.id == bill_id, Bill.owner_id == owner_id, Bill.deleted_at.is_(None))
    if for_update:
        stmt = stmt.with_for_update()
    if full:
        stmt = _full(stmt).execution_options(populate_existing=True)
    return await db.scalar(stmt)


async def get_bill_any_owner(db: AsyncSession, bill_id: UUID) -> Bill | None:
    """Only for the public share view (already authorised by a token)."""
    stmt = _full(select(Bill).where(Bill.id == bill_id, Bill.deleted_at.is_(None)))
    return await db.scalar(stmt.execution_options(populate_existing=True))


async def list_bills(db: AsyncSession, owner_id: UUID, *, statuses: list[str] | None, limit: int,
                     after: tuple[datetime, UUID] | None) -> list[tuple[Bill, int, int]]:
    participant_count = (
        select(func.count()).where(BillParticipant.bill_id == Bill.id).correlate(Bill).scalar_subquery()
    )
    unsettled_count = (
        select(func.count())
        .where(BillParticipant.bill_id == Bill.id, BillParticipant.settled_at.is_(None),
               BillParticipant.person_id.is_distinct_from(Bill.payer_person_id))
        .correlate(Bill).scalar_subquery()
    )
    stmt = (select(Bill, participant_count, unsettled_count)
            .where(Bill.owner_id == owner_id, Bill.deleted_at.is_(None)))
    if statuses:
        stmt = stmt.where(Bill.status.in_(statuses))
    if after is not None:
        stmt = stmt.where(tuple_(Bill.created_at, Bill.id) < tuple_(after[0], after[1]))
    stmt = stmt.order_by(Bill.created_at.desc(), Bill.id.desc()).limit(limit)
    return [(b, int(pc or 0), int(uc or 0)) for b, pc, uc in (await db.execute(stmt)).all()]


async def bills_with_open_balances(db: AsyncSession, owner_id: UUID) -> list[Bill]:
    """Complete bills where at least one non-payer participant hasn't settled."""
    has_unsettled = (
        select(BillParticipant.bill_id)
        .where(BillParticipant.bill_id == Bill.id,
               BillParticipant.person_id.is_distinct_from(Bill.payer_person_id),
               BillParticipant.settled_at.is_(None))
        .correlate(Bill).exists()
    )
    stmt = _full(select(Bill).where(and_(Bill.owner_id == owner_id, Bill.deleted_at.is_(None),
                                         Bill.status == "complete", has_unsettled))
                 ).order_by(Bill.created_at.desc()).limit(500)
    return list((await db.scalars(stmt)).all())


async def touch(db: AsyncSession, bill_id: UUID) -> None:
    await db.execute(update(Bill).where(Bill.id == bill_id).values(updated_at=func.now()))
