"""Admin: user provisioning via Supabase Auth admin API, usage reporting, global settings."""

from __future__ import annotations

import logging
import secrets
import string
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.core.periods import current_month_bounds, month_bounds, month_key, parse_month
from app.errors import AppError, BadRequest, Conflict, NotFound
from app.integrations.supabase_admin import EmailTaken, SupabaseAdmin, SupabaseAdminError
from app.middleware.auth import CurrentUser
from app.models import Profile
from app.pagination import decode_cursor, encode_cursor
from app.repositories import usage as usage_repo
from app.schemas.admin import (
    AdminSettingsOut,
    AdminSettingsPatch,
    AdminUsageOut,
    AdminUserCreate,
    AdminUserCreated,
    AdminUserOut,
    AdminUserPatch,
    LlmConfigOut,
    ModelUsage,
    PasswordReset,
    ProviderLimitsOut,
    UsageTotals,
    UserUsage,
)
from app.schemas.common import Page
from app.services.people import ensure_self
from app.services.usage import app_settings

logger = logging.getLogger(__name__)

_SYMBOLS = "!@#$%*-_+="


def temp_password(length: int = 16) -> str:
    """Random password with upper, lower, digit and symbol (meets any Supabase policy)."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    while True:
        chars = [secrets.choice(alphabet) for _ in range(length - 1)] + [secrets.choice(_SYMBOLS)]
        secrets.SystemRandom().shuffle(chars)
        pw = "".join(chars)
        if (any(c.isupper() for c in pw) and any(c.islower() for c in pw)
                and any(c in string.digits for c in pw)):
            return pw


def _auth_failure(exc: SupabaseAdminError) -> AppError:
    logger.warning("Supabase admin call failed: %s", exc)
    return AppError(502, "auth_provider_error", "The sign-in service rejected the request. Try again.")


def _user_out(p: Profile, pages: int) -> AdminUserOut:
    return AdminUserOut(id=p.id, username=p.username, email=p.email, display_name=p.display_name, role=p.role,
                        must_change_password=p.must_change_password, monthly_scan_quota=p.monthly_scan_quota,
                        disabled_at=p.disabled_at, created_at=p.created_at, pages_used_this_month=pages)


async def _pages_this_month(db: AsyncSession, settings: Settings) -> dict[UUID, int]:
    _, start, end = current_month_bounds(datetime.now(UTC), settings.app_timezone)
    return await usage_repo.user_pages(db, start, end)


async def list_users(db: AsyncSession, settings: Settings, limit: int, cursor: str | None) -> Page[AdminUserOut]:
    stmt = select(Profile).order_by(Profile.username, Profile.id).limit(limit + 1)
    if cursor:
        username, uid = decode_cursor(cursor, 2)
        if not isinstance(username, str) or not isinstance(uid, UUID):
            raise BadRequest("invalid_cursor", "The pagination cursor is invalid.")
        stmt = stmt.where((Profile.username > username) | ((Profile.username == username) & (Profile.id > uid)))
    rows = list((await db.scalars(stmt)).all())
    pages = await _pages_this_month(db, settings)
    has_more = len(rows) > limit
    rows = rows[:limit]
    return Page[AdminUserOut](items=[_user_out(p, pages.get(p.id, 0)) for p in rows],
                              next_cursor=encode_cursor(rows[-1].username, rows[-1].id) if has_more else None)


async def create_user(db: AsyncSession, settings: Settings, auth: SupabaseAdmin, data: AdminUserCreate) -> AdminUserCreated:
    if await db.scalar(select(Profile.id).where(Profile.username == data.username)) is not None:
        raise Conflict("username_taken", "That username is already taken.")
    email = data.email or f"{data.username}@{settings.auth_email_domain}"
    if await db.scalar(select(Profile.id).where(func.lower(Profile.email) == email)) is not None:
        raise Conflict("email_taken", "That email already belongs to a user.")
    password = temp_password()
    display = data.display_name or data.username
    try:
        auth_user = await auth.create_user(email, password, {"username": data.username, "display_name": display})
    except EmailTaken:
        raise Conflict("email_taken", "That email already exists in Supabase Auth.") from None
    except SupabaseAdminError as exc:
        raise _auth_failure(exc) from exc
    s = await app_settings(db, settings)
    google = data.login == "google"
    profile = Profile(id=auth_user.id, username=data.username, email=email, display_name=display, role=data.role,
                      must_change_password=not google,
                      monthly_scan_quota=data.monthly_scan_quota if data.monthly_scan_quota is not None
                      else s.default_user_quota,
                      default_currency=settings.default_currency)
    try:
        db.add(profile)
        await db.flush()
        await ensure_self(db, profile.id, display)
        await db.commit()
    except Exception:
        await db.rollback()
        try:
            await auth.delete_user(auth_user.id)  # compensate: don't leave an orphan auth user
        except SupabaseAdminError:
            logger.error("Orphan Supabase user %s needs manual cleanup", auth_user.id)
        raise
    await db.refresh(profile)
    return AdminUserCreated(user=_user_out(profile, 0), temp_password=None if google else password)


async def _get_profile(db: AsyncSession, user_id: UUID) -> Profile:
    p = await db.get(Profile, user_id, with_for_update=True)
    if p is None:
        raise NotFound("User")
    return p


async def patch_user(db: AsyncSession, settings: Settings, auth: SupabaseAdmin, admin: CurrentUser, user_id: UUID,
                     data: AdminUserPatch) -> AdminUserOut:
    p = await _get_profile(db, user_id)
    if data.role is not None and data.role != p.role:
        if p.id == admin.id:
            raise Conflict("cannot_demote_self", "You can't change your own role.")
        p.role = data.role
    if data.display_name is not None:
        p.display_name = data.display_name
    if data.monthly_scan_quota is not None:
        p.monthly_scan_quota = data.monthly_scan_quota
    if data.disabled is not None and data.disabled != (p.disabled_at is not None):
        if p.id == admin.id:
            raise Conflict("cannot_disable_self", "You can't disable your own account.")
        try:
            await auth.set_disabled(p.id, data.disabled)
        except SupabaseAdminError as exc:
            raise _auth_failure(exc) from exc
        p.disabled_at = datetime.now(UTC) if data.disabled else None
    await db.commit()
    await db.refresh(p)
    pages = await _pages_this_month(db, settings)
    return _user_out(p, pages.get(p.id, 0))


async def reset_password(db: AsyncSession, auth: SupabaseAdmin, user_id: UUID) -> PasswordReset:
    p = await _get_profile(db, user_id)
    password = temp_password()
    try:
        await auth.set_password(p.id, password)
    except SupabaseAdminError as exc:
        raise _auth_failure(exc) from exc
    p.must_change_password = True
    await db.commit()
    return PasswordReset(temp_password=password)


async def usage(db: AsyncSession, settings: Settings, month: str | None) -> AdminUsageOut:
    tz = settings.app_timezone
    if month:
        try:
            parse_month(month)
        except ValueError:
            raise BadRequest("invalid_month", "month must look like YYYY-MM") from None
        start, end = month_bounds(month, tz)
    else:
        month, start, end = current_month_bounds(datetime.now(UTC), tz)
    totals = await usage_repo.month_usage(db, start, end)
    s = await app_settings(db, settings)
    users = await usage_repo.by_user(db, start, end)
    models = await usage_repo.by_model(db, start, end)
    await db.commit()
    return AdminUsageOut(
        month=month, timezone=tz,
        totals=UsageTotals(**totals.__dict__),
        global_monthly_page_cap=s.global_monthly_page_cap,
        global_monthly_llm_budget_micros=s.global_monthly_llm_budget_micros,
        by_user=[UserUsage(user_id=uid, username=name, ocr_pages=int(pages), llm_calls=int(calls),
                           cost_micros=int(cost), quota=quota) for uid, name, quota, pages, calls, cost in users],
        by_model=[ModelUsage(model=m or "unknown", calls=int(c), failed_calls=int(f), input_tokens=int(i),
                             output_tokens=int(o), cost_micros=int(cost), avg_latency_ms=lat)
                  for m, c, f, i, o, cost, lat in models],
    )


def _settings_out(settings: Settings, row) -> AdminSettingsOut:  # noqa: ANN001
    fallback = settings.llm_models[1] if len(settings.llm_models) > 1 else None
    return AdminSettingsOut(
        global_monthly_page_cap=row.global_monthly_page_cap,
        global_monthly_llm_budget_micros=row.global_monthly_llm_budget_micros,
        default_user_quota=row.default_user_quota, scans_enabled=row.scans_enabled,
        provider=ProviderLimitsOut(
            azure_di_monthly_page_limit=settings.azure_di_monthly_page_limit,
            azure_di_calls_per_minute_limit=settings.azure_di_calls_per_minute_limit,
            azure_di_calls_per_minute=settings.azure_calls_per_minute_effective,
            effective_monthly_page_cap=settings.effective_page_cap(row.global_monthly_page_cap),
            provider_paused_month=row.provider_paused_month,
        ),
        llm=LlmConfigOut(primary_model=settings.llm_primary_model,
                         primary_reasoning_effort=settings.llm_primary_reasoning_effort or None,
                         fallback_model=fallback[0] if fallback else None,
                         fallback_reasoning_effort=(fallback[1] or None) if fallback else None,
                         timeout_seconds=settings.llm_timeout_seconds, max_retries=settings.llm_max_retries,
                         backend=settings.llm_backend),
        ocr_backend=settings.ocr_backend, ocr_max_pdf_pages=settings.ocr_max_pdf_pages,
        scan_max_files=settings.scan_max_files, scan_max_file_bytes=settings.scan_max_file_bytes,
        receipt_retention_days=settings.receipt_retention_days, app_timezone=settings.app_timezone,
        updated_at=row.updated_at,
    )


async def get_settings_out(db: AsyncSession, settings: Settings) -> AdminSettingsOut:
    row = await app_settings(db, settings)
    await db.commit()
    return _settings_out(settings, row)


async def patch_settings(db: AsyncSession, settings: Settings, data: AdminSettingsPatch) -> AdminSettingsOut:
    limit = settings.azure_di_monthly_page_limit
    if data.global_monthly_page_cap is not None and data.global_monthly_page_cap > limit:
        raise AppError(422, "page_cap_above_provider_limit",
                       f"The monthly page cap can't exceed the OCR provider's limit of {limit} pages "
                       "(Azure free tier). Pick a lower number.", provider_limit=limit)
    row = await app_settings(db, settings, for_update=True)
    if data.provider_paused is not None:
        row.provider_paused_month = (month_key(datetime.now(UTC), settings.app_timezone)
                                     if data.provider_paused else None)
    for field in ("global_monthly_page_cap", "global_monthly_llm_budget_micros", "default_user_quota",
                  "scans_enabled"):
        value = getattr(data, field)
        if value is not None:
            setattr(row, field, value)
    row.updated_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(row)
    return _settings_out(settings, row)
