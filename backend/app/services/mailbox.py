"""The Mailbox: what's waiting on you (answer it) and what happened (read it).

Requests are read live from their own tables, so answering one anywhere clears it here too:
friend requests, placeholder links, and "I've paid" claims on bills you own. Updates are
``mailbox_items`` rows. In-app only: no push, no email; they show as unread next time.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.middleware.auth import CurrentUser
from app.models import Bill, BillParticipant, Friendship, MailboxItem, PaymentClaim, Person, PersonLink, Profile
from app.schemas.social import AccountBrief, MailboxOut, MailRequest, MailSent, MailUpdate

UPDATES_KEPT = timedelta(days=60)
UPDATES_SHOWN = 50


def _now() -> datetime:
    return datetime.now(UTC)


async def notify(db: AsyncSession, recipient_id: UUID, kind: str, *, actor_id: UUID | None = None,
                 bill_id: UUID | None = None, data: dict[str, Any] | None = None, coalesce: bool = False) -> None:
    """Leave an update (flushed with the caller's commit). ``coalesce`` folds a repeat into the
    unread one for the same bill and kind: "Ben edited Dinner" ×3 is one line."""
    if coalesce:
        row = await db.scalar(select(MailboxItem).where(
            MailboxItem.recipient_id == recipient_id, MailboxItem.kind == kind, MailboxItem.bill_id == bill_id,
            MailboxItem.read_at.is_(None)).with_for_update())
        if row is not None:
            row.count += 1
            row.actor_id = actor_id
            row.updated_at = _now()
            if data:
                row.data = {**row.data, **data}
            return
    db.add(MailboxItem(recipient_id=recipient_id, kind=kind, actor_id=actor_id, bill_id=bill_id, data=data or {}))


def color_for(username: str) -> int:
    from app.services.people import default_color

    return default_color(username)


async def briefs(db: AsyncSession, viewer_id: UUID, account_ids: set[UUID]) -> dict[UUID, AccountBrief]:
    """How the viewer sees these accounts: their own name and colour for them if they have one."""
    ids = {a for a in account_ids if a is not None}
    if not ids:
        return {}
    rows = (await db.execute(select(Profile.id, Profile.username, Profile.display_name)
                             .where(Profile.id.in_(ids)))).all()
    # active entries come last so they win over archived ones
    mine = {p.linked_profile_id: p for p in (await db.scalars(select(Person).where(
        Person.owner_id == viewer_id, Person.linked_profile_id.in_(ids)).order_by(Person.archived_at.desc().nulls_last())
    )).all()}
    out = {}
    for uid, username, display in rows:
        person = mine.get(uid)
        out[uid] = AccountBrief(id=uid, username=username, name=person.name if person else display,
                                color_seed=person.color_seed if person else color_for(username))
    return out


async def _requests(db: AsyncSession, user: CurrentUser) -> list[MailRequest]:
    friend_rows = (await db.scalars(select(Friendship).where(
        Friendship.addressee_id == user.id, Friendship.status == "pending"))).all()
    link_rows = (await db.execute(
        select(PersonLink, Person.name).join(Person, Person.id == PersonLink.person_id)
        .where(PersonLink.invitee_id == user.id, PersonLink.status == "pending"))).all()
    claim_rows = (await db.execute(
        select(PaymentClaim, Bill.title, Bill.merchant, Bill.bill_date, Person.name, Person.color_seed,
               Person.linked_profile_id)
        .join(Bill, Bill.id == PaymentClaim.bill_id)
        .join(Person, Person.id == PaymentClaim.person_id)
        .where(PaymentClaim.owner_id == user.id, PaymentClaim.status == "claimed", Bill.deleted_at.is_(None)))).all()
    actors = await briefs(db, user.id, {f.requester_id for f in friend_rows} | {link.inviter_id for link, _ in link_rows}
                          | {c.claimed_by for c, *_ in claim_rows if c.claimed_by})
    counts: dict[UUID, int] = {}
    if link_rows:
        counts = dict((await db.execute(
            select(BillParticipant.person_id, func.count()).join(Bill, Bill.id == BillParticipant.bill_id)
            .where(BillParticipant.person_id.in_([link.person_id for link, _ in link_rows]),
                   Bill.deleted_at.is_(None)).group_by(BillParticipant.person_id))).all())
    out = [MailRequest(kind="friend_request", id=f.id, created_at=f.created_at, actor=actors.get(f.requester_id))
           for f in friend_rows if f.requester_id in actors]
    out += [MailRequest(kind="link_invite", id=link.id, created_at=link.created_at, actor=actors.get(link.inviter_id),
                        person_name=name, bill_count=counts.get(link.person_id, 0))
            for link, name in link_rows]
    out += [MailRequest(kind="payment_claim", id=c.id, created_at=c.created_at,
                        actor=actors.get(c.claimed_by) if c.claimed_by else None, person_id=c.person_id,
                        person_name=name, color_seed=seed, bill_id=c.bill_id,
                        bill_title=title or merchant or "Untitled bill", bill_date=bill_date,
                        amount_cents=c.amount_cents, currency=c.currency, expected_total_cents=c.expected_total_cents)
            for c, title, merchant, bill_date, name, seed, _ in claim_rows]
    return sorted(out, key=lambda r: r.created_at, reverse=True)


async def _updates(db: AsyncSession, user: CurrentUser) -> list[MailUpdate]:
    rows = (await db.execute(
        select(MailboxItem, Bill.title, Bill.merchant)
        .outerjoin(Bill, Bill.id == MailboxItem.bill_id)
        .where(MailboxItem.recipient_id == user.id, MailboxItem.updated_at > _now() - UPDATES_KEPT,
               (MailboxItem.bill_id.is_(None)) | (Bill.deleted_at.is_(None)))
        .order_by(MailboxItem.updated_at.desc()).limit(UPDATES_SHOWN))).all()
    actors = await briefs(db, user.id, {m.actor_id for m, *_ in rows if m.actor_id})
    return [MailUpdate(id=m.id, kind=m.kind, actor=actors.get(m.actor_id) if m.actor_id else None, bill_id=m.bill_id,
                       bill_title=(title or merchant or "Untitled bill") if m.bill_id else None, count=m.count,
                       data=m.data, unread=m.read_at is None, at=m.updated_at)
            for m, title, merchant in rows]


async def _sent(db: AsyncSession, user: CurrentUser) -> list[MailSent]:
    friends = (await db.scalars(select(Friendship).where(Friendship.requester_id == user.id,
                                                         Friendship.status == "pending"))).all()
    links = (await db.execute(select(PersonLink, Person.name).join(Person, Person.id == PersonLink.person_id)
                              .where(PersonLink.inviter_id == user.id, PersonLink.status == "pending"))).all()
    invitees = await briefs(db, user.id, {link.invitee_id for link, _ in links})
    out = [MailSent(kind="friend_request", id=f.id, label=f.identifier, created_at=f.created_at) for f in friends]
    out += [MailSent(kind="link_invite", id=link.id, label=invitees[link.invitee_id].name if link.invitee_id in invitees
                     else "", person_name=name, person_id=link.person_id, created_at=link.created_at)
             for link, name in links]
    return sorted(out, key=lambda r: r.created_at, reverse=True)


async def unread_count(db: AsyncSession, user_id: UUID) -> int:
    """Requests waiting on you plus unread updates (the badge)."""
    requests = await db.scalar(select(func.count()).select_from(Friendship).join(
        Profile, Profile.id == Friendship.requester_id).where(
        Friendship.addressee_id == user_id, Friendship.status == "pending"))
    links = await db.scalar(select(func.count()).select_from(PersonLink).where(
        PersonLink.invitee_id == user_id, PersonLink.status == "pending"))
    claims = await db.scalar(select(func.count()).select_from(PaymentClaim).join(Bill, Bill.id == PaymentClaim.bill_id)
                             .where(PaymentClaim.owner_id == user_id, PaymentClaim.status == "claimed",
                                    Bill.deleted_at.is_(None)))
    unread = await db.scalar(select(func.count()).select_from(MailboxItem).outerjoin(
        Bill, Bill.id == MailboxItem.bill_id).where(
        MailboxItem.recipient_id == user_id, MailboxItem.read_at.is_(None),
        MailboxItem.updated_at > _now() - UPDATES_KEPT,
        (MailboxItem.bill_id.is_(None)) | (Bill.deleted_at.is_(None))))
    return int((requests or 0) + (links or 0) + (claims or 0) + (unread or 0))


async def mailbox(db: AsyncSession, user: CurrentUser) -> MailboxOut:
    out = MailboxOut(requests=await _requests(db, user), updates=await _updates(db, user), sent=await _sent(db, user),
                     unread_count=0)
    out.unread_count = len(out.requests) + sum(u.unread for u in out.updates)
    await db.commit()
    return out


async def mark_read(db: AsyncSession, user: CurrentUser, ids: list[UUID] | None) -> None:
    stmt = update(MailboxItem).where(MailboxItem.recipient_id == user.id, MailboxItem.read_at.is_(None))
    if ids is not None:
        stmt = stmt.where(MailboxItem.id.in_(ids))
    await db.execute(stmt.values(read_at=_now()))
    await db.commit()
