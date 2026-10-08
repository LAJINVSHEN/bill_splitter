from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import CurrentUserDep, PendingUserDep
from app.core.currencies import normalize_code
from app.errors import BadRequest
from app.schemas.me import FxRateIn, FxRateList, FxRateOut, MeOut, MePatch, SummaryOut, UsageOut
from app.services import fx
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


def _code(value: str) -> str:
    code = normalize_code(value)
    if code is None:
        raise BadRequest("unknown_currency", f"{value!r} is not a supported ISO 4217 currency.")
    return code


CodePath = Annotated[str, Path(min_length=3, max_length=3)]


@router.get("/fx-rates", response_model=FxRateList)
async def list_fx_rates(user: CurrentUserDep, db: DB) -> FxRateList:
    """The user's saved rates (one row per currency pair; inverses are derived)."""
    return await fx.list_rates(db, user.id)


@router.get("/fx-rates/{base}/{quote}", response_model=FxRateOut)
async def get_fx_rate(base: CodePath, quote: CodePath, user: CurrentUserDep, db: DB) -> FxRateOut:
    """1 base = rate quote; ``derived: true`` when computed from the stored inverse."""
    return await fx.get_rate(db, user.id, _code(base), _code(quote))


@router.put("/fx-rates/{base}/{quote}", response_model=FxRateOut)
async def put_fx_rate(base: CodePath, quote: CodePath, data: FxRateIn, user: CurrentUserDep, db: DB) -> FxRateOut:
    """Save 1 base = rate quote (replaces this pair in either direction)."""
    return await fx.put_rate(db, user.id, _code(base), _code(quote), data.rate)


@router.delete("/fx-rates/{base}/{quote}", status_code=204)
async def delete_fx_rate(base: CodePath, quote: CodePath, user: CurrentUserDep, db: DB) -> Response:
    await fx.delete_rate(db, user.id, _code(base), _code(quote))
    return Response(status_code=204)
