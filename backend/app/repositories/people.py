from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from uuid import UUID

from sqlalchemy import func, select, union, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Bill, BillParticipant, ItemShare, Person, ShareLink


async def list_people(db: AsyncSession, owner_id: UUID, *, include_archived: bool = False,
                      limit: int = 500) -> list[Person]:
    stmt = select(Person).where(Person.owner_id == owner_id)
    if not include_archived:
        stmt = stmt.where(Person.archived_at.is_(None))
    stmt = stmt.order_by(Person.is_self.desc(), Person.last_used_at.desc().nulls_last(),
                         func.lower(Person.name), Person.id).limit(limit)
    return list((await db.scalars(stmt)).all())


async def count_active(db: AsyncSession, owner_id: UUID) -> int:
    stmt = select(func.count()).select_from(Person).where(Person.owner_id == owner_id, Person.archived_at.is_(None))
    return int(await db.scalar(stmt) or 0)


async def get_person(db: AsyncSession, owner_id: UUID, person_id: UUID, *, for_update: bool = False) -> Person | None:
    stmt = select(Person).where(Person.owner_id == owner_id, Person.id == person_id)
    return await db.scalar(stmt.with_for_update() if for_update else stmt)


def referencing_bill_ids(person_ids):
    return union(
        select(Bill.id).where(Bill.payer_person_id.in_(person_ids)),
        select(BillParticipant.bill_id).where(BillParticipant.person_id.in_(person_ids)),
        select(ItemShare.bill_id).where(ItemShare.person_id.in_(person_ids)),
        select(ShareLink.bill_id).where(ShareLink.person_id.in_(person_ids)),
    )


async def reference_count(db: AsyncSession, person_ids: list[UUID]) -> int:
    return int(await db.scalar(select(func.count()).select_from(referencing_bill_ids(person_ids).subquery())) or 0)


async def get_people(db: AsyncSession, owner_id: UUID, ids: Iterable[UUID]) -> dict[UUID, Person]:
    ids = list(ids)
    if not ids:
        return {}
    rows = await db.scalars(select(Person).where(Person.owner_id == owner_id, Person.id.in_(ids)))
    return {p.id: p for p in rows}


async def get_self(db: AsyncSession, owner_id: UUID) -> Person | None:
    return await db.scalar(select(Person).where(Person.owner_id == owner_id, Person.is_self.is_(True)))


async def touch_used(db: AsyncSession, owner_id: UUID, ids: Iterable[UUID], when: datetime) -> None:
    ids = list(ids)
    if ids:
        await db.execute(update(Person).where(Person.owner_id == owner_id, Person.id.in_(ids))
                         .values(last_used_at=when))
