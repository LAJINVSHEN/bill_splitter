from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import AdminDep
from app.ratelimit import admin_create_limit, limiter
from app.schemas.admin import (
    AdminSettingsOut,
    AdminSettingsPatch,
    AdminUsageOut,
    AdminUserCreate,
    AdminUserCreated,
    AdminUserOut,
    AdminUserPatch,
    PasswordReset,
)
from app.schemas.common import Page
from app.services import admin as svc
from app.services.container import ServicesDep

router = APIRouter(prefix="/admin", tags=["admin"])
DB = Annotated[AsyncSession, Depends(get_db)]


@router.get("/users", response_model=Page[AdminUserOut])
async def list_users(admin: AdminDep, db: DB, services: ServicesDep,
                     limit: Annotated[int, Query(ge=1, le=100)] = 50,
                     cursor: Annotated[str | None, Query(max_length=300)] = None) -> Page[AdminUserOut]:
    return await svc.list_users(db, services.settings, limit, cursor)


@router.post("/users", response_model=AdminUserCreated, status_code=201)
@limiter.limit(admin_create_limit)
async def create_user(request: Request, data: AdminUserCreate, admin: AdminDep, db: DB,
                      services: ServicesDep) -> AdminUserCreated:
    """Creates the Supabase Auth user + profile. ``temp_password`` is shown once."""
    return await svc.create_user(db, services.settings, services.auth_admin, data)


@router.patch("/users/{user_id}", response_model=AdminUserOut)
async def patch_user(user_id: UUID, data: AdminUserPatch, admin: AdminDep, db: DB,
                     services: ServicesDep) -> AdminUserOut:
    return await svc.patch_user(db, services.settings, services.auth_admin, admin, user_id, data)


@router.post("/users/{user_id}/reset-password", response_model=PasswordReset)
@limiter.limit(admin_create_limit)
async def reset_password(request: Request, user_id: UUID, admin: AdminDep, db: DB,
                         services: ServicesDep) -> PasswordReset:
    return await svc.reset_password(db, services.auth_admin, user_id)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: UUID, admin: AdminDep, db: DB, services: ServicesDep) -> Response:
    await svc.delete_user(db, services, admin, user_id)
    return Response(status_code=204)


@router.get("/usage", response_model=AdminUsageOut)
async def usage(admin: AdminDep, db: DB, services: ServicesDep,
                month: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}$")] = None) -> AdminUsageOut:
    return await svc.usage(db, services.settings, month)


@router.get("/settings", response_model=AdminSettingsOut)
async def get_settings(admin: AdminDep, db: DB, services: ServicesDep) -> AdminSettingsOut:
    return await svc.get_settings_out(db, services.settings)


@router.patch("/settings", response_model=AdminSettingsOut)
async def patch_settings(data: AdminSettingsPatch, admin: AdminDep, db: DB,
                         services: ServicesDep) -> AdminSettingsOut:
    return await svc.patch_settings(db, services.settings, data)
