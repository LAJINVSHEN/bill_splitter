"""Dev-only login (no Supabase): mounted only when ENVIRONMENT != production AND
SUPABASE_ADMIN_BACKEND=fake. Lets the frontend and Playwright E2E run locally and in CI.

* ``POST /api/dev/auth/login`` mirrors ``supabase.auth.signInWithPassword``.
* ``POST /api/dev/auth/password`` mirrors ``supabase.auth.updateUser({password})``.
"""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.devtools import mint_dev_token
from app.errors import AppError
from app.integrations.supabase_admin import FakeSupabaseAdmin
from app.middleware.auth import PendingUserDep
from app.models import Profile
from app.schemas.common import InputModel, OutputModel
from app.services.container import ServicesDep

router = APIRouter(prefix="/dev/auth", tags=["dev"], include_in_schema=False)
DB = Annotated[AsyncSession, Depends(get_db)]


class DevLoginIn(InputModel):
    username: Annotated[str, Field(min_length=1, max_length=254)]  # username or email
    password: Annotated[str, Field(min_length=1, max_length=200)]


class DevPasswordIn(InputModel):
    password: Annotated[str, Field(min_length=6, max_length=200)]


class DevTokenOut(OutputModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


def _fake_admin(services: ServicesDep) -> FakeSupabaseAdmin:
    if not isinstance(services.auth_admin, FakeSupabaseAdmin):  # defence in depth; the router isn't mounted
        raise AppError(404, "not_found", "Not found")
    return services.auth_admin


def _invalid() -> AppError:
    return AppError(401, "invalid_credentials", "Wrong username or password.")


@router.post("/login", response_model=DevTokenOut)
async def dev_login(data: DevLoginIn, db: DB, services: ServicesDep) -> DevTokenOut:
    settings = services.settings
    if not settings.supabase_jwt_secret:
        raise AppError(503, "dev_login_unavailable", "SUPABASE_JWT_SECRET is not set.")
    fake = _fake_admin(services)
    ident = data.username.strip().lower()
    profile = await db.scalar(select(Profile).where(or_(Profile.username == ident, func.lower(Profile.email) == ident)))
    if profile is None:
        raise _invalid()
    known = fake.users.get(profile.id, {}).get("password")
    expected = known or settings.dev_login_password  # in-memory fake first, else DEV_LOGIN_PASSWORD
    if not expected or not hmac.compare_digest(expected.encode(), data.password.encode()):
        raise _invalid()
    if profile.disabled_at is not None:
        raise AppError(403, "account_disabled", "This account has been disabled.")
    token, ttl = mint_dev_token(settings, profile.id)
    return DevTokenOut(access_token=token, expires_in=ttl)


@router.post("/password", status_code=204)
async def dev_set_password(data: DevPasswordIn, user: PendingUserDep, services: ServicesDep) -> Response:
    """Stores the new password in the fake admin (then call POST /api/me/password-changed)."""
    await _fake_admin(services).set_password(user.id, data.password)
    return Response(status_code=204)
