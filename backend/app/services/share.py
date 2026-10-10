"""Share links and the public "I've paid".

Two kinds of token: legacy random ones (32 bytes, shown once) and derived ones (HMAC of the link id
with SHARE_TOKEN_SECRET), which the server can show again, so there's one active link per scope:
each person, plus one group link for the whole bill. Only a token's SHA-256 is ever stored.

A claim from a link is a request, never a settlement: the owner confirms it (services/claims.py).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import AppError, BadRequest, Conflict, NotFound
from app.middleware.auth import CurrentUser
from app.models import Bill, PaymentClaim, Profile, ShareLink
from app.repositories import bills as bills_repo
from app.schemas.bills import SplitOut, SplitPersonOut
from app.schemas.share import (
    EnsuredLink,
    EnsuredLinks,
    EnsureLinksIn,
    PublicClaim,
    PublicClaimIn,
    PublicItem,
    PublicPerson,
    PublicShareOut,
    ShareLinkCreate,
    ShareLinkCreated,
    ShareLinkList,
    ShareLinkOut,
)
from app.services.split_view import split_out

MAX_LINKS_PER_BILL = 50
CLAIMS_PER_LINK_PER_DAY = 20
READ_ONLY_AFTER_EVEN = timedelta(days=90)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _mac(settings: Settings, *parts: bytes) -> bytes:
    return hmac.new(settings.share_secret, b"|".join(parts), hashlib.sha256).digest()


def _b64(raw: bytes, n: int) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")[:n]


def derive_token(settings: Settings, link_id: UUID) -> str:
    """128 bits, recomputable from the link id; rotating the secret turns every derived link off."""
    return _b64(_mac(settings, b"link", link_id.bytes), 22)


def person_key(settings: Settings, link_id: UUID, person_id: UUID) -> str:
    """Stable per link, meaningless outside it, and never the person's id."""
    return _b64(_mac(settings, b"person", link_id.bytes, person_id.bytes), 12)


def _ensured(settings: Settings, link: ShareLink) -> EnsuredLink:
    token = derive_token(settings, link.id)
    path = f"/s/{token}"
    return EnsuredLink(link_id=link.id, person_id=link.person_id, token=token, path=path,
                       url=f"{settings.public_app_url}{path}" if settings.public_app_url else None)


# ---------------------------------------------------------------------------- owner: links
async def create_link(db: AsyncSession, settings: Settings, user: CurrentUser, bill_id: UUID,
                      data: ShareLinkCreate) -> ShareLinkCreated:
    """Legacy: a fresh random link per call (kept for old clients)."""
    bill = await bills_repo.get_bill(db, user.id, bill_id, full=True)
    if bill is None:
        raise NotFound("Bill")
    if data.person_id is not None and data.person_id not in {p.person_id for p in bill.participants}:
        raise BadRequest("not_a_participant", "That person isn't on this bill.")
    await _check_cap(db, bill_id)
    token = secrets.token_urlsafe(32)
    expires = datetime.now(UTC) + timedelta(days=data.expires_in_days) if data.expires_in_days else None
    link = ShareLink(bill_id=bill_id, owner_id=user.id, person_id=data.person_id, token_hash=hash_token(token),
                     expires_at=expires)
    db.add(link)
    await db.commit()
    await db.refresh(link)
    path = f"/s/{token}"
    return ShareLinkCreated(id=link.id, person_id=link.person_id, created_at=link.created_at,
                            expires_at=link.expires_at, revoked_at=None, last_viewed_at=None, token=token, path=path,
                            url=f"{settings.public_app_url}{path}" if settings.public_app_url else None)


async def _check_cap(db: AsyncSession, bill_id: UUID) -> None:
    active = await db.scalar(select(func.count()).select_from(ShareLink)
                             .where(ShareLink.bill_id == bill_id, ShareLink.revoked_at.is_(None)))
    if (active or 0) >= MAX_LINKS_PER_BILL:
        raise BadRequest("too_many_links", "Revoke some links on this bill first.")


