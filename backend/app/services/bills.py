"""Bill orchestration: create/list/patch/delete, receipt, participants, assignments,
quick split and settle-up. Every mutation returns the full ``BillOut`` (with the
derived split) so the client can re-render from one response."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import BigInteger, Numeric, cast, delete, exists, func, insert, literal, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.currencies import exponent
from app.core.money import round_half_up
from app.core.receipt_validation import ReceiptCharge, ReceiptItem, infer_charge_kind, validate_receipt
from app.errors import BadRequest, Conflict, NotFound
from app.middleware.auth import CurrentUser
from app.models import Bill, BillCharge, BillItem, BillParticipant, ItemShare, ShareLink
from app.models.scan import ACTIVE_JOB_STATUSES, ExtractionJob, OcrCache, ReceiptFile
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
from app.services import fx
from app.services.container import Services
from app.services.people import ensure_self
from app.services.split_view import effective_currency, effective_payer, split_out, validate_bill, validation_out


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
        tax_scenario=bill.tax_scenario, settle_currency=bill.settle_currency, fx_rate=bill.fx_rate,
        effective_currency=effective_currency(bill), currency_locked=currency_locked(bill),
        receipt_meta=bill.receipt_meta or {},
        created_at=bill.created_at, updated_at=bill.updated_at,
        items=[ItemOut(id=i.id, position=i.position, name=i.name, details=i.details, quantity=i.quantity,
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
        latest_job=JobBrief(id=job.id, status=job.status, error_code=job.error_code, retryable=job.retryable,
                            detected_currency=job.detected_currency) if job else None,
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
                     cursor: str | None, *, settled: bool | None = None) -> Page[BillSummaryOut]:
    after = None
    if cursor:
        created_at, bill_id = decode_cursor(cursor, 2)
        if not isinstance(created_at, datetime) or not isinstance(bill_id, UUID):
            raise BadRequest("invalid_cursor", "The pagination cursor is invalid.")
        after = (created_at, bill_id)
    if settled is not None:
        if statuses and "complete" not in statuses:
            return Page[BillSummaryOut](items=[], next_cursor=None)
        statuses = ["complete"]
    items: list[BillSummaryOut] = []
    while len(items) <= limit:
        rows = await bills_repo.list_bills(db, user.id, statuses=statuses, limit=limit + 1, after=after)
        for bill in rows:
            split = split_out(bill)
            unsettled_count = sum(person.outstanding_cents > 0 for person in split.people)
            if settled is not None and (unsettled_count == 0) != settled:
                continue
            validation = validate_bill(bill)
            items.append(BillSummaryOut(
                id=bill.id, title=bill.title, merchant=bill.merchant, bill_date=bill.bill_date,
                currency=bill.currency, status=bill.status, source=bill.source,
                grand_total_cents=bill.grand_total_cents, settle_currency=bill.settle_currency,
                participant_count=len(bill.participants), unsettled_count=unsettled_count,
                participant_names=["You" if person.is_self else person.name for person in split.people],
                unassigned_item_count=len(split.unassigned_item_ids),
                price_issue_count=len(validation.warnings) if validation else 0,
                validation_issue_count=len(validation.errors) if validation else 0,
                created_at=bill.created_at, updated_at=bill.updated_at,
            ))
            if len(items) > limit:
                break
        if len(items) > limit or len(rows) < limit + 1:
            break
        after = (rows[-1].created_at, rows[-1].id)
    has_more = len(items) > limit
    items = items[:limit]
    next_cursor = encode_cursor(items[-1].created_at, items[-1].id) if has_more else None
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
    await _apply_currency_changes(db, user, bill, data, fields)
    if "payer_person_id" in fields:
        if data.payer_person_id is not None and data.payer_person_id not in {p.person_id for p in bill.participants}:
            raise BadRequest("payer_not_participant", "The payer must be one of the people on this bill.")
        bill.payer_person_id = data.payer_person_id
    bill.updated_at = _now()
    await db.commit()
    return await _reload_out(db, user.id, bill_id)


async def delete_bill(db: AsyncSession, user: CurrentUser, bill_id: UUID, services: Services,
                      *, permanent: bool = False) -> None:
    owned = await db.scalar(select(Bill.id).where(Bill.owner_id == user.id, Bill.id == bill_id))
    if owned is None:
        raise NotFound("Bill")
    await _delete_bills(db, user, services, [owned], permanent=permanent)


async def clear_bills(db: AsyncSession, user: CurrentUser, services: Services, *, permanent: bool = False,
                      person_id: UUID | None = None) -> None:
    stmt = select(Bill.id).where(Bill.owner_id == user.id)
    if person_id is not None:
        if await people_repo.get_person(db, user.id, person_id) is None:
            raise NotFound("Person")
        stmt = stmt.where(Bill.id.in_(people_repo.referencing_bill_ids([person_id])))
    ids = list((await db.scalars(stmt)).all())
    await _delete_bills(db, user, services, ids, permanent=permanent)


async def _delete_bills(db: AsyncSession, user: CurrentUser, services: Services, ids: list[UUID],
                        *, permanent: bool) -> None:
    """Purge history only after stopping workers. Tombstones retain the photo purge
    queue and job/usage accounting; none of these can be reopened as a bill."""
    now = _now()
    bill_ids = select(Bill.id).where(Bill.owner_id == user.id, Bill.id.in_(ids))
    await db.execute(update(Bill).where(Bill.id.in_(bill_ids), Bill.deleted_at.is_(None))
                     .values(deleted_at=now))
    await db.execute(update(ShareLink).where(ShareLink.bill_id.in_(bill_ids), ShareLink.revoked_at.is_(None))
                     .values(revoked_at=now))
    await db.execute(update(ReceiptFile).where(ReceiptFile.bill_id.in_(bill_ids), ReceiptFile.deleted_at.is_(None))
                     .values(expires_at=now))
    await db.commit()
    job_ids = list((await db.scalars(select(ExtractionJob.id).where(
        ExtractionJob.owner_id == user.id, ExtractionJob.bill_id.in_(bill_ids),
    ))).all())
    await db.execute(update(ExtractionJob).where(
        ExtractionJob.id.in_(job_ids), ExtractionJob.status.in_(ACTIVE_JOB_STATUSES),
    ).values(status="cancelled", error_code="cancelled", error_message="Bill deleted.", retryable=False,
             finished_at=now, pages_reserved=0))
    await db.commit()
    for job_id in job_ids:
        await services.runner.cancel(job_id)
    if any(services.runner.is_running(job_id) for job_id in job_ids):
        raise Conflict("scan_stopping", "The bill is hidden, but a scan is still stopping. Retry deletion shortly.")
    if permanent:
        await db.execute(delete(BillItem).where(BillItem.bill_id.in_(bill_ids)))
        await db.execute(delete(BillCharge).where(BillCharge.bill_id.in_(bill_ids)))
        await db.execute(delete(BillParticipant).where(BillParticipant.bill_id.in_(bill_ids)))
        await db.execute(delete(ShareLink).where(ShareLink.bill_id.in_(bill_ids)))
        await db.execute(update(Bill).where(Bill.id.in_(bill_ids)).values(
            title=None, merchant=None, bill_date=None, payer_person_id=None, subtotal_cents=None,
            grand_total_cents=None, tax_scenario=None, receipt_meta={}, settle_currency=None, fx_rate=None,
        ))
        await db.execute(update(ExtractionJob).where(ExtractionJob.id.in_(job_ids)).values(
            ocr_text=None, extracted=None, validation=None, detected_currency=None, error_message=None,
            retryable=False, pages_reserved=0,
        ))
        await _purge_ocr_cache(db, user.id, bill_ids)
        await db.commit()


async def _purge_ocr_cache(db: AsyncSession, owner_id: UUID, bill_ids: Any) -> None:
    """Erase cached OCR text of the purged bills' photos. A photo that another live bill of
    the same owner still uses keeps its cache (that bill's receipt can still be re-read)."""
    purged = select(ReceiptFile.sha256).where(ReceiptFile.bill_id.in_(bill_ids))
    still_used = (select(ReceiptFile.sha256).join(Bill, Bill.id == ReceiptFile.bill_id)
                  .where(ReceiptFile.owner_id == owner_id, Bill.deleted_at.is_(None),
                         ReceiptFile.bill_id.not_in(bill_ids)))
    await db.execute(delete(OcrCache).where(
        OcrCache.owner_id == owner_id, OcrCache.content_sha256.in_(purged),
        OcrCache.content_sha256.not_in(still_used),
    ).execution_options(synchronize_session=False))


def currency_locked(bill: Bill) -> bool:
    """Currency and conversion are frozen once anyone has settled (like "currency locked once
    payments exist"): settlements are recorded in the effective currency."""
    return any(p.settled_at is not None for p in bill.participants)


def _rescaled(value: int | None, factor: Decimal) -> int | None:
    return None if value is None else round_half_up(Decimal(value) * factor)


async def _rescale_amounts(db: AsyncSession, bill: Bill, old: str, new: str) -> None:
    """Relabel a bill's amounts to another currency: the major-unit values stay the same, the
    minor units are rescaled when exponents differ (×10^k up, ROUND_HALF_UP down)."""
    shift = exponent(new) - exponent(old)
    if shift == 0:
        return
    factor = Decimal(1).scaleb(shift)

    def scaled(col):  # noqa: ANN001, ANN202 - SQL expression
        return cast(func.round(col * literal(factor, Numeric)), BigInteger)

    await db.execute(update(BillItem).where(BillItem.bill_id == bill.id).values(
        unit_price_cents=scaled(BillItem.unit_price_cents), total_price_cents=scaled(BillItem.total_price_cents),
    ).execution_options(synchronize_session=False))
    await db.execute(update(BillCharge).where(BillCharge.bill_id == bill.id).values(
        amount_cents=scaled(BillCharge.amount_cents)).execution_options(synchronize_session=False))
    await db.execute(update(ItemShare).where(ItemShare.bill_id == bill.id, ItemShare.amount_cents.is_not(None)).values(
        amount_cents=scaled(ItemShare.amount_cents)).execution_options(synchronize_session=False))
    bill.subtotal_cents = _rescaled(bill.subtotal_cents, factor)
    bill.grand_total_cents = _rescaled(bill.grand_total_cents, factor)


async def _apply_currency_changes(db: AsyncSession, user: CurrentUser, bill: Bill, data: BillPatch,
                                  fields: set[str]) -> None:
    new_currency = data.currency if "currency" in fields and data.currency else bill.currency
    changes_currency = new_currency != bill.currency
    changes_conversion = ("settle_currency" in fields and data.settle_currency != bill.settle_currency) or (
        "fx_rate" in fields and data.fx_rate is not None and data.fx_rate != bill.fx_rate)
    if not (changes_currency or changes_conversion or data.save_rate):
        return
    if changes_currency or changes_conversion:
        if bill.status == "scanning":
            raise Conflict("scan_in_progress", "Wait for the scan to finish (or cancel it) first.")
        if currency_locked(bill):
            raise Conflict("currency_locked", "Someone has already settled up, so the currency can't change. "
                                              "Undo their settlement first.")
    if changes_currency:
        await _rescale_amounts(db, bill, bill.currency, new_currency)
        bill.currency = new_currency
        if "settle_currency" not in fields:  # the old rate was for another pair
            bill.settle_currency = bill.fx_rate = None

    if "settle_currency" in fields:
        if data.settle_currency is None:
            bill.settle_currency = bill.fx_rate = None
        else:
            if data.settle_currency == bill.currency:
                raise BadRequest("settle_same_currency", "Pick a different currency to settle in.")
            rate = data.fx_rate
            if rate is None:
                saved = await fx.lookup(db, user.id, bill.currency, data.settle_currency)
                if saved is None:
                    raise BadRequest("fx_rate_required",
                                     f"Enter a rate: 1 {bill.currency} = ? {data.settle_currency}.")
                rate = saved.rate
            bill.settle_currency, bill.fx_rate = data.settle_currency, rate  # snapshot
    elif "fx_rate" in fields and data.fx_rate is not None:
        if bill.settle_currency is None:
            raise BadRequest("settle_currency_required", "Choose the currency to settle in first.")
        bill.fx_rate = data.fx_rate

    if data.save_rate and bill.settle_currency and bill.fx_rate:
        await fx.save_rate(db, user.id, bill.currency, bill.settle_currency, bill.fx_rate)


# ---------------------------------------------------------------------------- receipt
@dataclass(frozen=True)
class ItemSpec:
    id: UUID | None
    name: str
    quantity: Decimal
    unit_price_cents: int
    total_price_cents: int
    details: str | None = None


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
            row.details = spec.details
        else:
            db.add(BillItem(bill_id=bill.id, position=pos, name=spec.name, quantity=spec.quantity,
                            unit_price_cents=spec.unit_price_cents, total_price_cents=spec.total_price_cents,
                            details=spec.details))
    await db.execute(delete(BillCharge).where(BillCharge.bill_id == bill.id)
                     .execution_options(synchronize_session=False))
    bill.subtotal_cents = subtotal_cents if subtotal_cents else None
    bill.grand_total_cents = grand_total_cents
    await db.flush()

    # Validate what is now stored to derive the scenario + display percentages.
    result = validate_receipt(
        [ReceiptItem(s.name, s.quantity, s.unit_price_cents, s.total_price_cents) for s in items],
        [ReceiptCharge(c.name, c.amount_cents) for c in charges],
        grand_total_cents, bill.subtotal_cents, exponent(bill.currency),
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
    stored = {i.id: i.details for i in bill.items}
    await replace_receipt(
        db, bill,
        # An existing item keeps its folded details unless the client sends the field.
        [ItemSpec(i.id, i.name, i.quantity, i.unit_price_cents, i.total_price_cents,
                  i.details if "details" in i.model_fields_set or i.id is None else stored.get(i.id))
         for i in data.items],
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
    if amount_cents is None:  # everything they owe, in the bill's effective currency
        mine = next((p for p in split_out(bill).people if p.person_id == person_id), None)
        amount_cents = mine.effective_total_cents if mine else 0
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

