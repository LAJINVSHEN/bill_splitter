"""Groups: a personal saved set of people (friends and placeholders). Only the owner sees it.
It is a shortcut for adding people to a bill and a scope for settling up: the group's plan
simplifies debts between its accounts across every bill the owner can see. "Send plan" drops
each member's own rows into their Mailbox, since they can't see the owner's group.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import AppError, BadRequest, NotFound
from app.middleware.auth import CurrentUser
from app.models import Group, GroupMember
from app.repositories import people as people_repo
from app.schemas.social import GroupIn, GroupList, GroupOut, GroupPatch, SendPlanIn, SendPlanOut
from app.services import mailbox
from app.services import settle_up as settle_svc

MAX_GROUPS = 50


async def _out(db: AsyncSession, group: Group) -> GroupOut:
    ids = (await db.scalars(select(GroupMember.person_id).where(GroupMember.group_id == group.id)
                            .order_by(GroupMember.position))).all()
    return GroupOut(id=group.id, name=group.name, person_ids=list(ids), created_at=group.created_at)


async def _get(db: AsyncSession, user: CurrentUser, group_id: UUID) -> Group:
    group = await db.scalar(select(Group).where(Group.id == group_id, Group.owner_id == user.id))
    if group is None:
        raise NotFound("Group")
    return group


async def _set_members(db: AsyncSession, user: CurrentUser, group: Group, person_ids: list[UUID]) -> None:
    people = await people_repo.get_people(db, user.id, person_ids)
    if len(people) != len(person_ids) or any(p.is_self for p in people.values()):
        raise BadRequest("unknown_person", "One of the people isn't in your people.")
    await db.execute(delete(GroupMember).where(GroupMember.group_id == group.id))
    for pos, pid in enumerate(person_ids):
        db.add(GroupMember(group_id=group.id, person_id=pid, position=pos))


async def list_groups(db: AsyncSession, user: CurrentUser) -> GroupList:
    rows = (await db.scalars(select(Group).where(Group.owner_id == user.id)
                             .order_by(func.lower(Group.name), Group.id))).all()
    return GroupList(items=[await _out(db, g) for g in rows])


async def create(db: AsyncSession, user: CurrentUser, data: GroupIn) -> GroupOut:
    count = await db.scalar(select(func.count()).select_from(Group).where(Group.owner_id == user.id))
    if (count or 0) >= MAX_GROUPS:
        raise AppError(409, "groups_limit", f"You can keep up to {MAX_GROUPS} groups.")
    group = Group(owner_id=user.id, name=data.name)
    db.add(group)
    await db.flush()
    await _set_members(db, user, group, data.person_ids)
    await db.commit()
    await db.refresh(group)
    return await _out(db, group)


async def patch(db: AsyncSession, user: CurrentUser, group_id: UUID, data: GroupPatch) -> GroupOut:
    group = await _get(db, user, group_id)
    if data.name is not None:
        group.name = data.name
    if data.person_ids is not None:
        await _set_members(db, user, group, list(dict.fromkeys(data.person_ids)))
    group.updated_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(group)
    return await _out(db, group)


async def remove(db: AsyncSession, user: CurrentUser, group_id: UUID) -> None:
    await db.execute(delete(Group).where(Group.id == group_id, Group.owner_id == user.id))
    await db.commit()


async def send_plan(db: AsyncSession, user: CurrentUser, group_id: UUID, data: SendPlanIn) -> SendPlanOut:
    """Each account in the plan gets its own rows ("You pay Cara SGD 20.00")."""
    group = await _get(db, user, group_id)
    plan = await settle_svc.settle_up(db, user, data.combine, group_id)
    rows = next((g.simplified for g in plan.groups if g.currency == data.currency), [])
    per_account: dict[UUID, list[dict[str, object]]] = {}
    for p in rows:
        for side in (p.from_person, p.to_person):
            if side.account_id and side.account_id != user.id:
                per_account.setdefault(side.account_id, []).append({
                    "from": p.from_person.name, "to": p.to_person.name, "amount_cents": p.amount_cents,
                    "you_pay": side is p.from_person, "you_get": side is p.to_person,
                })
    for account, mine in per_account.items():
        await mailbox.notify(db, account, "plan_sent", actor_id=user.id,
                             data={"group": group.name, "currency": data.currency, "rows": mine})
    await db.commit()
    return SendPlanOut(sent_to=len(per_account))
