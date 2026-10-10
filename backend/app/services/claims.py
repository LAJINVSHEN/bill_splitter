"""The owner's side of "I've paid": confirm (writes the settlement), not yet, confirm all, and the
list of claims waiting across bills. The settlement stays the single source of truth for balances."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import Conflict, NotFound
from app.middleware.auth import CurrentUser
from app.models import Bill, PaymentClaim, Person
from app.schemas.bills import BillOut, ClaimOut
from app.schemas.me import InboxClaim, InboxOut


def _now() -> datetime:
    return datetime.now(UTC)


async def open_claims(db: AsyncSession, bill_id: UUID) -> list[ClaimOut]:
    rows = await db.scalars(select(PaymentClaim).where(PaymentClaim.bill_id == bill_id,
                                                       PaymentClaim.status == "claimed")
                            .order_by(PaymentClaim.created_at))
    return [ClaimOut(id=c.id, person_id=c.person_id, amount_cents=c.amount_cents, currency=c.currency,
                     expected_total_cents=c.expected_total_cents, via=c.via, created_at=c.created_at) for c in rows]


async def count_open(db: AsyncSession, owner_id: UUID) -> int:
    n = await db.scalar(select(func.count()).select_from(PaymentClaim).join(Bill, Bill.id == PaymentClaim.bill_id)
                        .where(PaymentClaim.owner_id == owner_id, PaymentClaim.status == "claimed",
                               Bill.deleted_at.is_(None)))
    return n or 0


async def inbox(db: AsyncSession, user: CurrentUser) -> InboxOut:
    rows = await db.execute(
        select(PaymentClaim, Bill.title, Bill.merchant, Bill.bill_date, Person.name, Person.color_seed)
        .join(Bill, Bill.id == PaymentClaim.bill_id)
        .join(Person, Person.id == PaymentClaim.person_id)
        .where(PaymentClaim.owner_id == user.id, PaymentClaim.status == "claimed", Bill.deleted_at.is_(None))
        .order_by(PaymentClaim.created_at.desc())
    )
    return InboxOut(items=[
        InboxClaim(id=c.id, bill_id=c.bill_id, bill_title=(title or merchant or "Untitled bill"), bill_date=bill_date,
                   person_id=c.person_id, person_name=name, color_seed=seed, amount_cents=c.amount_cents,
                   currency=c.currency, expected_total_cents=c.expected_total_cents, created_at=c.created_at)
        for c, title, merchant, bill_date, name, seed in rows.all()
    ])


async def supersede(db: AsyncSession, bill_id: UUID, person_id: UUID) -> None:
    """The owner marked them paid directly: an open claim has nothing left to decide."""
    await db.execute(update(PaymentClaim).where(PaymentClaim.bill_id == bill_id, PaymentClaim.person_id == person_id,
                                                PaymentClaim.status == "claimed")
                     .values(status="superseded", decided_at=_now()))


async def revert(db: AsyncSession, bill_id: UUID, person_id: UUID) -> None:
    """The owner undid the settlement: confirmed claims no longer stand."""
    await db.execute(update(PaymentClaim).where(PaymentClaim.bill_id == bill_id, PaymentClaim.person_id == person_id,
                                                PaymentClaim.status == "confirmed")
                     .values(status="reverted", decided_at=_now()))


async def _confirm_one(db: AsyncSession, bill: Bill, claim: PaymentClaim, amount_cents: int | None) -> None:
    part = next((p for p in bill.participants if p.person_id == claim.person_id), None)
    if part is None:  # removed from the bill (the cascade normally takes the claim with them)
        raise NotFound("Participant")
    part.settled_amount_cents = (part.settled_amount_cents or 0) + (amount_cents or claim.amount_cents)
    part.settled_at = _now()
    claim.status, claim.decided_at = "confirmed", _now()
    bill.updated_at = _now()


async def _claim(db: AsyncSession, user: CurrentUser, bill_id: UUID, claim_id: UUID) -> PaymentClaim:
    claim = await db.scalar(select(PaymentClaim).where(PaymentClaim.id == claim_id, PaymentClaim.bill_id == bill_id,
                                                       PaymentClaim.owner_id == user.id).with_for_update())
    if claim is None:
        raise NotFound("Claim")
    return claim


async def confirm(db: AsyncSession, user: CurrentUser, bill_id: UUID, claim_id: UUID,
                  amount_cents: int | None) -> BillOut:
    from app.services.bills import _reload_out, load_bill

    bill = await load_bill(db, user.id, bill_id, for_update=True)
    claim = await _claim(db, user, bill_id, claim_id)
    if claim.status == "claimed":
        await _confirm_one(db, bill, claim, amount_cents)
        await db.commit()
    elif claim.status != "confirmed":  # confirming twice is fine; anything else was decided otherwise
        raise Conflict("claim_closed", "This payment was already handled.")
    return await _reload_out(db, user.id, bill_id)


async def reject(db: AsyncSession, user: CurrentUser, bill_id: UUID, claim_id: UUID) -> BillOut:
    from app.services.bills import _reload_out, load_bill

    await load_bill(db, user.id, bill_id, for_update=True)
    claim = await _claim(db, user, bill_id, claim_id)
    if claim.status == "claimed":
        claim.status, claim.decided_at = "rejected", _now()
        await db.commit()
    elif claim.status != "rejected":
        raise Conflict("claim_closed", "This payment was already handled.")
    return await _reload_out(db, user.id, bill_id)


async def confirm_all(db: AsyncSession, user: CurrentUser, bill_id: UUID) -> BillOut:
    from app.services.bills import _reload_out, load_bill

    bill = await load_bill(db, user.id, bill_id, for_update=True)
    rows = (await db.scalars(select(PaymentClaim).where(PaymentClaim.bill_id == bill_id,
                                                        PaymentClaim.owner_id == user.id,
                                                        PaymentClaim.status == "claimed").with_for_update())).all()
    for claim in rows:
        await _confirm_one(db, bill, claim, None)
    if rows:
        await db.commit()
    return await _reload_out(db, user.id, bill_id)


async def has_open(db: AsyncSession, bill_id: UUID) -> bool:
    return bool(await db.scalar(select(PaymentClaim.id).where(PaymentClaim.bill_id == bill_id,
                                                              PaymentClaim.status == "claimed").limit(1)))

