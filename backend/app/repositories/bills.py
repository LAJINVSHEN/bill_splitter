from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import ColumnElement, Select, exists, func, or_, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Bill, BillItem, BillParticipant, Person


def _full(stmt: Select[tuple[Bill]]) -> Select[tuple[Bill]]:
    return stmt.options(
        selectinload(Bill.items).selectinload(BillItem.shares),
        selectinload(Bill.charges),
        selectinload(Bill.participants).selectinload(BillParticipant.person),
    )


def on_bill(account_id: UUID) -> ColumnElement[bool]:
    """The account is one of the people on the bill (through someone's linked entry for them)."""
    return exists().where(BillParticipant.bill_id == Bill.id, BillParticipant.person_id == Person.id,
                          Person.linked_profile_id == account_id)


def visible_to(account_id: UUID) -> ColumnElement[bool]:
    """Owned, or shared with them because they are on it."""
    return or_(Bill.owner_id == account_id, on_bill(account_id))


async def get_bill(db: AsyncSession, owner_id: UUID, bill_id: UUID, *, full: bool = False,
                   for_update: bool = False) -> Bill | None:
    """Only the owner's own bill (owner-only paths: delete, share links, the scan pipeline's owner)."""
    stmt = select(Bill).where(Bill.id == bill_id, Bill.owner_id == owner_id, Bill.deleted_at.is_(None))
    if for_update:
        stmt = stmt.with_for_update()
    if full:
        stmt = _full(stmt).execution_options(populate_existing=True)
    return await db.scalar(stmt)


async def get_visible_bill(db: AsyncSession, account_id: UUID, bill_id: UUID, *, full: bool = False,
                           for_update: bool = False) -> Bill | None:
    stmt = select(Bill).where(Bill.id == bill_id, Bill.deleted_at.is_(None), visible_to(account_id))
    if for_update:
        stmt = stmt.with_for_update(of=Bill)
    if full:
        stmt = _full(stmt).execution_options(populate_existing=True)
    return await db.scalar(stmt)


async def get_bill_any_owner(db: AsyncSession, bill_id: UUID, *, for_update: bool = False) -> Bill | None:
    """Only for paths already authorised another way (a share token, the bill's own scan job)."""
    stmt = select(Bill).where(Bill.id == bill_id, Bill.deleted_at.is_(None))
    if for_update:
        stmt = stmt.with_for_update(of=Bill)
    return await db.scalar(_full(stmt).execution_options(populate_existing=True))


async def list_bills(db: AsyncSession, account_id: UUID, *, statuses: list[str] | None, limit: int,
                     after: tuple[datetime, UUID] | None) -> list[Bill]:
    stmt = select(Bill).where(visible_to(account_id), Bill.deleted_at.is_(None))
    if statuses:
        stmt = stmt.where(Bill.status.in_(statuses))
    if after is not None:
        stmt = stmt.where(tuple_(Bill.created_at, Bill.id) < tuple_(after[0], after[1]))
    stmt = _full(stmt.order_by(Bill.created_at.desc(), Bill.id.desc()).limit(limit))
    return list((await db.scalars(stmt)).all())


async def bills_with_open_balances(db: AsyncSession, account_id: UUID, *, for_update: bool = False) -> list[Bill]:
    """Complete bills the account owns or is on, newest first."""
    stmt = select(Bill).where(visible_to(account_id), Bill.deleted_at.is_(None),
                              Bill.status == "complete").order_by(Bill.created_at.desc(), Bill.id.desc())
    if for_update:
        stmt = _full(stmt.with_for_update(of=Bill)).execution_options(populate_existing=True)
    else:
        stmt = _full(stmt)
    return list((await db.scalars(stmt)).all())


async def touch(db: AsyncSession, bill_id: UUID) -> None:
    await db.execute(update(Bill).where(Bill.id == bill_id).values(updated_at=func.now()))
