"""Scan creation (quota check before spending, Idempotency-Key), job status,
cancel, retry, and short-lived file URLs."""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import AppError, BadRequest, Conflict, NotFound
from app.integrations.storage import StorageError
from app.middleware.auth import CurrentUser
from app.models import Bill, ExtractionJob, ReceiptFile
from app.models.scan import ACTIVE_JOB_STATUSES
from app.repositories import bills as bills_repo
from app.repositories import scans as repo
from app.schemas.scans import JobOut, ScanCreated, SignedUrlOut
from app.services.container import Services
from app.services.pipeline import mark_job_failed
from app.services.usage import llm_budget_state, quota_error, quota_state

logger = logging.getLogger(__name__)

EXTENSIONS = {"image/jpeg": "jpg", "image/png": "png", "image/heif": "heic", "application/pdf": "pdf"}
_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,128}$")


@dataclass(frozen=True)
class Upload:
    filename: str
    data: bytes


def sniff_mime(data: bytes) -> str | None:
    """Content-based type detection (the client's Content-Type is not trusted)."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix", b"mif1", b"msf1", b"hevc"):
        return "image/heif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def job_out(job: ExtractionJob) -> JobOut:
    return JobOut.model_validate(job)


def _check_key(key: str | None) -> str | None:
    if key is None:
        return None
    key = key.strip()
    if not _IDEMPOTENCY_RE.match(key):
        raise BadRequest("invalid_idempotency_key", "Idempotency-Key must be 8–128 characters of [A-Za-z0-9_.:-].")
    return key


def _validate_uploads(svc: Services, uploads: list[Upload]) -> list[tuple[Upload, str, str]]:
    settings = svc.settings
    if not uploads:
        raise BadRequest("no_files", "Attach at least one photo or PDF of the receipt.")
    if len(uploads) > settings.scan_max_files:
        raise BadRequest("too_many_files", f"Attach at most {settings.scan_max_files} files per scan.")
    seen: set[str] = set()
    out: list[tuple[Upload, str, str]] = []
    for up in uploads:
        if len(up.data) == 0:
            raise BadRequest("empty_file", "One of the files is empty.")
        if len(up.data) > settings.scan_max_file_bytes:
            raise AppError(413, "file_too_large",
                           f"Each file must be under {settings.scan_max_file_bytes // (1024 * 1024)} MB.")
        mime = sniff_mime(up.data)
        if mime == "image/webp":
            raise AppError(415, "unsupported_file_type", "WebP isn't supported by the OCR service – use JPEG or PNG.")
        if mime is None:
            raise AppError(415, "unsupported_file_type", "Only JPEG, PNG, HEIF photos or PDFs can be scanned.")
        sha = hashlib.sha256(up.data).hexdigest()
        if sha in seen:  # the same photo twice adds nothing
            continue
        seen.add(sha)
        out.append((up, mime, sha))
    return out


def _estimate_pages(svc: Services, files: list[tuple[Upload, str, str]], cached: set[str]) -> int:
    pdf_pages = svc.settings.ocr_max_pdf_pages
    return sum(pdf_pages if mime == "application/pdf" else 1 for _, mime, sha in files if sha not in cached)


async def _check_quota(db: AsyncSession, svc: Services, user: CurrentUser, extra_pages: int) -> None:
    state = await quota_state(db, svc.settings, user.id, user.monthly_scan_quota)
    if extra_pages > 0:
        reason = state.pause_reason(extra_pages)
    elif not state.scans_enabled:
        reason = "scans_disabled"
    elif state.llm_cost_micros >= state.llm_budget_micros:
        reason = "llm_budget"
    else:
        reason = None
    if reason:
        raise quota_error(reason, state)


async def create_scan(db: AsyncSession, svc: Services, user: CurrentUser, bill_id: UUID, uploads: list[Upload],
                      idempotency_key: str | None) -> ScanCreated:
    key = _check_key(idempotency_key)
    if key:
        existing = await repo.get_job_by_key(db, user.id, key)
        if existing is not None:
            if existing.bill_id != bill_id:
                raise Conflict("idempotency_key_reused", "This Idempotency-Key was already used for another bill.")
            return ScanCreated(job_id=existing.id, status=existing.status, replayed=True)

    bill = await bills_repo.get_bill(db, user.id, bill_id, for_update=True)
    if bill is None:
        raise NotFound("Bill")
    if key and (existing := await repo.get_job_by_key(db, user.id, key)) is not None:
        # A concurrent identical request committed while we waited for the bill lock.
        return ScanCreated(job_id=existing.id, status=existing.status, replayed=True)
    active = await repo.active_job_for_bill(db, bill_id)
    if active is not None:
        raise Conflict("scan_in_progress", "This bill is already being scanned.", job_id=str(active.id))

    files = _validate_uploads(svc, uploads)
    cached = set((await repo.cached_ocr(db, user.id, [sha for _, _, sha in files])).keys())
    await _check_quota(db, svc, user, _estimate_pages(svc, files, cached))

    now = datetime.now(UTC)
    expires = now + timedelta(days=svc.settings.receipt_retention_days)
    job = ExtractionJob(id=uuid.uuid4(), bill_id=bill.id, owner_id=user.id, status="queued", attempts=1,
                        idempotency_key=key, heartbeat_at=now, timings={})
    rows: list[ReceiptFile] = []
    uploaded: list[str] = []
    try:
        for pos, (up, mime, sha) in enumerate(files):
            file_id = uuid.uuid4()
            path = f"{user.id}/{bill.id}/{file_id}.{EXTENSIONS[mime]}"
            await svc.storage.put(path, up.data, mime)
            uploaded.append(path)
            rows.append(ReceiptFile(id=file_id, bill_id=bill.id, owner_id=user.id, job_id=job.id, storage_path=path,
                                    sha256=sha, mime=mime, bytes=len(up.data), position=pos, expires_at=expires))
    except StorageError as exc:
        await _cleanup(svc, uploaded)
        raise AppError(503, "storage_unavailable", "Couldn't store the receipt. Please try again.") from exc

    db.add(job)
    await db.flush()
    db.add_all(rows)
    bill.status = "scanning"
    if bill.source == "manual" and not bill.grand_total_cents:
        bill.source = "scan"
    bill.updated_at = now
    try:
        await db.commit()
    except IntegrityError:
        # Lost an Idempotency-Key race with an identical request: return the winner.
        await db.rollback()
        await _cleanup(svc, uploaded)
        if key and (winner := await repo.get_job_by_key(db, user.id, key)) is not None:
            return ScanCreated(job_id=winner.id, status=winner.status, replayed=True)
        raise
    svc.runner.start(job.id)
    return ScanCreated(job_id=job.id, status="queued", replayed=False)


async def _cleanup(svc: Services, paths: list[str]) -> None:
    if paths:
        try:
            await svc.storage.delete(paths)
        except StorageError:
            logger.warning("could not clean up %d uploaded file(s)", len(paths))


async def get_job(db: AsyncSession, svc: Services, user: CurrentUser, job_id: UUID) -> JobOut:
    job = await repo.get_job(db, user.id, job_id)
    if job is None:
        raise NotFound("Job")
    # Lazy recovery: an active job nobody is running and whose heartbeat went stale.
    if job.status in ACTIVE_JOB_STATUSES and not svc.runner.is_running(job.id):
        last = job.heartbeat_at or job.created_at
        if (datetime.now(UTC) - last).total_seconds() > svc.settings.job_stale_seconds:
            await mark_job_failed(db, job.id, "interrupted",
                                  "Reading this receipt was interrupted. Tap retry to continue.", retryable=True)
            await db.commit()
            await db.refresh(job)
    return job_out(job)


async def cancel_job(db: AsyncSession, svc: Services, user: CurrentUser, job_id: UUID) -> JobOut:
    job = await repo.get_job(db, user.id, job_id)
    if job is None:
        raise NotFound("Job")
    if await mark_job_failed(db, job.id, "cancelled", "Scan cancelled.", retryable=True, status="cancelled"):
        await db.commit()
        await svc.runner.cancel(job.id)
    await db.refresh(job)
    return job_out(job)


async def retry_job(db: AsyncSession, svc: Services, user: CurrentUser, job_id: UUID) -> JobOut:
    job = await repo.get_job(db, user.id, job_id)
    if job is None:
        raise NotFound("Job")
    if job.status not in ("failed", "cancelled") or not job.retryable:
        raise Conflict("not_retryable", "This scan can't be retried.")
    bill = await bills_repo.get_bill(db, user.id, job.bill_id, for_update=True)
    if bill is None:
        raise NotFound("Bill")
    other = await repo.active_job_for_bill(db, bill.id)
    if other is not None:
        raise Conflict("scan_in_progress", "This bill is already being scanned.", job_id=str(other.id))

    if job.ocr_text is None:
        files = await repo.files_for_job(db, job.id)
        cached = set((await repo.cached_ocr(db, user.id, [f.sha256 for f in files])).keys())
        pdf_pages = svc.settings.ocr_max_pdf_pages
        extra = sum(pdf_pages if f.mime == "application/pdf" else 1 for f in files if f.sha256 not in cached)
        await _check_quota(db, svc, user, extra)
    else:
        used, budget = await llm_budget_state(db, svc.settings)
        if used >= budget:
            state = await quota_state(db, svc.settings, user.id, user.monthly_scan_quota)
            raise quota_error("llm_budget", state)

    now = datetime.now(UTC)
    job.status, job.attempts, job.retryable = "queued", job.attempts + 1, False
    job.error_code = job.error_message = None
    job.finished_at = None
    job.heartbeat_at = now
    await db.execute(update(Bill).where(Bill.id == bill.id).values(status="scanning", updated_at=now))
    await db.commit()
    await db.refresh(job)
    svc.runner.start(job.id)
    return job_out(job)


async def file_url(db: AsyncSession, svc: Services, user: CurrentUser, bill_id: UUID, file_id: UUID) -> SignedUrlOut:
    if await bills_repo.get_bill(db, user.id, bill_id) is None:
        raise NotFound("Bill")
    f = await repo.get_file(db, user.id, bill_id, file_id)
    if f is None:
        raise NotFound("File")
    if f.deleted_at is not None or f.expires_at <= datetime.now(UTC):
        raise AppError(410, "file_expired", "Receipt photos are deleted after "
                       f"{svc.settings.receipt_retention_days} days.")
    ttl = svc.settings.signed_url_ttl_seconds
    try:
        url = await svc.storage.signed_url(f.storage_path, ttl)
    except StorageError as exc:
        raise AppError(503, "storage_unavailable", "Couldn't load the receipt photo.") from exc
    return SignedUrlOut(url=url, expires_in=ttl, mime=f.mime)