async def _new_derived(db: AsyncSession, settings: Settings, owner_id: UUID, bill_id: UUID,
                       person_id: UUID | None) -> ShareLink:
    await _check_cap(db, bill_id)
    link_id = uuid.uuid4()
    link = ShareLink(id=link_id, bill_id=bill_id, owner_id=owner_id, person_id=person_id, token_kind="derived",
                     token_hash=hash_token(derive_token(settings, link_id)))
    db.add(link)
    await db.flush()
    return link


async def ensure_links(db: AsyncSession, settings: Settings, user: CurrentUser, bill_id: UUID,
                       data: EnsureLinksIn) -> EnsuredLinks:
    """The active derived link for each scope, created when missing. Sharing again reuses it."""
    bill = await bills_repo.get_bill(db, user.id, bill_id, full=True, for_update=True)  # serialises per bill
    if bill is None:
        raise NotFound("Bill")
    on_bill = {p.person_id for p in bill.participants}
    wanted = list(dict.fromkeys(s.person_id for s in data.scopes))
    if any(pid is not None and pid not in on_bill for pid in wanted):
        raise BadRequest("not_a_participant", "That person isn't on this bill.")
    rows = (await db.scalars(select(ShareLink).where(
        ShareLink.bill_id == bill_id, ShareLink.owner_id == user.id, ShareLink.revoked_at.is_(None),
        ShareLink.token_kind == "derived"))).all()
    by_scope = {r.person_id: r for r in rows}
    out = []
    for pid in wanted:
        link = by_scope.get(pid) or await _new_derived(db, settings, user.id, bill_id, pid)
        out.append(_ensured(settings, link))
    await db.commit()
    return EnsuredLinks(items=out)


async def reset_link(db: AsyncSession, settings: Settings, user: CurrentUser, bill_id: UUID,
                     link_id: UUID) -> EnsuredLink:
    """Turn the link off and hand out a new one for the same person (or the group)."""
    bill = await bills_repo.get_bill(db, user.id, bill_id, for_update=True)
    if bill is None:
        raise NotFound("Bill")
    link = await db.scalar(select(ShareLink).where(ShareLink.id == link_id, ShareLink.bill_id == bill_id,
                                                   ShareLink.owner_id == user.id))
    if link is None:
        raise NotFound("Share link")
    link.revoked_at = datetime.now(UTC)
    await db.flush()
    fresh = await _new_derived(db, settings, user.id, bill_id, link.person_id)
    await db.commit()
    return _ensured(settings, fresh)


async def list_links(db: AsyncSession, user: CurrentUser, bill_id: UUID) -> ShareLinkList:
    if await bills_repo.get_bill(db, user.id, bill_id) is None:
        raise NotFound("Bill")
    rows = await db.scalars(select(ShareLink).where(ShareLink.bill_id == bill_id, ShareLink.owner_id == user.id)
                            .order_by(ShareLink.created_at.desc()))
    return ShareLinkList(items=[ShareLinkOut.model_validate(r) for r in rows])


async def revoke_links(db: AsyncSession, user: CurrentUser, bill_id: UUID, link_id: UUID | None = None) -> None:
    if await bills_repo.get_bill(db, user.id, bill_id) is None:
        raise NotFound("Bill")
    stmt = update(ShareLink).where(ShareLink.bill_id == bill_id, ShareLink.owner_id == user.id,
                                   ShareLink.revoked_at.is_(None))
    if link_id is not None:
        stmt = stmt.where(ShareLink.id == link_id)
    result = await db.execute(stmt.values(revoked_at=datetime.now(UTC)).returning(ShareLink.id))
    if link_id is not None and result.first() is None:
        existing = await db.scalar(select(ShareLink.id).where(ShareLink.id == link_id, ShareLink.bill_id == bill_id,
                                                               ShareLink.owner_id == user.id))
        if existing is None:
            raise NotFound("Share link")
    await db.commit()


