"""Read-only share links. The 32-byte token is shown once; only its SHA-256 is stored."""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import BadRequest, NotFound
from app.middleware.auth import CurrentUser
from app.models import ShareLink
from app.repositories import bills as bills_repo
from app.schemas.share import (
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


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create_link(db: AsyncSession, settings: Settings, user: CurrentUser, bill_id: UUID,
                      data: ShareLinkCreate) -> ShareLinkCreated:
    bill = await bills_repo.get_bill(db, user.id, bill_id, full=True)
    if bill is None:
        raise NotFound("Bill")
    if data.person_id is not None and data.person_id not in {p.person_id for p in bill.participants}:
        raise BadRequest("not_a_participant", "That person isn't on this bill.")
    active = await db.scalars(select(ShareLink.id).where(ShareLink.bill_id == bill_id, ShareLink.revoked_at.is_(None)))
    if len(active.all()) >= MAX_LINKS_PER_BILL:
        raise BadRequest("too_many_links", "Revoke some links on this bill first.")
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


async def public_view(db: AsyncSession, token: str) -> PublicShareOut:
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

    def person(p) -> PublicPerson:  # noqa: ANN001
        return PublicPerson(name=p.name, is_payer=p.is_payer,
                            items=[PublicItem(name=i.name, share_cents=i.share_cents) for i in p.items],
                            items_cents=p.items_cents, adjustment_cents=p.adjustment_cents,
                            total_cents=p.total_cents, settle_total_cents=p.settle_total_cents,
                            settled=p.outstanding_cents == 0,
                            outstanding_cents=p.outstanding_cents)

    payer = next((p.name for p in split.people if p.is_payer), None)
    if link.person_id is not None:
        mine = next((p for p in split.people if p.person_id == link.person_id), None)
        if mine is None:  # person removed from the bill since the link was made
            raise NotFound("Share link")
        scoped, people = person(mine), []
    else:
        scoped, people = None, [person(p) for p in split.people]
    await db.execute(update(ShareLink).where(ShareLink.id == link.id).values(last_viewed_at=now))
    await db.commit()
    return PublicShareOut(title=bill.title, merchant=bill.merchant, bill_date=bill.bill_date, currency=bill.currency,
                          settle_currency=split.settle_currency, fx_rate=split.fx_rate,
                          effective_currency=split.effective_currency, grand_total_cents=split.grand_total_cents,
                          settle_grand_total_cents=split.settle_grand_total_cents, payer_name=payer,
                          scope="person" if link.person_id else "bill", person=scoped, people=people)
