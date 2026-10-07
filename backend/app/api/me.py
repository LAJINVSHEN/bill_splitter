from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import CurrentUserDep, PendingUserDep
from app.schemas.me import MeOut, MePatch, SummaryOut, UsageOut
from app.services import me as svc
from app.services.container import ServicesDep
from app.services.usage import my_usage

router = APIRouter(prefix="/me", tags=["me"])
DB = Annotated[AsyncSession, Depends(get_db)]


@router.get("", response_model=MeOut)
async def get_me(user: PendingUserDep, db: DB) -> MeOut:
    """Works before the temp password is changed (check ``must_change_password``)."""
    return await svc.get_me(db, user)


@router.patch("", response_model=MeOut)
async def patch_me(data: MePatch, user: CurrentUserDep, db: DB) -> MeOut:
    return await svc.patch_me(db, user, data)


@router.post("/password-changed", response_model=MeOut)
async def password_changed(user: PendingUserDep, db: DB) -> MeOut:
    """Call after ``supabase.auth.updateUser({ password })`` succeeds."""
    return await svc.password_changed(db, user)


@router.get("/usage", response_model=UsageOut)
async def usage(user: CurrentUserDep, db: DB, services: ServicesDep) -> UsageOut:
    return await my_usage(db, services.settings, user.id, user.monthly_scan_quota)


@router.get("/summary", response_model=SummaryOut)
async def summary(user: CurrentUserDep, db: DB) -> SummaryOut:
    return await svc.summary(db, user)
