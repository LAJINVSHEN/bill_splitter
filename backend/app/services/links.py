"""Placeholder → account: "my 'Jeff' is you". The owner tags one of their placeholders with a
friend; the friend accepts in their Mailbox and every bill with that placeholder is then shared
with them (balances follow). Declining changes nothing and tells the owner.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import BadRequest, Conflict, NotFound
from app.middleware.auth import CurrentUser
from app.models import Person, PersonLink, Profile
from app.repositories import people as people_repo
from app.services import friends as friends_svc
from app.services import mailbox


def _now() -> datetime:
    return datetime.now(UTC)


async def invite(db: AsyncSession, user: CurrentUser, person_id: UUID, account_id: UUID) -> None:
    person = await people_repo.get_person(db, user.id, person_id, for_update=True)
    if person is None:
        raise NotFound("Person")
    if person.is_self or person.linked_profile_id is not None:
        raise Conflict("already_linked", "This person is already an account.")
    if person.archived_at is not None:
        raise Conflict("person_archived", "Bring them back to your people first.")
    if not await friends_svc.are_friends(db, user.id, account_id):
        raise BadRequest("not_friends", "You can only link someone who's your friend on even.")
    pending = await db.scalar(select(PersonLink).where(PersonLink.person_id == person.id,
                                                       PersonLink.status == "pending").with_for_update())
    if pending is not None:
        if pending.invitee_id == account_id:
            return
        pending.status, pending.decided_at = "cancelled", _now()
        await db.flush()
    db.add(PersonLink(person_id=person.id, inviter_id=user.id, invitee_id=account_id))
    await db.commit()


async def cancel(db: AsyncSession, user: CurrentUser, person_id: UUID) -> None:
    row = await db.scalar(select(PersonLink).where(PersonLink.person_id == person_id, PersonLink.inviter_id == user.id,
                                                   PersonLink.status == "pending").with_for_update())
    if row is not None:
        row.status, row.decided_at = "cancelled", _now()
        await db.commit()


async def _pending(db: AsyncSession, user: CurrentUser, link_id: UUID) -> PersonLink:
    row = await db.scalar(select(PersonLink).where(PersonLink.id == link_id, PersonLink.invitee_id == user.id)
                          .with_for_update())
    if row is None:
        raise NotFound("Invite")
    if row.status != "pending":
        raise Conflict("request_closed", "This invite was already answered or taken back.")
    return row


async def accept(db: AsyncSession, user: CurrentUser, link_id: UUID) -> None:
    row = await _pending(db, user, link_id)
    person = await db.get(Person, row.person_id, with_for_update=True)
    if person is None or person.linked_profile_id is not None:
        row.status, row.decided_at = "cancelled", _now()
        await db.commit()
        raise Conflict("request_closed", "This invite no longer applies.")
    # The owner may already have an entry for this friend (made when you became friends). One of
    # them has to step aside: an unused one is removed, one with history is archived (its bills
    # still count as yours, because it is linked to you too).
    twin = await db.scalar(select(Person).where(Person.owner_id == person.owner_id,
                                                Person.linked_profile_id == user.id, Person.archived_at.is_(None))
                           .with_for_update())
    if twin is not None:
        if await people_repo.reference_count(db, [twin.id]) == 0:
            await db.delete(twin)
        else:
            twin.archived_at = _now()
        await db.flush()
    person.linked_profile_id = user.id
    person.archived_at = None
    row.status, row.decided_at = "accepted", _now()
    await mailbox.notify(db, row.inviter_id, "link_accepted", actor_id=user.id, data={"person_name": person.name})
    await db.commit()


async def decline(db: AsyncSession, user: CurrentUser, link_id: UUID) -> None:
    row = await _pending(db, user, link_id)
    name = await db.scalar(select(Person.name).where(Person.id == row.person_id))
    row.status, row.decided_at = "declined", _now()
    await mailbox.notify(db, row.inviter_id, "link_declined", actor_id=user.id, data={"person_name": name or ""})
    await db.commit()


async def pending_for(db: AsyncSession, owner_id: UUID) -> dict[UUID, str]:
    """person id → the friend it's waiting on (for the People list)."""
    rows = await db.execute(select(PersonLink.person_id, Profile.display_name)
                            .join(Profile, Profile.id == PersonLink.invitee_id)
                            .where(PersonLink.inviter_id == owner_id, PersonLink.status == "pending"))
    return dict(rows.all())
