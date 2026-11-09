"""Friends: ask by exact email or user id, accept / decline / cancel, unfriend, block.

Privacy: asking returns the same "sent" whether or not an account matched, is rate limited,
and skips accounts that turned "discoverable" off or blocked you; such a request just never
arrives. Only an answer (accept or decline) tells the sender anything. A declined sender can
ask again after 30 days. Accepting gives each side a linked entry in their people, so the
friend can be put on bills; unfriending archives those entries but no bill loses anyone.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import BadRequest, Conflict, NotFound
from app.middleware.auth import CurrentUser
from app.models import Bill, BillParticipant, Friendship, Person, PersonLink, Profile
from app.schemas.social import (
    BlockedOut,
    FriendOut,
    FriendRequestIn,
    FriendRequestSent,
    FriendsOut,
    OutgoingRequest,
    Suggestion,
)
from app.services import mailbox
from app.services.people import default_color

DECLINE_COOLDOWN = timedelta(days=30)
LIVE = ("pending", "accepted", "blocked")


def _now() -> datetime:
    return datetime.now(UTC)


def _pair(a: UUID, b: UUID):  # noqa: ANN202 - SQL expression
    return or_(and_(Friendship.requester_id == a, Friendship.addressee_id == b),
               and_(Friendship.requester_id == b, Friendship.addressee_id == a))


async def live_row(db: AsyncSession, a: UUID, b: UUID, *, for_update: bool = False) -> Friendship | None:
    stmt = select(Friendship).where(_pair(a, b), Friendship.status.in_(LIVE))
    return await db.scalar(stmt.with_for_update() if for_update else stmt)


async def are_friends(db: AsyncSession, a: UUID, b: UUID) -> bool:
    row = await live_row(db, a, b)
    return row is not None and row.status == "accepted"


async def friend_ids(db: AsyncSession, user_id: UUID) -> set[UUID]:
    rows = await db.execute(select(Friendship.requester_id, Friendship.addressee_id).where(
        Friendship.status == "accepted", or_(Friendship.requester_id == user_id, Friendship.addressee_id == user_id)))
    return {b if a == user_id else a for a, b in rows.all()}


def is_synthetic(settings: Settings, email: str | None) -> bool:
    """Accounts made without a real email get ``username@AUTH_EMAIL_DOMAIN``: never searchable by it."""
    return not email or email.lower().endswith("@" + settings.auth_email_domain.lower())


async def _match(db: AsyncSession, settings: Settings, identifier: str) -> Profile | None:
    ident = identifier.strip().lower()
    if "@" in ident[1:]:
        if is_synthetic(settings, ident):
            return None
        stmt = select(Profile).where(func.lower(Profile.email) == ident)
    else:
        stmt = select(Profile).where(Profile.username == ident.removeprefix("@"))
    return await db.scalar(stmt.where(Profile.disabled_at.is_(None)))


async def ensure_person(db: AsyncSession, owner_id: UUID, account: Profile) -> Person:
    """The owner's active entry for this account, made when missing (flushed, not committed)."""
    person = await db.scalar(select(Person).where(Person.owner_id == owner_id, Person.linked_profile_id == account.id,
                                                  Person.archived_at.is_(None)))
    if person is None:
        person = Person(owner_id=owner_id, name=account.display_name[:60] or account.username,
                        color_seed=default_color(account.username), linked_profile_id=account.id)
        db.add(person)
        await db.flush()
    return person


async def _archive_people(db: AsyncSession, a: UUID, b: UUID) -> None:
    """Each side's entry for the other leaves People; bills keep them (and stay shared)."""
    now = _now()
    for owner, account in ((a, b), (b, a)):
        for person in (await db.scalars(select(Person).where(
                Person.owner_id == owner, Person.linked_profile_id == account, Person.archived_at.is_(None)))).all():
            person.archived_at = now
    await db.execute(PersonLink.__table__.update().where(
        PersonLink.status == "pending",
        or_(and_(PersonLink.inviter_id == a, PersonLink.invitee_id == b),
            and_(PersonLink.inviter_id == b, PersonLink.invitee_id == a))).values(status="cancelled", decided_at=now))


async def _accept(db: AsyncSession, row: Friendship) -> None:
    row.status, row.responded_at = "accepted", _now()
    requester = await db.get(Profile, row.requester_id)
    addressee = await db.get(Profile, row.addressee_id)
    assert requester is not None and addressee is not None
    await ensure_person(db, requester.id, addressee)
    await ensure_person(db, addressee.id, requester)
    await mailbox.notify(db, requester.id, "friend_accepted", actor_id=addressee.id)