# ---------------------------------------------------------------------------- public
def _all_even_since(bill: Bill, split: SplitOut) -> datetime | None:
    """When the bill became fully settled (None while anyone still owes)."""
    if split.outstanding_total_cents > 0:
        return None
    paid = [p.settled_at for p in bill.participants if p.settled_at is not None]
    return max(paid) if paid else bill.updated_at


async def _resolve(db: AsyncSession, token: str) -> tuple[ShareLink, Bill, SplitOut]:
    """The live link, its bill and split; 404 for anything unknown, revoked, expired or closed."""
    if not token or len(token) > 100:
        raise NotFound("Share link")
    now = datetime.now(UTC)
    link = await db.scalar(select(ShareLink).where(ShareLink.token_hash == hash_token(token)))
    if link is None or link.revoked_at is not None or (link.expires_at and link.expires_at <= now):
        raise NotFound("Share link")
    bill = await bills_repo.get_bill_any_owner(db, link.bill_id)
    if bill is None or bill.owner_id != link.owner_id:
        raise NotFound("Share link")
    split = split_out(bill)
    even_since = _all_even_since(bill, split)
    if even_since is not None and now - even_since > READ_ONLY_AFTER_EVEN:  # read-only for 90 days, then gone
        raise NotFound("Share link")
    if link.person_id is not None and all(p.person_id != link.person_id for p in split.people):
        raise NotFound("Share link")  # person removed from the bill since the link was made
    return link, bill, split


async def _latest_claims(db: AsyncSession, bill_id: UUID) -> dict[UUID, PaymentClaim]:
    rows = await db.scalars(select(PaymentClaim).where(
        PaymentClaim.bill_id == bill_id, PaymentClaim.status.in_(("claimed", "confirmed", "rejected")))
        .order_by(PaymentClaim.created_at.desc()))
    latest: dict[UUID, PaymentClaim] = {}
    for c in rows:
        latest.setdefault(c.person_id, c)
    return latest


async def _view(db: AsyncSession, settings: Settings, link: ShareLink, bill: Bill, split: SplitOut) -> PublicShareOut:
    claims = await _latest_claims(db, bill.id)

    def person(p: SplitPersonOut) -> PublicPerson:
        c = claims.get(p.person_id)
        return PublicPerson(key=person_key(settings, link.id, p.person_id), name=p.name, color_seed=p.color_seed,
                            is_payer=p.is_payer,
                            items=[PublicItem(name=i.name, share_cents=i.share_cents) for i in p.items],
                            items_cents=p.items_cents, adjustment_cents=p.adjustment_cents,
                            total_cents=p.total_cents, settle_total_cents=p.settle_total_cents,
                            settled=p.outstanding_cents == 0, outstanding_cents=p.outstanding_cents,
                            effective_total_cents=p.effective_total_cents,
                            claim=PublicClaim(status=c.status, amount_cents=c.amount_cents, created_at=c.created_at)
                            if c else None)

    payer_row = next((p for p in split.people if p.is_payer), None)
    host = await db.get(Profile, bill.owner_id)
    note = host.payment_note if host is not None and payer_row is not None and payer_row.is_self else None
    if link.person_id is not None:
        mine = next(p for p in split.people if p.person_id == link.person_id)
        scoped, people = person(mine), []
    else:
        scoped, people = None, [person(p) for p in split.people]
    return PublicShareOut(title=bill.title, merchant=bill.merchant, bill_date=bill.bill_date, currency=bill.currency,
                          settle_currency=split.settle_currency, fx_rate=split.fx_rate,
                          effective_currency=split.effective_currency, grand_total_cents=split.grand_total_cents,
                          settle_grand_total_cents=split.settle_grand_total_cents,
                          payer_name=payer_row.name if payer_row else None, payer_payment_note=note,
                          scope="person" if link.person_id else "bill", person=scoped, people=people,
                          host_name=host.display_name if host else "",
                          payer_is_host=bool(payer_row and payer_row.is_self),
                          claims_open=bill.status == "complete" and split.outstanding_total_cents > 0,
                          itemised=bill.source != "quick")


