from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import Integer, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AppSettings, Profile, UsageEvent


@dataclass(frozen=True)
class MonthUsage:
    ocr_pages: int
    ocr_calls: int
    llm_calls: int
    input_tokens: int
    output_tokens: int
    cost_micros: int
    failed_calls: int


def _agg():  # noqa: ANN202 - SQL expressions
    is_ocr = UsageEvent.kind == "ocr"
    return (
        func.coalesce(func.sum(case((is_ocr, UsageEvent.pages), else_=0)), 0),
        func.coalesce(func.sum(case((is_ocr, 1), else_=0)), 0),
        func.coalesce(func.sum(case((~is_ocr, 1), else_=0)), 0),
        func.coalesce(func.sum(UsageEvent.input_tokens), 0),
        func.coalesce(func.sum(UsageEvent.output_tokens), 0),
        func.coalesce(func.sum(UsageEvent.cost_micros), 0),
        func.coalesce(func.sum(case((UsageEvent.ok.is_(False), 1), else_=0)), 0),
    )


async def month_usage(db: AsyncSession, start: datetime, end: datetime, user_id: UUID | None = None) -> MonthUsage:
    stmt = select(*_agg()).where(UsageEvent.created_at >= start, UsageEvent.created_at < end)
    if user_id is not None:
        stmt = stmt.where(UsageEvent.user_id == user_id)
    row = (await db.execute(stmt)).one()
    return MonthUsage(*(int(v) for v in row))


async def user_pages(db: AsyncSession, start: datetime, end: datetime) -> dict[UUID, int]:
    stmt = (select(UsageEvent.user_id, func.coalesce(func.sum(UsageEvent.pages), 0))
            .where(UsageEvent.kind == "ocr", UsageEvent.created_at >= start, UsageEvent.created_at < end)
            .group_by(UsageEvent.user_id))
    return {uid: int(p) for uid, p in (await db.execute(stmt)).all() if uid is not None}


async def by_user(db: AsyncSession, start: datetime, end: datetime) -> list[tuple]:
    is_ocr = UsageEvent.kind == "ocr"
    stmt = (
        select(UsageEvent.user_id, Profile.username, Profile.monthly_scan_quota,
               func.coalesce(func.sum(case((is_ocr, UsageEvent.pages), else_=0)), 0),
               func.coalesce(func.sum(case((~is_ocr, 1), else_=0)), 0),
               func.coalesce(func.sum(UsageEvent.cost_micros), 0))
        .outerjoin(Profile, Profile.id == UsageEvent.user_id)
        .where(UsageEvent.created_at >= start, UsageEvent.created_at < end)
        .group_by(UsageEvent.user_id, Profile.username, Profile.monthly_scan_quota)
        .order_by(func.sum(UsageEvent.cost_micros).desc())
    )
    return list((await db.execute(stmt)).all())


async def by_model(db: AsyncSession, start: datetime, end: datetime) -> list[tuple]:
    stmt = (
        select(UsageEvent.model, func.count(),
               func.coalesce(func.sum(case((UsageEvent.ok.is_(False), 1), else_=0)), 0),
               func.coalesce(func.sum(UsageEvent.input_tokens), 0),
               func.coalesce(func.sum(UsageEvent.output_tokens), 0),
               func.coalesce(func.sum(UsageEvent.cost_micros), 0),
               func.cast(func.avg(UsageEvent.latency_ms), Integer))
        .where(UsageEvent.kind == "llm", UsageEvent.created_at >= start, UsageEvent.created_at < end)
        .group_by(UsageEvent.model).order_by(func.count().desc())
    )
    return list((await db.execute(stmt)).all())


async def get_app_settings(db: AsyncSession, *, page_cap: int, budget_micros: int, default_quota: int,
                           for_update: bool = False) -> AppSettings:
    """The singleton row, created from env defaults on first use."""
    stmt = select(AppSettings).where(AppSettings.id == 1)
    if for_update:
        stmt = stmt.with_for_update()
    row = await db.scalar(stmt)
    if row is None:
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        await db.execute(pg_insert(AppSettings).values(
            id=1, global_monthly_page_cap=page_cap, global_monthly_llm_budget_micros=budget_micros,
            default_user_quota=default_quota, scans_enabled=True,
        ).on_conflict_do_nothing(index_elements=["id"]))
        row = await db.scalar(stmt.execution_options(populate_existing=True))
    assert row is not None
    return row
