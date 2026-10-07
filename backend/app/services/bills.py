"""Bill orchestration: create/list/patch/delete, receipt, participants, assignments,
quick split and settle-up. Every mutation returns the full ``BillOut`` (with the
derived split) so the client can re-render from one response."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import delete, exists, insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.receipt_validation import ReceiptCharge, ReceiptItem, infer_charge_kind, validate_receipt
from app.errors import BadRequest, Conflict, NotFound
from app.middleware.auth import CurrentUser
from app.models import Bill, BillCharge, BillItem, BillParticipant, ItemShare, ShareLink
from app.models.scan import ReceiptFile
from app.pagination import decode_cursor, encode_cursor
from app.repositories import bills as bills_repo
from app.repositories import people as people_repo
from app.repositories import scans as scans_repo
from app.schemas.bills import (
    AssignmentsIn,
    BillCreate,
    BillOut,
    BillPatch,
    BillSummaryOut,
    ChargeOut,
    FileOut,
    ItemOut,
    JobBrief,
    ParticipantOut,
    ParticipantsIn,
    QuickSplitIn,
    ReceiptIn,
    ShareOut,
)
from app.schemas.common import Page
from app.services.people import ensure_self
from app.services.split_view import compute_bill_split, effective_payer, split_out, validate_bill, validation_out


def _now() -> datetime:
    return datetime.now(UTC)


async def load_bill(db: AsyncSession, owner_id: UUID, bill_id: UUID, *, for_update: bool = False) -> Bill:
    bill = await bills_repo.get_bill(db, owner_id, bill_id, full=True, for_update=for_update)
    if bill is None:
        raise NotFound("Bill")
    return bill


async def bill_out(db: AsyncSession, bill: Bill) -> BillOut:
    validation = validate_bill(bill)
    job = await scans_repo.latest_job(db, bill.id)
    files = await scans_repo.files_for_bill(db, bill.id)
    now = _now()
    return BillOut(
        id=bill.id, title=bill.title, merchant=bill.merchant, bill_date=bill.bill_date, currency=bill.currency,
        status=bill.status, source=bill.source, payer_person_id=effective_payer(bill),
        subtotal_cents=bill.subtotal_cents, grand_total_cents=bill.grand_total_cents,
        tax_scenario=bill.tax_scenario, receipt_meta=bill.receipt_meta or {},
        created_at=bill.created_at, updated_at=bill.updated_at,
        items=[ItemOut(id=i.id, position=i.position, name=i.name, quantity=i.quantity,
                       unit_price_cents=i.unit_price_cents, total_price_cents=i.total_price_cents,
                       split_mode=i.split_mode,
                       shares=[ShareOut(person_id=s.person_id, weight=s.weight, amount_cents=s.amount_cents)
                               for s in i.shares])
               for i in bill.items],
        charges=[ChargeOut.model_validate(c) for c in bill.charges],
        participants=[ParticipantOut(person_id=p.person_id, name=p.person.name, color_seed=p.person.color_seed,
                                     is_self=p.person.is_self, position=p.position, settled_at=p.settled_at,
                                     settled_amount_cents=p.settled_amount_cents)
                      for p in bill.participants],
        validation=validation_out(validation, [i.id for i in bill.items]) if validation else None,
        split=split_out(bill),
        latest_job=JobBrief(id=job.id, status=job.status, error_code=job.error_code, retryable=job.retryable)
        if job else None,
        files=[FileOut(id=f.id, job_id=f.job_id, mime=f.mime, bytes=f.bytes, pages=f.pages, position=f.position,
                       created_at=f.created_at, expires_at=f.expires_at,
                       available=f.deleted_at is None and f.expires_at > now)
               for f in files],
    )


async def _reload_out(db: AsyncSession, owner_id: UUID, bill_id: UUID) -> BillOut:
    db.expunge_all()
    return await bill_out(db, await load_bill(db, owner_id, bill_id))


# ---------------------------------------------------------------------------- CRUD
async def create_bill(db: AsyncSession, user: CurrentUser, data: BillCreate) -> BillOut:
    me = await ensure_self(db, user.id, user.display_name)
    bill = Bill(owner_id=user.id, title=data.title, merchant=data.merchant, bill_date=data.bill_date,
                currency=data.currency or user.default_currency, source=data.source, status="draft",
                payer_person_id=me.id, receipt_meta={})
    db.add(bill)
    await db.flush()
    db.add(BillParticipant(bill_id=bill.id, person_id=me.id, position=0))
    me.last_used_at = _now()
    await db.commit()
    return await _reload_out(db, user.id, bill.id)


async def get_bill(db: AsyncSession, user: CurrentUser, bill_id: UUID) -> BillOut:
    return await bill_out(db, await load_bill(db, user.id, bill_id))


async def list_bills(db: AsyncSession, user: CurrentUser, statuses: list[str] | None, limit: int,
                     cursor: str | None) -> Page[BillSummaryOut]:
    after = None
    if cursor:
        created_at, bill_id = decode_cursor(cursor, 2)
        if not isinstance(created_at, datetime) or not isinstance(bill_id, UUID):
            raise BadRequest("invalid_cursor", "The pagination cursor is invalid.")
        after = (created_at, bill_id)
    rows = await bills_repo.list_bills(db, user.id, statuses=statuses, limit=limit + 1, after=after)
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [BillSummaryOut(id=b.id, title=b.title, merchant=b.merchant, bill_date=b.bill_date, currency=b.currency,
                            status=b.status, source=b.source, grand_total_cents=b.grand_total_cents,
                            participant_count=pc, unsettled_count=uc, created_at=b.created_at,
                            updated_at=b.updated_at)
             for b, pc, uc in rows]
    next_cursor = encode_cursor(rows[-1][0].created_at, rows[-1][0].id) if has_more and rows else None
    return Page[BillSummaryOut](items=items, next_cursor=next_cursor)


async def patch_bill(db: AsyncSession, user: CurrentUser, bill_id: UUID, data: BillPatch) -> BillOut:
    bill = await load_bill(db, user.id, bill_id, for_update=True)
    fields = data.model_fields_set
    if "status" in fields and data.status is not None:
        if bill.status == "scanning":
            raise Conflict("scan_in_progress", "Wait for the scan to finish (or cancel it) first.")
        bill.status = data.status
    for name in ("title", "merchant", "bill_date"):
        if name in fields:
            setattr(bill, name, getattr(data, name))
    if "currency" in fields and data.currency is not None:
        bill.currency = data.currency
    if "payer_person_id" in fields:
        if data.payer_person_id is not None and data.payer_person_id not in {p.person_id for p in bill.participants}:
            raise BadRequest("payer_not_participant", "The payer must be one of the people on this bill.")
        bill.payer_person_id = data.payer_person_id
    bill.updated_at = _now()
    await db.commit()
    return await _reload_out(db, user.id, bill_id)


async def delete_bill(db: AsyncSession, user: CurrentUser, bill_id: UUID) -> UUID | None:
    """Soft delete. Share links are revoked, photos are queued for purge. Returns an
    active job id (if any) so the caller can cancel it."""
    bill = await bills_repo.get_bill(db, user.id, bill_id, for_update=True)
    if bill is None:
        raise NotFound("Bill")
    now = _now()
    bill.deleted_at = now
    await db.execute(update(ShareLink).where(ShareLink.bill_id == bill_id, ShareLink.revoked_at.is_(None))
                     .values(revoked_at=now))
    await db.execute(update(ReceiptFile).where(ReceiptFile.bill_id == bill_id, ReceiptFile.deleted_at.is_(None))
                     .values(expires_at=now))
    active = await scans_repo.active_job_for_bill(db, bill_id)
    await db.commit()
    return active.id if active else None


# ---------------------------------------------------------------------------- receipt
@dataclass(frozen=True)
class ItemSpec:
    id: UUID | None
    name: str
    quantity: Decimal
    unit_price_cents: int
    total_price_cents: int


@dataclass(frozen=True)
class ChargeSpec:
    name: str
    amount_cents: int
    kind: str | None = None


async def replace_receipt(db: AsyncSession, bill: Bill, items: list[ItemSpec], charges: list[ChargeSpec],
                          subtotal_cents: int | None, grand_total_cents: int | None) -> None:
    """Write items/charges/totals in place (single write path for manual edits and scans).
    Items whose ``id`` matches keep their assignment; missing items are deleted."""
    existing = {i.id: i for i in bill.items}
    keep_ids = {s.id for s in items if s.id is not None}
    unknown = keep_ids - existing.keys()
    if unknown:
        raise BadRequest("unknown_item", "One of the items doesn't belong to this bill.")
    drop = [iid for iid in existing if iid not in keep_ids]
    if drop:
        await db.execute(delete(BillItem).where(BillItem.id.in_(drop)).execution_options(synchronize_session=False))
    for pos, spec in enumerate(items):
        if spec.id is not None:
            row = existing[spec.id]
            row.position, row.name, row.quantity = pos, spec.name, spec.quantity
            row.unit_price_cents, row.total_price_cents = spec.unit_price_cents, spec.total_price_cents
        else:
            db.add(BillItem(bill_id=bill.id, position=pos, name=spec.name, quantity=spec.quantity,
                            unit_price_cents=spec.unit_price_cents, total_price_cents=spec.total_price_cents))
    await db.execute(delete(BillCharge).where(BillCharge.bill_id == bill.id)
                     .execution_options(synchronize_session=False))
    bill.subtotal_cents = subtotal_cents if subtotal_cents else None
    bill.grand_total_cents = grand_total_cents
    await db.flush()

    # Validate what is now stored to derive the scenario + display percentages.
    result = validate_receipt(
        [ReceiptItem(s.name, s.quantity, s.unit_price_cents, s.total_price_cents) for s in items],
        [ReceiptCharge(c.name, c.amount_cents) for c in charges],
        grand_total_cents, bill.subtotal_cents,
    )
    for pos, (spec, pct) in enumerate(zip(charges, result.charge_percents, strict=True)):
        db.add(BillCharge(bill_id=bill.id, position=pos, name=spec.name, amount_cents=spec.amount_cents,
                          kind=spec.kind or infer_charge_kind(spec.name, spec.amount_cents), percent=pct))
    bill.tax_scenario = result.tax_scenario if result.ok else None
    bill.updated_at = _now()


async def put_receipt(db: AsyncSession, user: CurrentUser, bill_id: UUID, data: ReceiptIn) -> BillOut:
    bill = await load_bill(db, user.id, bill_id, for_update=True)
    if bill.status == "scanning":
        raise Conflict("scan_in_progress", "Wait for the scan to finish (or cancel it) first.")
    await replace_receipt(
        db, bill,
        [ItemSpec(i.id, i.name, i.quantity, i.unit_price_cents, i.total_price_cents) for i in data.items],
        [ChargeSpec(c.name, c.amount_cents, c.kind) for c in data.charges],
        data.subtotal_cents, data.grand_total_cents,
    )
    if "merchant" in data.model_fields_set:
        bill.merchant = data.merchant
    if "bill_date" in data.model_fields_set:
        bill.bill_date = data.bill_date
    await db.commit()
    return await _reload_out(db, user.id, bill_id)


# ---------------------------------------------------------------------------- people on the bill
async def _set_participants(db: AsyncSession, user: CurrentUser, bill: Bill, person_ids: list[UUID]) -> None:
    people = await people_repo.get_people(db, user.id, person_ids)
    if len(people) != len(person_ids):
        raise BadRequest("unknown_person", "One of the people doesn't exist.")
    current = {p.person_id: p for p in bill.participants}
    new_ids = [pid for pid in person_ids if pid not in current]
    if any(people[pid].archived_at is not None for pid in new_ids):
        raise BadRequest("person_archived", "That person was removed from your people list.")
    removed = [pid for pid in current if pid not in set(person_ids)]
    if removed:
        await db.execute(delete(BillParticipant).where(BillParticipant.bill_id == bill.id,
                                                       BillParticipant.person_id.in_(removed))
                         .execution_options(synchronize_session=False))
        if bill.payer_person_id in removed:
            bill.payer_person_id = None
    for pos, pid in enumerate(person_ids):
        if pid in current:
            current[pid].position = pos
        else:
            db.add(BillParticipant(bill_id=bill.id, person_id=pid, position=pos))
    await db.flush()
    if removed:
        # Items left without anyone become unassigned.
        await db.execute(
            update(BillItem)
            .where(BillItem.bill_id == bill.id, BillItem.split_mode.is_not(None),
                   ~exists().where(ItemShare.item_id == BillItem.id))
            .values(split_mode=None)
            .execution_options(synchronize_session=False)
        )
    await people_repo.touch_used(db, user.id, new_ids, _now())
    bill.updated_at = _now()


async def put_participants(db: AsyncSession, user: CurrentUser, bill_id: UUID, data: ParticipantsIn) -> BillOut:
    bill = await load_bill(db, user.id, bill_id, for_update=True)
    await _set_participants(db, user, bill, data.person_ids)
    await db.commit()
    return await _reload_out(db, user.id, bill_id)


async def put_assignments(db: AsyncSession, user: CurrentUser, bill_id: UUID, data: AssignmentsIn) -> BillOut:
    bill = await load_bill(db, user.id, bill_id, for_update=True)
    items = {i.id: i for i in bill.items}
    participants = {p.person_id for p in bill.participants}
    for a in data.assignments:
        if a.item_id not in items:
            raise BadRequest("unknown_item", "One of the items doesn't belong to this bill.")
        if any(s.person_id not in participants for s in a.shares):
            raise BadRequest("not_a_participant", "Add the person to the bill before assigning items to them.")
    rows: list[dict[str, Any]] = []
    for a in data.assignments:
        items[a.item_id].split_mode = a.mode
        for pos, s in enumerate(a.shares):
            rows.append({
                "item_id": a.item_id, "bill_id": bill.id, "person_id": s.person_id, "position": pos,
                "weight": Decimal(1) if a.mode == "equal" else (s.weight if a.mode == "weighted" else None),
                "amount_cents": s.amount_cents if a.mode == "custom" else None,
            })
    # Core statements (not session.add) so stale share objects in the identity map never clash.
    await db.execute(delete(ItemShare).where(ItemShare.item_id.in_([a.item_id for a in data.assignments]))
                     .execution_options(synchronize_session=False))
    if rows:
        await db.execute(insert(ItemShare), rows)
    bill.updated_at = _now()
    await db.commit()
    return await _reload_out(db, user.id, bill_id)


async def put_quick(db: AsyncSession, user: CurrentUser, bill_id: UUID, data: QuickSplitIn) -> BillOut:
    """Quick split = one synthetic item ("Total") shared equally or by shares."""
    bill = await load_bill(db, user.id, bill_id, for_update=True)
    if bill.status == "scanning":
        raise Conflict("scan_in_progress", "Wait for the scan to finish (or cancel it) first.")
    person_ids = [p.person_id for p in data.participants]
    await db.execute(delete(BillItem).where(BillItem.bill_id == bill.id).execution_options(synchronize_session=False))
    await db.execute(delete(BillCharge).where(BillCharge.bill_id == bill.id)
                     .execution_options(synchronize_session=False))
    await _set_participants(db, user, bill, person_ids)
    item = BillItem(bill_id=bill.id, position=0, name=data.title or "Total", quantity=Decimal(1),
                    unit_price_cents=data.total_cents, total_price_cents=data.total_cents,
                    split_mode="equal" if data.mode == "equal" else "weighted")
    db.add(item)
    await db.flush()
    await db.execute(insert(ItemShare), [
        {"item_id": item.id, "bill_id": bill.id, "person_id": p.person_id, "position": pos,
         "weight": Decimal(1) if data.mode == "equal" else p.weight, "amount_cents": None}
        for pos, p in enumerate(data.participants)
    ])
    bill.source = "quick"
    bill.subtotal_cents = None
    bill.grand_total_cents = data.total_cents
    bill.tax_scenario = "no_taxes"
    if data.title is not None:
        bill.title = data.title
    bill.updated_at = _now()
    await db.commit()
    return await _reload_out(db, user.id, bill_id)


# ---------------------------------------------------------------------------- settle-up
async def settle(db: AsyncSession, user: CurrentUser, bill_id: UUID, person_id: UUID,
                 amount_cents: int | None) -> BillOut:
    bill = await load_bill(db, user.id, bill_id, for_update=True)
    part = next((p for p in bill.participants if p.person_id == person_id), None)
    if part is None:
        raise NotFound("Participant")
    if effective_payer(bill) == person_id:
        raise Conflict("is_payer", "The payer doesn't owe anything on this bill.")
    if amount_cents is None:
        result = compute_bill_split(bill).person(str(person_id))
        amount_cents = result.total_cents if result else 0
    if part.settled_at is None or part.settled_amount_cents != amount_cents:  # idempotent repeat = no-op
        part.settled_at = _now()
        part.settled_amount_cents = amount_cents
        bill.updated_at = _now()
        await db.commit()
    return await _reload_out(db, user.id, bill_id)


async def unsettle(db: AsyncSession, user: CurrentUser, bill_id: UUID, person_id: UUID) -> BillOut:
    bill = await load_bill(db, user.id, bill_id, for_update=True)
    part = next((p for p in bill.participants if p.person_id == person_id), None)
    if part is None:
        raise NotFound("Participant")
    if part.settled_at is not None:
        part.settled_at = None
        part.settled_amount_cents = None
        bill.updated_at = _now()
        await db.commit()
    return await _reload_out(db, user.id, bill_id)


def parse_bill_date(value: Any) -> date | None:
    if not value or not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None

