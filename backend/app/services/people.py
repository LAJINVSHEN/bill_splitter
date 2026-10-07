from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import AppError, Conflict, NotFound
from app.models import Person
from app.repositories import people as repo
from app.schemas.people import PeopleList, PersonCreate, PersonOut, PersonPatch

MAX_PEOPLE_PER_OWNER = 300


def default_color(name: str) -> int:
    return int(hashlib.sha256(name.lower().encode()).hexdigest()[:4], 16) % 360


async def ensure_self(db: AsyncSession, owner_id: UUID, display_name: str) -> Person:
    """The owner's own "Me" person (created lazily; flushed, not committed)."""
    me = await repo.get_self(db, owner_id)
    if me is None:
        me = Person(owner_id=owner_id, name=display_name[:60] or "Me", is_self=True,
                    color_seed=default_color(display_name or "me"))
        db.add(me)
        await db.flush()
    return me


async def list_people(db: AsyncSession, owner_id: UUID, include_archived: bool) -> PeopleList:
    rows = await repo.list_people(db, owner_id, include_archived=include_archived)
    return PeopleList(items=[PersonOut.model_validate(p) for p in rows])


async def create_person(db: AsyncSession, owner_id: UUID, data: PersonCreate) -> PersonOut:
    if await repo.count_active(db, owner_id) >= MAX_PEOPLE_PER_OWNER:
        raise AppError(409, "people_limit", f"You can save up to {MAX_PEOPLE_PER_OWNER} people.")
    person = Person(owner_id=owner_id, name=data.name,
                    color_seed=data.color_seed if data.color_seed is not None else default_color(data.name))
    db.add(person)
    await db.commit()
    await db.refresh(person)
    return PersonOut.model_validate(person)


async def patch_person(db: AsyncSession, owner_id: UUID, person_id: UUID, data: PersonPatch) -> PersonOut:
    person = await repo.get_person(db, owner_id, person_id)
    if person is None:
        raise NotFound("Person")
    if data.name is not None:
        person.name = data.name
    if data.color_seed is not None:
        person.color_seed = data.color_seed
    if data.archived is not None:
        if data.archived and person.is_self:
            raise Conflict("cannot_archive_self", "You can't remove yourself.")
        person.archived_at = datetime.now(UTC) if data.archived else None
    await db.commit()
    await db.refresh(person)
    return PersonOut.model_validate(person)


async def archive_person(db: AsyncSession, owner_id: UUID, person_id: UUID) -> None:
    """Archive by default so old bills keep their names."""
    person = await repo.get_person(db, owner_id, person_id)
    if person is None:
        raise NotFound("Person")
    if person.is_self:
        raise Conflict("cannot_archive_self", "You can't remove yourself.")
    if person.archived_at is None:
        person.archived_at = datetime.now(UTC)
        await db.commit()


def _referenced(count: int | None = None) -> Conflict:
    return Conflict("person_referenced", "Saved people are still used by bills, including deleted bills. "
                    "Permanently delete their associated bills first, or archive the people to keep history.",
                    bill_count=count)


async def delete_person(db: AsyncSession, owner_id: UUID, person_id: UUID) -> None:
    person = await repo.get_person(db, owner_id, person_id, for_update=True)
    if person is None:
        return
    if person.is_self:
        raise Conflict("cannot_delete_self", "You can't delete Me. Account deletion is an admin action.")
    count = await repo.reference_count(db, [person.id])
    if count:
        raise _referenced(count)
    await db.delete(person)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise _referenced() from None


async def clear_people(db: AsyncSession, owner_id: UUID, *, permanent: bool) -> None:
    rows = list((await db.scalars(select(Person).where(
        Person.owner_id == owner_id, Person.is_self.is_(False),
    ).order_by(Person.id).with_for_update())).all())
    if not permanent:
        await db.execute(update(Person).where(
            Person.owner_id == owner_id, Person.is_self.is_(False), Person.archived_at.is_(None),
        ).values(archived_at=datetime.now(UTC)))
    else:
        ids = [person.id for person in rows]
        count = await repo.reference_count(db, ids)
        if count:
            raise _referenced(count)
        await db.execute(delete(Person).where(Person.owner_id == owner_id, Person.id.in_(ids),
                                               Person.is_self.is_(False)))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise _referenced() from None
