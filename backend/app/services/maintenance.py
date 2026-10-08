"""Daily maintenance (cron → POST /api/internal/maintenance):
purge expired receipt photos, fail stale jobs, and touch the DB so Supabase never
pauses the project for inactivity."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import text, update

from app.integrations.storage import StorageError
from app.models import ReceiptFile
from app.repositories import scans as repo
from app.services.container import Services
from app.services.pipeline import recover_stale_jobs

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MaintenanceResult:
    purged_files: int
    purge_failures: int
    failed_stale_jobs: int
    db: str


async def run_maintenance(svc: Services, sessionmaker) -> MaintenanceResult:  # noqa: ANN001
    now = datetime.now(UTC)
    purged = failures = 0
    async with sessionmaker() as db:
        await db.execute(text("SELECT 1"))
        for _ in range(10):  # up to 2,000 files per run
            batch = await repo.expired_files(db, now, limit=200)
            if not batch:
                break
            try:
                await svc.storage.delete([f.storage_path for f in batch])
            except StorageError:
                failures += len(batch)
                logger.warning("storage delete failed for %d expired files", len(batch))
                break
            await db.execute(update(ReceiptFile).where(ReceiptFile.id.in_([f.id for f in batch]))
                             .values(deleted_at=now))
            await db.commit()
            purged += len(batch)
    stale = await recover_stale_jobs(sessionmaker, svc.settings.job_stale_seconds, skip=svc.runner.is_running)
    return MaintenanceResult(purged_files=purged, purge_failures=failures, failed_stale_jobs=stale, db="ok")
