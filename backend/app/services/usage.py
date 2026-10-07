"""Quotas and usage accounting (checked BEFORE any paid call)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.core.periods import current_month_bounds
from app.errors import AppError
from app.models import AppSettings
from app.repositories import usage as repo
from app.schemas.me import UsageOut


async def app_settings(db: AsyncSession, settings: Settings, *, for_update: bool = False) -> AppSettings:
    return await repo.get_app_settings(
        db, page_cap=settings.global_monthly_page_cap, budget_micros=settings.llm_budget_micros_default,
        default_quota=settings.default_user_monthly_quota, for_update=for_update,
    )


@dataclass(frozen=True)
class QuotaState:
    month: str
    user_pages: int
    user_quota: int
    global_pages: int
    global_cap: int
    llm_cost_micros: int
    llm_budget_micros: int
    scans_enabled: bool

    def pause_reason(self, extra_pages: int = 0) -> str | None:
        if not self.scans_enabled:
            return "scans_disabled"
        if self.user_pages + extra_pages > self.user_quota or self.user_pages >= self.user_quota:
            return "user_quota"
        if self.global_pages + extra_pages > self.global_cap or self.global_pages >= self.global_cap:
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
    return QuotaState(month=month, user_pages=mine.ocr_pages, user_quota=user_quota,
                      global_pages=everyone.ocr_pages, global_cap=s.global_monthly_page_cap,
                      llm_cost_micros=everyone.cost_micros, llm_budget_micros=s.global_monthly_llm_budget_micros,
                      scans_enabled=s.scans_enabled)


QUOTA_MESSAGES = {
    "scans_disabled": "Scanning is paused by the admin. You can still enter the bill manually.",
    "user_quota": "You've used this month's scans. You can still enter the bill manually.",
    "global_page_cap": "The app has reached this month's scan limit. You can still enter the bill manually.",
    "llm_budget": "The app has reached this month's AI budget. You can still enter the bill manually.",
}


def quota_error(reason: str, state: QuotaState) -> AppError:
    return AppError(429, f"quota_{reason}", QUOTA_MESSAGES[reason], month=state.month,
                    pages_used=state.user_pages, pages_quota=state.user_quota)


async def my_usage(db: AsyncSession, settings: Settings, user_id: UUID, user_quota: int) -> UsageOut:
    state = await quota_state(db, settings, user_id, user_quota)
    _, start, end = current_month_bounds(datetime.now(UTC), settings.app_timezone)
    mine = await repo.month_usage(db, start, end, user_id)
    reason = state.pause_reason()
    return UsageOut(month=state.month, timezone=settings.app_timezone, pages_used=state.user_pages,
                    pages_quota=state.user_quota, pages_remaining=max(state.user_quota - state.user_pages, 0),
                    llm_calls=mine.llm_calls, cost_micros=mine.cost_micros,
                    scans_paused=reason is not None, pause_reason=reason)  # type: ignore[arg-type]


async def llm_budget_state(db: AsyncSession, settings: Settings) -> tuple[int, int]:
    """(LLM cost this month in micros, monthly budget in micros) – for all users."""
    _, start, end = current_month_bounds(datetime.now(UTC), settings.app_timezone)
    s = await app_settings(db, settings)
    everyone = await repo.month_usage(db, start, end)
    return everyone.cost_micros, s.global_monthly_llm_budget_micros