async def public_view(db: AsyncSession, settings: Settings, token: str) -> PublicShareOut:
    link, bill, split = await _resolve(db, token)
    out = await _view(db, settings, link, bill, split)
    await db.execute(update(ShareLink).where(ShareLink.id == link.id).values(last_viewed_at=datetime.now(UTC)))
    await db.commit()
    return out


class TooManyClaims(AppError):
    def __init__(self) -> None:
        super().__init__(429, "too_many_claims", "Too many payment updates on this link today. Try again tomorrow.")


async def public_claim(db: AsyncSession, settings: Settings, token: str, data: PublicClaimIn) -> PublicShareOut:
    """ "I've paid" for the person on a personal link, or the person picked on a group link. Always
    the full amount still owed; repeating it (same tap retried, or a second tap) changes nothing."""
    link, bill, split = await _resolve(db, token)
    if link.person_id is not None:
        person_id = link.person_id
    else:
        person_id = next((p.person_id for p in split.people
                          if data.person_key and hmac.compare_digest(person_key(settings, link.id, p.person_id),
                                                                     data.person_key)), None)
        if person_id is None:
            raise BadRequest("unknown_person", "That name isn't on this bill any more. Reload the page.")
    mine = next(p for p in split.people if p.person_id == person_id)

    repeat = await db.scalar(select(PaymentClaim.id).where(PaymentClaim.share_link_id == link.id,
                                                           PaymentClaim.client_key == data.client_key))
    open_claim = await db.scalar(select(PaymentClaim.id).where(PaymentClaim.bill_id == bill.id,
                                                               PaymentClaim.person_id == person_id,
                                                               PaymentClaim.status == "claimed"))
    if repeat is None and open_claim is None:
        if bill.status != "complete":
            raise Conflict("claims_closed", "The bill is still being edited. Try again in a little while.")
        if mine.is_payer:
            raise Conflict("is_payer", "The person who paid the bill doesn't owe anything.")
        if mine.outstanding_cents <= 0:
            raise Conflict("nothing_owed", "Nothing left to pay on this bill.")
        since = datetime.now(UTC) - timedelta(days=1)
        today = await db.scalar(select(func.count()).select_from(PaymentClaim).where(
            PaymentClaim.share_link_id == link.id, PaymentClaim.created_at > since))
        if (today or 0) >= CLAIMS_PER_LINK_PER_DAY:
            raise TooManyClaims()
        db.add(PaymentClaim(bill_id=bill.id, person_id=person_id, owner_id=bill.owner_id, share_link_id=link.id,
                            via="person_link" if link.person_id else "group_link",
                            amount_cents=mine.outstanding_cents, currency=split.effective_currency,
                            expected_total_cents=mine.effective_total_cents, client_key=data.client_key))
        try:
            await db.commit()
        except IntegrityError:  # a parallel tap won the race: theirs stands
            await db.rollback()
    return await _view(db, settings, link, bill, split)


async def public_withdraw(db: AsyncSession, settings: Settings, token: str, client_key: UUID) -> PublicShareOut:
    """Take back an "I've paid" that hasn't been confirmed yet (only from the same link)."""
    link, bill, split = await _resolve(db, token)
    await db.execute(update(PaymentClaim).where(
        PaymentClaim.share_link_id == link.id, PaymentClaim.client_key == client_key,
        PaymentClaim.status == "claimed").values(status="withdrawn", decided_at=datetime.now(UTC)))
    await db.commit()
    return await _view(db, settings, link, bill, split)