# ---------------------------------------------------------------------------- asking
async def request(db: AsyncSession, settings: Settings, user: CurrentUser, data: FriendRequestIn) -> FriendRequestSent:
    if data.account_id is not None:
        target = await _co_participant(db, user, data.account_id)
        identifier = "@" + target.username
    else:
        identifier = data.identifier.strip().lower()  # type: ignore[union-attr]
        if identifier.removeprefix("@") in (user.username, (user.email or "").lower()):
            raise BadRequest("cannot_add_self", "That's you.")
        target = await _match(db, settings, identifier)
    if target is not None:
        row = await live_row(db, user.id, target.id, for_update=True)
        if row is not None and row.status == "accepted":
            raise Conflict("already_friends", "You're already friends.")
        if row is not None and row.status == "pending" and row.requester_id == target.id:
            await _accept(db, row)  # they asked first: asking back is a yes
            await db.commit()
            return FriendRequestSent(status="accepted")
        declined = await db.scalar(select(Friendship.responded_at).where(
            Friendship.requester_id == user.id, Friendship.addressee_id == target.id,
            Friendship.status == "declined").order_by(Friendship.responded_at.desc()).limit(1))
        if declined is not None and _now() - declined < DECLINE_COOLDOWN:
            again = (declined + DECLINE_COOLDOWN).date().isoformat()
            raise Conflict("request_cooldown", f"They said no recently. You can ask again from {again}.", retry_on=again)
        reachable = row is None and (target.discoverable or data.account_id is not None)
        if row is not None and row.status == "pending" and row.requester_id == user.id:
            return FriendRequestSent(status="sent")  # already waiting
        if not reachable:
            target = None  # blocked either way, or not discoverable: stays undelivered
    existing = await db.scalar(select(Friendship.id).where(
        Friendship.requester_id == user.id, Friendship.identifier == identifier, Friendship.status == "pending"))
    if existing is None:
        db.add(Friendship(requester_id=user.id, addressee_id=target.id if target else None, identifier=identifier))
        try:
            await db.commit()
        except IntegrityError:  # a parallel request for the same pair won
            await db.rollback()
    return FriendRequestSent(status="sent")


async def _co_participant(db: AsyncSession, user: CurrentUser, account_id: UUID) -> Profile:
    """Asking someone you share a bill with needs no email: you can already see them there."""
    if account_id == user.id or account_id not in await _co_participant_ids(db, user.id):
        raise NotFound("Account")
    target = await db.get(Profile, account_id)
    if target is None or target.disabled_at is not None:
        raise NotFound("Account")
    return target


async def _co_participant_ids(db: AsyncSession, user_id: UUID) -> dict[UUID, int]:
    """Accounts on bills you can see → how many such bills (owners included)."""
    from app.repositories.bills import visible_to

    visible = select(Bill.id, Bill.owner_id).where(visible_to(user_id), Bill.deleted_at.is_(None)).subquery()
    linked = (await db.execute(
        select(Person.linked_profile_id, func.count(func.distinct(visible.c.id)))
        .select_from(visible).join(BillParticipant, BillParticipant.bill_id == visible.c.id)
        .join(Person, Person.id == BillParticipant.person_id)
        .where(Person.linked_profile_id.is_not(None)).group_by(Person.linked_profile_id))).all()
    owners = (await db.execute(select(visible.c.owner_id, func.count()).group_by(visible.c.owner_id))).all()
    out: dict[UUID, int] = {}
    for account, n in [*linked, *owners]:
        out[account] = max(out.get(account, 0), n)
    out.pop(user_id, None)
    return out


# ---------------------------------------------------------------------------- answering
async def _incoming(db: AsyncSession, user: CurrentUser, request_id: UUID) -> Friendship:
    row = await db.scalar(select(Friendship).where(Friendship.id == request_id, Friendship.addressee_id == user.id)
                          .with_for_update())
    if row is None:
        raise NotFound("Friend request")
    if row.status != "pending":
        raise Conflict("request_closed", "This request was already answered.")
    return row


async def accept(db: AsyncSession, user: CurrentUser, request_id: UUID) -> None:
    await _accept(db, await _incoming(db, user, request_id))
    await db.commit()


