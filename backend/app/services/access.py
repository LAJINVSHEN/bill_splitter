"""Account requests. Accounts stay admin-controlled: someone who signs in with Google but has
no account can ask for one; the admin approves (the profile is made for that same sign-in, so
Google just works afterwards) or rejects. No email goes out either way: the person sees the
answer the next time they sign in.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import AppError, Conflict, NotFound
from app.middleware.auth import CurrentUser, SignedIn
from app.models import AccessRequest, Profile
from app.schemas.social import AccessApproveIn, AccessRequestIn, AccessRequestList, AccessRequestOut
from app.services.people import ensure_self
from app.services.usage import app_settings


def _out(row: AccessRequest) -> AccessRequestOut:
    return AccessRequestOut.model_validate(row)


async def ask(db: AsyncSession, settings: Settings, who: SignedIn, data: AccessRequestIn) -> AccessRequestOut:
    """Only a Google sign-in may ask (in production): Google has verified the email, so the admin
    approves the person who really owns it. Supabase sign-ups are open for that reason alone; an
    auth user without a profile can't do anything else."""
    if await db.get(Profile, who.user_id) is not None:
        raise Conflict("already_member", "You already have an account. Sign in again.")
    if not who.email or (settings.is_production and who.provider != "google"):
        raise AppError(403, "google_required", "Ask for access by continuing with Google.")
    row = await db.scalar(select(AccessRequest).where(AccessRequest.auth_user_id == who.user_id).with_for_update())
    if row is None:
        row = AccessRequest(auth_user_id=who.user_id, email=who.email, name=who.name, note=data.note)
        db.add(row)
    elif row.status == "pending":
        row.note = data.note or row.note
    else:
        raise Conflict("request_answered", "Your request was already answered.", status=row.status)
    await db.commit()
    await db.refresh(row)
    return _out(row)


async def mine(db: AsyncSession, who: SignedIn) -> AccessRequestOut:
    row = await db.scalar(select(AccessRequest).where(AccessRequest.auth_user_id == who.user_id))
    if row is None:
        raise NotFound("Request")
    return _out(row)


async def list_requests(db: AsyncSession, status: str | None) -> AccessRequestList:
    stmt = select(AccessRequest).order_by(AccessRequest.status != "pending", AccessRequest.created_at.desc()).limit(100)
    if status:
        stmt = stmt.where(AccessRequest.status == status)
    return AccessRequestList(items=[_out(r) for r in (await db.scalars(stmt)).all()])


async def _pending(db: AsyncSession, request_id: UUID) -> AccessRequest:
    row = await db.scalar(select(AccessRequest).where(AccessRequest.id == request_id).with_for_update())
    if row is None:
        raise NotFound("Request")
    if row.status != "pending":
        raise Conflict("request_answered", "This request was already answered.")
    return row


async def approve(db: AsyncSession, settings: Settings, admin: CurrentUser, request_id: UUID,
                  data: AccessApproveIn) -> AccessRequestOut:
    row = await _pending(db, request_id)
    if await db.scalar(select(Profile.id).where(Profile.username == data.username)) is not None:
        raise Conflict("username_taken", "That user id is already taken.")
    if await db.scalar(select(Profile.id).where(func.lower(Profile.email) == row.email.lower())) is not None:
        raise Conflict("email_taken", "That email already belongs to an account.")
    s = await app_settings(db, settings)
    display = data.display_name or row.name or data.username
    db.add(Profile(id=row.auth_user_id, username=data.username, email=row.email.lower(), display_name=display,
                   role="member", must_change_password=False, monthly_scan_quota=s.default_user_quota,
                   default_currency=settings.default_currency))
    await db.flush()
    await ensure_self(db, row.auth_user_id, display)
    row.status, row.decided_at, row.decided_by = "approved", datetime.now(UTC), admin.id
    await db.commit()
    await db.refresh(row)
    return _out(row)


async def reject(db: AsyncSession, admin: CurrentUser, request_id: UUID) -> AccessRequestOut:
    row = await _pending(db, request_id)
    row.status, row.decided_at, row.decided_by = "rejected", datetime.now(UTC), admin.id
    await db.commit()
    await db.refresh(row)
    return _out(row)
