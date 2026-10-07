from __future__ import annotations

from typing import Annotated, get_args
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.errors import BadRequest
from app.middleware.auth import CurrentUserDep
from app.schemas.bills import (
    AssignmentsIn,
    BillCreate,
    BillOut,
    BillPatch,
    BillStatus,
    BillSummaryOut,
    ParticipantsIn,
    QuickSplitIn,
    ReceiptIn,
    SettlementIn,
    SplitOut,
)
from app.schemas.common import Page
from app.services import bills as svc
from app.services.container import ServicesDep

router = APIRouter(prefix="/bills", tags=["bills"])
DB = Annotated[AsyncSession, Depends(get_db)]
_STATUSES = set(get_args(BillStatus))


@router.get("", response_model=Page[BillSummaryOut])
async def list_bills(
    user: CurrentUserDep,
    db: DB,
    status: Annotated[str | None, Query(description="Comma-separated statuses, e.g. draft,review")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> Page[BillSummaryOut]:
    statuses = [s.strip() for s in status.split(",") if s.strip()] if status else None
    if statuses and not set(statuses) <= _STATUSES:
        raise BadRequest("invalid_status", f"status must be one of {sorted(_STATUSES)}")
    return await svc.list_bills(db, user, statuses, limit, cursor)


@router.post("", response_model=BillOut, status_code=201)
async def create_bill(data: BillCreate, user: CurrentUserDep, db: DB) -> BillOut:
    return await svc.create_bill(db, user, data)


@router.get("/{bill_id}", response_model=BillOut)
async def get_bill(bill_id: UUID, user: CurrentUserDep, db: DB) -> BillOut:
    return await svc.get_bill(db, user, bill_id)


@router.patch("/{bill_id}", response_model=BillOut)
async def patch_bill(bill_id: UUID, data: BillPatch, user: CurrentUserDep, db: DB) -> BillOut:
    return await svc.patch_bill(db, user, bill_id, data)


@router.delete("/{bill_id}", status_code=204)
async def delete_bill(bill_id: UUID, user: CurrentUserDep, db: DB, services: ServicesDep) -> Response:
    active_job = await svc.delete_bill(db, user, bill_id)
    if active_job is not None:
        from app.services.scans import cancel_job

        await cancel_job(db, services, user, active_job)
    return Response(status_code=204)


@router.put("/{bill_id}/receipt", response_model=BillOut)
async def put_receipt(bill_id: UUID, data: ReceiptIn, user: CurrentUserDep, db: DB) -> BillOut:
    """Replace items + charges + totals. Always saves (autosave); ``validation`` says if it reconciles."""
    return await svc.put_receipt(db, user, bill_id, data)


@router.put("/{bill_id}/participants", response_model=BillOut)
async def put_participants(bill_id: UUID, data: ParticipantsIn, user: CurrentUserDep, db: DB) -> BillOut:
    return await svc.put_participants(db, user, bill_id, data)


@router.put("/{bill_id}/assignments", response_model=BillOut)
async def put_assignments(bill_id: UUID, data: AssignmentsIn, user: CurrentUserDep, db: DB) -> BillOut:
    """Replace the shares of the listed items only (others are untouched)."""
    return await svc.put_assignments(db, user, bill_id, data)


@router.put("/{bill_id}/quick", response_model=BillOut)
async def put_quick(bill_id: UUID, data: QuickSplitIn, user: CurrentUserDep, db: DB) -> BillOut:
    """Quick split (no receipt): total shared equally or by shares."""
    return await svc.put_quick(db, user, bill_id, data)


@router.get("/{bill_id}/split", response_model=SplitOut)
async def get_split(bill_id: UUID, user: CurrentUserDep, db: DB) -> SplitOut:
    return (await svc.get_bill(db, user, bill_id)).split


@router.post("/{bill_id}/participants/{person_id}/settlement", response_model=BillOut)
async def settle(bill_id: UUID, person_id: UUID, user: CurrentUserDep, db: DB,
                 data: SettlementIn | None = None) -> BillOut:
    """Mark a participant as having paid the payer back (idempotent)."""
    return await svc.settle(db, user, bill_id, person_id, data.amount_cents if data else None)


@router.delete("/{bill_id}/participants/{person_id}/settlement", response_model=BillOut)
async def unsettle(bill_id: UUID, person_id: UUID, user: CurrentUserDep, db: DB) -> BillOut:
    return await svc.unsettle(db, user, bill_id, person_id)