async def decline(db: AsyncSession, user: CurrentUser, request_id: UUID) -> None:
    row = await _incoming(db, user, request_id)
    row.status, row.responded_at = "declined", _now()
    await mailbox.notify(db, row.requester_id, "friend_declined", actor_id=user.id)
    await db.commit()


async def cancel(db: AsyncSession, user: CurrentUser, request_id: UUID) -> None:
    row = await db.scalar(select(Friendship).where(Friendship.id == request_id, Friendship.requester_id == user.id,
                                                   Friendship.status == "pending").with_for_update())
    if row is not None:
        row.status, row.responded_at = "cancelled", _now()
        await db.commit()


async def unfriend(db: AsyncSession, user: CurrentUser, account_id: UUID) -> None:
    row = await live_row(db, user.id, account_id, for_update=True)
    if row is None or row.status != "accepted":
        raise NotFound("Friend")
    row.status, row.ended_at = "ended", _now()
    await _archive_people(db, user.id, account_id)
    await db.commit()


async def block(db: AsyncSession, user: CurrentUser, account_id: UUID) -> None:
    """From a request, a friend, or someone on a shared bill. They can't ask or add you again."""
    target = await db.get(Profile, account_id)
    if target is None or account_id == user.id:
        raise NotFound("Account")
    row = await live_row(db, user.id, account_id, for_update=True)
    if row is not None and row.status == "blocked":
        return
    if row is not None:
        row.status, row.blocked_by, row.ended_at = "blocked", user.id, _now()
    else:
        db.add(Friendship(requester_id=user.id, addressee_id=account_id, identifier="@" + target.username,
                          status="blocked", blocked_by=user.id, responded_at=_now()))
    await _archive_people(db, user.id, account_id)
    await db.commit()


async def unblock(db: AsyncSession, user: CurrentUser, account_id: UUID) -> None:
    row = await live_row(db, user.id, account_id, for_update=True)
    if row is not None and row.status == "blocked" and row.blocked_by == user.id:
        row.status, row.ended_at = "ended", _now()
        await db.commit()


# ---------------------------------------------------------------------------- listing
async def friends(db: AsyncSession, user: CurrentUser) -> FriendsOut:
    rows = (await db.scalars(select(Friendship).where(
        or_(Friendship.requester_id == user.id, Friendship.addressee_id == user.id),
        Friendship.status.in_(("accepted", "blocked")), Friendship.addressee_id.is_not(None)))).all()
    other = {r.id: (r.addressee_id if r.requester_id == user.id else r.requester_id) for r in rows}
    accepted = [r for r in rows if r.status == "accepted"]
    blocked = [r for r in rows if r.status == "blocked" and r.blocked_by == user.id]
    co = await _co_participant_ids(db, user.id)
    pending = (await db.scalars(select(Friendship).where(
        Friendship.status == "pending", _pair_with_anyone(user.id)))).all()
    taken = set(other.values()) | {r.addressee_id if r.requester_id == user.id else r.requester_id for r in pending}
    suggest = {a: n for a, n in co.items() if a not in taken}
    names = await mailbox.briefs(db, user.id, set(other.values()) | set(suggest))
    persons = dict((await db.execute(select(Person.linked_profile_id, Person.id).where(
        Person.owner_id == user.id, Person.archived_at.is_(None), Person.linked_profile_id.is_not(None)))).all())
    outgoing = (await db.scalars(select(Friendship).where(Friendship.requester_id == user.id,
                                                          Friendship.status == "pending")
                                 .order_by(Friendship.created_at.desc()))).all()
    return FriendsOut(
        friends=sorted([FriendOut(account=names[other[r.id]], person_id=persons.get(other[r.id]),
                                  since=r.responded_at or r.created_at) for r in accepted if other[r.id] in names],
                       key=lambda f: f.account.name.casefold()),
        outgoing=[OutgoingRequest(id=r.id, identifier=r.identifier, created_at=r.created_at) for r in outgoing],
        blocked=[BlockedOut(account=names[other[r.id]], at=r.ended_at or r.created_at) for r in blocked
                 if other[r.id] in names],
        suggestions=sorted([Suggestion(account=names[a], shared_bills=n) for a, n in suggest.items() if a in names],
                           key=lambda s: (-s.shared_bills, s.account.name.casefold()))[:10],
    )


def _pair_with_anyone(user_id: UUID):  # noqa: ANN202 - SQL expression
    return or_(Friendship.requester_id == user_id, Friendship.addressee_id == user_id)
