from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ExtractionJob, OcrCache, ReceiptFile, UsageEvent
from app.models.scan import ACTIVE_JOB_STATUSES


async def get_job(db: AsyncSession, owner_id: UUID, job_id: UUID) -> ExtractionJob | None:
    return await db.scalar(select(ExtractionJob).where(ExtractionJob.id == job_id,
                                                       ExtractionJob.owner_id == owner_id))


async def get_job_by_id(db: AsyncSession, job_id: UUID) -> ExtractionJob | None:
    """Pipeline-internal (the job id came from an authorised request)."""
    return await db.get(ExtractionJob, job_id, populate_existing=True)


async def get_job_by_key(db: AsyncSession, owner_id: UUID, key: str) -> ExtractionJob | None:
    return await db.scalar(select(ExtractionJob).where(ExtractionJob.owner_id == owner_id,
                                                       ExtractionJob.idempotency_key == key))


async def latest_job(db: AsyncSession, bill_id: UUID) -> ExtractionJob | None:
    return await db.scalar(select(ExtractionJob).where(ExtractionJob.bill_id == bill_id)
                           .order_by(ExtractionJob.created_at.desc()).limit(1))


async def active_job_for_bill(db: AsyncSession, bill_id: UUID) -> ExtractionJob | None:
    return await db.scalar(select(ExtractionJob).where(ExtractionJob.bill_id == bill_id,
                                                       ExtractionJob.status.in_(ACTIVE_JOB_STATUSES)).limit(1))


async def update_job_if_active(db: AsyncSession, job_id: UUID, **values: Any) -> bool:
    """Update only while the job is still active (a cancel wins over a late pipeline write)."""
    values.setdefault("updated_at", func.now())
    result = await db.execute(
        update(ExtractionJob)
        .where(ExtractionJob.id == job_id, ExtractionJob.status.in_(ACTIVE_JOB_STATUSES))
        .values(**values)
        .returning(ExtractionJob.id)
    )
    return result.first() is not None


async def stale_active_jobs(db: AsyncSession, older_than: datetime) -> list[ExtractionJob]:
    stmt = select(ExtractionJob).where(
        ExtractionJob.status.in_(ACTIVE_JOB_STATUSES),
        func.coalesce(ExtractionJob.heartbeat_at, ExtractionJob.created_at) < older_than,
    ).with_for_update(skip_locked=True)
    return list((await db.scalars(stmt)).all())


async def files_for_job(db: AsyncSession, job_id: UUID) -> list[ReceiptFile]:
    stmt = select(ReceiptFile).where(ReceiptFile.job_id == job_id).order_by(ReceiptFile.position)
    return list((await db.scalars(stmt)).all())


async def files_for_bill(db: AsyncSession, bill_id: UUID) -> list[ReceiptFile]:
    stmt = (select(ReceiptFile).where(ReceiptFile.bill_id == bill_id)
            .order_by(ReceiptFile.created_at, ReceiptFile.position))
    return list((await db.scalars(stmt)).all())


async def get_file(db: AsyncSession, owner_id: UUID, bill_id: UUID, file_id: UUID) -> ReceiptFile | None:
    return await db.scalar(select(ReceiptFile).where(ReceiptFile.id == file_id, ReceiptFile.bill_id == bill_id,
                                                     ReceiptFile.owner_id == owner_id))


async def expired_files(db: AsyncSession, now: datetime, limit: int = 200) -> list[ReceiptFile]:
    stmt = (select(ReceiptFile).where(ReceiptFile.deleted_at.is_(None), ReceiptFile.expires_at <= now)
            .order_by(ReceiptFile.expires_at).limit(limit))
    return list((await db.scalars(stmt)).all())


async def cached_ocr(db: AsyncSession, owner_id: UUID, shas: Iterable[str]) -> dict[str, OcrCache]:
    shas = list(set(shas))
    if not shas:
        return {}
    rows = await db.scalars(select(OcrCache).where(OcrCache.owner_id == owner_id,
                                                   OcrCache.content_sha256.in_(shas)))
    return {r.content_sha256: r for r in rows}


async def put_ocr_cache(db: AsyncSession, owner_id: UUID, sha: str, text: str, pages: int) -> None:
    stmt = pg_insert(OcrCache).values(owner_id=owner_id, content_sha256=sha, ocr_text=text, pages=pages)
    await db.execute(stmt.on_conflict_do_nothing(index_elements=["owner_id", "content_sha256"]))


async def add_usage(db: AsyncSession, **values: Any) -> None:
    db.add(UsageEvent(**values))
