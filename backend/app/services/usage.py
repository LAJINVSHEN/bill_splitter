"""Quotas and usage accounting (checked BEFORE any paid call).

OCR pages count as ``billed this month + reserved by active jobs``. The final check and the
reservation happen inside one transaction holding a Postgres advisory lock
(``lock_quota``), so concurrent scans can never jointly overshoot a cap. The global cap is
``min(admin page cap, AZURE_DI_MONTHLY_PAGE_LIMIT)``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.core.periods import current_month_bounds, month_key
from app.errors import AppError
from app.models import AppSettings, ExtractionJob
from app.models.scan import ACTIVE_JOB_STATUSES
from app.repositories import usage as repo
from app.schemas.me import UsageOut

QUOTA_LOCK_KEY = 0x6576_656E_0C12  # fixed advisory-lock key for the OCR page gate ("even" + "OCR")


async def lock_quota(db: AsyncSession) -> None:
    """Transaction-scoped: held until the caller commits/rolls back."""
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": QUOTA_LOCK_KEY})


async def app_settings(db: AsyncSession, settings: Settings, *, for_update: bool = False) -> AppSettings:
    return await repo.get_app_settings(
        db, page_cap=min(settings.global_monthly_page_cap, settings.azure_di_monthly_page_limit),
        budget_micros=settings.llm_budget_micros_default, default_quota=settings.default_user_monthly_quota,
        for_update=for_update,
    )


async def reserved_pages(db: AsyncSession, user_id: UUID | None = None) -> int:
    stmt = select(func.coalesce(func.sum(ExtractionJob.pages_reserved), 0)).where(
        ExtractionJob.status.in_(ACTIVE_JOB_STATUSES))
    if user_id is not None:
        stmt = stmt.where(ExtractionJob.owner_id == user_id)
    return int(await db.scalar(stmt) or 0)


@dataclass(frozen=True)
class QuotaState:
    month: str
    user_pages: int
    user_reserved: int
    user_quota: int
    global_pages: int
    global_reserved: int
    global_cap: int  # effective: min(admin cap, provider limit)
    llm_cost_micros: int
    llm_budget_micros: int
    scans_enabled: bool
    provider_paused: bool

    def pause_reason(self, extra_pages: int = 0) -> str | None:
        """Why a scan needing ``extra_pages`` new OCR pages can't start (None = allowed)."""
        if not self.scans_enabled:
            return "scans_disabled"
        if self.provider_paused:
            return "provider_quota"
        user = self.user_pages + self.user_reserved
        if user + extra_pages > self.user_quota or user >= self.user_quota:
            return "user_quota"
        total = self.global_pages + self.global_reserved
        if total + extra_pages > self.global_cap or total >= self.global_cap:
            return "global_page_cap"
        if self.llm_cost_micros >= self.llm_budget_micros:
            return "llm_budget"
        return None


async def quota_state(db: AsyncSession, settings: Settings, user_id: UUID, user_quota: int,
                      now: datetime | None = None) -> QuotaState:
    month, start, end = current_month_bounds(now or datetime.now(UTC), settings.app_timezone)
    s = await app_settings(db, settings)
    mine = await repo.month_usage(db, start, end, user_id)
    everyone = await repo.month_usage(db, start, end)
    return QuotaState(month=month, user_pages=mine.ocr_pages, user_reserved=await reserved_pages(db, user_id),
                      user_quota=user_quota, global_pages=everyone.ocr_pages,
                      global_reserved=await reserved_pages(db),
                      global_cap=settings.effective_page_cap(s.global_monthly_page_cap),
                      llm_cost_micros=everyone.cost_micros, llm_budget_micros=s.global_monthly_llm_budget_micros,
                      scans_enabled=s.scans_enabled, provider_paused=s.provider_paused_month == month)


QUOTA_MESSAGES = {
    "scans_disabled": "Scanning is paused by the admin. You can still enter the bill manually.",
    "provider_quota": "Scanning is paused for the rest of the month (the free OCR allowance is used up). "
                      "You can still enter the bill manually.",
    "user_quota": "You've used this month's scans. You can still enter the bill manually.",
    "global_page_cap": "The app has reached this month's scan limit. You can still enter the bill manually.",
    "llm_budget": "The app has reached this month's AI budget. You can still enter the bill manually.",
}


def quota_error(reason: str, state: QuotaState) -> AppError:
    return AppError(429, f"quota_{reason}", QUOTA_MESSAGES[reason], month=state.month,
                    pages_used=state.user_pages, pages_quota=state.user_quota)


async def pause_provider_for_month(db: AsyncSession, settings: Settings) -> str:
    """Azure said the monthly allowance is gone: no more OCR calls until next month."""
    month = month_key(datetime.now(UTC), settings.app_timezone)
    row = await app_settings(db, settings, for_update=True)
    row.provider_paused_month = month
    row.updated_at = datetime.now(UTC)
    return month


async def provider_paused(db: AsyncSession, settings: Settings) -> bool:
    s = await app_settings(db, settings)
    return s.provider_paused_month == month_key(datetime.now(UTC), settings.app_timezone)


async def month_ocr_pages(db: AsyncSession, settings: Settings) -> int:
    _, start, end = current_month_bounds(datetime.now(UTC), settings.app_timezone)
    return (await repo.month_usage(db, start, end)).ocr_pages


async def my_usage(db: AsyncSession, settings: Settings, user_id: UUID, user_quota: int) -> UsageOut:
    state = await quota_state(db, settings, user_id, user_quota)
    _, start, end = current_month_bounds(datetime.now(UTC), settings.app_timezone)
    mine = await repo.month_usage(db, start, end, user_id)
    reason = state.pause_reason()
    await db.commit()  # persists the lazily created app_settings row, if any
    remaining = max(min(state.user_quota - state.user_pages - state.user_reserved,
                        state.global_cap - state.global_pages - state.global_reserved), 0)
    return UsageOut(month=state.month, timezone=settings.app_timezone, pages_used=state.user_pages,
                    pages_quota=state.user_quota, pages_remaining=remaining,
                    llm_calls=mine.llm_calls, cost_micros=mine.cost_micros,
                    scans_paused=reason is not None, pause_reason=reason)  # type: ignore[arg-type]


async def llm_budget_state(db: AsyncSession, settings: Settings) -> tuple[int, int]:
    """(LLM cost this month in micros, monthly budget in micros) – for all users."""
    _, start, end = current_month_bounds(datetime.now(UTC), settings.app_timezone)
    s = await app_settings(db, settings)
    everyone = await repo.month_usage(db, start, end)
    return everyone.cost_micros, s.global_monthly_llm_budget_micros
