"""In-process scan pipeline (asyncio tasks – no Celery/Redis).

Stages, each persisted before the next starts so a retry resumes where it stopped:

1. ``ocr``        – per file: OCR cache (owner + sha256) or Azure; usage row per call.
                    Joined markdown → ``extraction_jobs.ocr_text``.
2. ``llm``        – primary model, escalating to the fallback on error/timeout/failed
                    reconciliation; usage row per call; result → ``extracted`` + ``validation``.
3. ``validating`` – write items/charges/totals onto the bill; job → ``succeeded`` or
                    ``needs_review`` (validation failure is not an error).

Every write that changes job state is conditional on the job still being active, so
a cancel always wins over a late pipeline write.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.ocr_text import join_pages
from app.integrations.azure_ocr import OcrError
from app.integrations.llm import LlmCall
from app.integrations.storage import StorageError
from app.models import Bill, ExtractionJob, ReceiptFile, UsageEvent
from app.models.scan import ACTIVE_JOB_STATUSES
from app.repositories import bills as bills_repo
from app.repositories import scans as repo
from app.schemas.extraction import ReceiptExtraction
from app.services.extraction import extract_with_escalation, extraction_to_core, validate_extraction
from app.services.split_view import validation_out

if TYPE_CHECKING:
    from app.services.container import Services

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(UTC)


class StageFailed(Exception):
    def __init__(self, code: str, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class JobGone(Exception):
    """The job is no longer active (cancelled or finished elsewhere)."""


async def mark_job_failed(db: AsyncSession, job_id: UUID, code: str, message: str, retryable: bool,
                          status: str = "failed") -> bool:
    """Fail an active job and put its bill back to ``draft`` if it was scanning."""
    job = await db.scalar(select(ExtractionJob).where(ExtractionJob.id == job_id).with_for_update())
    if job is None or job.status not in ACTIVE_JOB_STATUSES:
        return False
    job.status, job.error_code, job.error_message, job.retryable = status, code, message, retryable
    job.finished_at = _now()
    await db.execute(update(Bill).where(Bill.id == job.bill_id, Bill.status == "scanning")
                     .values(status="draft", updated_at=func.now()))
    return True


class JobRunner:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self.sm = sessionmaker
        self.services: Services | None = None
        self.tasks: dict[UUID, asyncio.Task[None]] = {}

    # ------------------------------------------------------------------ lifecycle
    def start(self, job_id: UUID) -> None:
        if job_id in self.tasks and not self.tasks[job_id].done():
            return
        task = asyncio.create_task(self._run(job_id), name=f"scan-job-{job_id}")
        self.tasks[job_id] = task
        task.add_done_callback(lambda _t, jid=job_id: self.tasks.pop(jid, None))

    def is_running(self, job_id: UUID) -> bool:
        task = self.tasks.get(job_id)
        return task is not None and not task.done()

    async def cancel(self, job_id: UUID) -> bool:
        task = self.tasks.get(job_id)
        if task is None or task.done():
            return False
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=5)
        except (asyncio.CancelledError, TimeoutError, Exception):  # noqa: BLE001 - task outcome is irrelevant here
            pass
        return True

    async def drain(self, timeout: float = 30) -> None:
        """Wait for all running jobs (tests)."""
        deadline = time.monotonic() + timeout
        while self.tasks and time.monotonic() < deadline:
            await asyncio.wait(list(self.tasks.values()), timeout=max(0.01, deadline - time.monotonic()))

    async def shutdown(self) -> None:
        """Graceful stop: cancel running jobs and mark them interrupted (retryable)."""
        ids = [jid for jid, t in self.tasks.items() if not t.done()]
        for jid in ids:
            self.tasks[jid].cancel()
        if ids:
            await asyncio.gather(*(self.tasks[j] for j in ids if j in self.tasks), return_exceptions=True)
            async with self.sm() as db:
                for jid in ids:
                    await mark_job_failed(db, jid, "interrupted", "The server restarted while reading this receipt.",
                                          retryable=True)
                await db.commit()

    # ------------------------------------------------------------------ helpers
    @property
    def svc(self) -> Services:
        assert self.services is not None, "JobRunner.services not set"
        return self.services

    async def _update(self, job_id: UUID, **values: Any) -> None:
        async with self.sm() as db:
            ok = await repo.update_job_if_active(db, job_id, **values)
            await db.commit()
        if not ok:
            raise JobGone

    async def _record_usage(self, job_id: UUID, owner_id: UUID, **values: Any) -> None:
        async with self.sm() as db:
            db.add(UsageEvent(user_id=owner_id, job_id=job_id, **values))
            await db.execute(update(ExtractionJob).where(ExtractionJob.id == job_id).values(
                pages_billed=ExtractionJob.pages_billed + values.get("pages", 0),
                cost_micros=ExtractionJob.cost_micros + values.get("cost_micros", 0),
            ))
            await db.commit()

    async def _heartbeat(self, job_id: UUID) -> None:
        interval = self.svc.settings.job_heartbeat_seconds
        while True:
            await asyncio.sleep(interval)
            try:
                async with self.sm() as db:
                    alive = await repo.update_job_if_active(db, job_id, heartbeat_at=_now())
                    await db.commit()
                if not alive:
                    return
            except Exception:  # noqa: BLE001 - a missed heartbeat must not kill the job
                logger.warning("heartbeat failed for job %s", job_id)

    # ------------------------------------------------------------------ main
    async def _run(self, job_id: UUID) -> None:
        heartbeat = asyncio.create_task(self._heartbeat(job_id))
        try:
            await self._pipeline(job_id)
        except JobGone:
            logger.info("job %s stopped: no longer active", job_id)
        except StageFailed as exc:
            async with self.sm() as db:
                await mark_job_failed(db, job_id, exc.code, exc.message, exc.retryable)
                await db.commit()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("job %s crashed", job_id)
            async with self.sm() as db:
                await mark_job_failed(db, job_id, "internal_error", "Something went wrong while reading the receipt.",
                                      retryable=True)
                await db.commit()
        finally:
            heartbeat.cancel()

    async def _pipeline(self, job_id: UUID) -> None:
        async with self.sm() as db:
            job = await repo.get_job_by_id(db, job_id)
            if job is None or job.status not in ACTIVE_JOB_STATUSES:
                return
            owner_id, bill_id = job.owner_id, job.bill_id
            ocr_text, extracted = job.ocr_text, job.extracted
            timings: dict[str, Any] = dict(job.timings or {})
        started = time.perf_counter()
        await self._update(job_id, started_at=_now(), heartbeat_at=_now())

        # 1. OCR -------------------------------------------------------------
        if ocr_text is None:
            await self._update(job_id, status="ocr", heartbeat_at=_now())
            t0 = time.perf_counter()
            ocr_text = await self._ocr_stage(job_id, owner_id)
            timings["ocr_ms"] = int((time.perf_counter() - t0) * 1000)
            if not ocr_text.strip():
                raise StageFailed("ocr_empty", "We couldn't find any text on that receipt. Try a clearer photo.",
                                  retryable=False)
            await self._update(job_id, ocr_text=ocr_text, timings=timings)

        # 2. LLM -------------------------------------------------------------
        if extracted is None:
            await self._update(job_id, status="llm", heartbeat_at=_now())
            t0 = time.perf_counter()
            extraction, model_used = await self._llm_stage(job_id, owner_id, ocr_text)
            timings["llm_ms"] = int((time.perf_counter() - t0) * 1000)
            validation = validate_extraction(extraction)
            await self._update(job_id, extracted=extraction.model_dump(mode="json"), model_used=model_used,
                               validation=validation_out(validation).model_dump(mode="json"), timings=timings)
        else:
            extraction = ReceiptExtraction.model_validate(extracted)

        # 3. Apply -----------------------------------------------------------
        await self._update(job_id, status="validating", heartbeat_at=_now())
        timings["total_ms"] = int((time.perf_counter() - started) * 1000)
        await self._apply_stage(job_id, owner_id, bill_id, extraction, timings)

    # ------------------------------------------------------------------ stages
    async def _ocr_stage(self, job_id: UUID, owner_id: UUID) -> str:
        svc = self.svc
        async with self.sm() as db:
            files = await repo.files_for_job(db, job_id)
            cache = await repo.cached_ocr(db, owner_id, [f.sha256 for f in files])
        if not files:
            raise StageFailed("no_files", "No receipt files were attached to this scan.", retryable=False)

        async def one(f: ReceiptFile) -> str:
            hit = cache.get(f.sha256)
            if hit is not None:
                return hit.ocr_text
            try:
                data = await svc.storage.get(f.storage_path)
            except StorageError as exc:
                raise StageFailed("file_missing", "A receipt photo is no longer available.", retryable=False) from exc
            estimate = svc.settings.ocr_max_pdf_pages if f.mime == "application/pdf" else 1
            try:
                result = await svc.ocr.analyze(data, f.mime)
            except OcrError as exc:
                await self._record_usage(job_id, owner_id, kind="ocr", provider=svc.ocr.provider,
                                         model="prebuilt-layout", pages=estimate if exc.submitted else 0, ok=False,
                                         error_code=exc.code)
                raise StageFailed(exc.code, str(exc), exc.retryable) from exc
            except asyncio.CancelledError:
                await asyncio.shield(self._record_usage(
                    job_id, owner_id, kind="ocr", provider=svc.ocr.provider, model="prebuilt-layout",
                    pages=estimate, ok=False, error_code="cancelled"))
                raise
            await self._record_usage(job_id, owner_id, kind="ocr", provider=svc.ocr.provider, model=result.model,
                                     pages=result.pages, latency_ms=result.latency_ms, ok=True)
            async with self.sm() as db:
                await repo.put_ocr_cache(db, owner_id, f.sha256, result.text, result.pages)
                await db.execute(update(ReceiptFile).where(ReceiptFile.id == f.id).values(pages=result.pages))
                await db.commit()
            return result.text

        results = await asyncio.gather(*(one(f) for f in files), return_exceptions=True)
        for r in results:
            if isinstance(r, BaseException):
                raise r
        return join_pages([r for r in results if isinstance(r, str)])

    async def _llm_stage(self, job_id: UUID, owner_id: UUID, text: str) -> tuple[ReceiptExtraction, str]:
        svc = self.svc
        current: dict[str, str] = {}

        async def on_call(call: LlmCall) -> None:
            current.pop("model", None)
            await self._record_usage(
                job_id, owner_id, kind="llm", provider=svc.llm.provider, model=call.model or call.requested_model,
                input_tokens=call.input_tokens, cached_input_tokens=call.cached_input_tokens,
                output_tokens=call.output_tokens, cost_micros=call.cost_micros, latency_ms=call.latency_ms,
                ok=call.ok, error_code=call.error_code,
            )

        async def before_call(model: str) -> None:
            await self._check_llm_budget()
            current["model"] = model
            await self._update(job_id, heartbeat_at=_now())

        try:
            outcome = await extract_with_escalation(svc.llm, text, svc.settings.llm_models, on_call, before_call)
        except asyncio.CancelledError:
            if "model" in current:
                await asyncio.shield(self._record_usage(job_id, owner_id, kind="llm", provider=svc.llm.provider,
                                                        model=current["model"], ok=False, error_code="cancelled"))
            raise
        if outcome.extraction is None:
            last = outcome.calls[-1] if outcome.calls else None
            code = (last.error_code if last else None) or "llm_failed"
            raise StageFailed(code, "We couldn't understand the receipt. Try again or enter it manually.",
                              retryable=code != "llm_not_configured")
        return outcome.extraction, outcome.model or ""

    async def _check_llm_budget(self) -> None:
        from app.services.usage import llm_budget_state

        async with self.sm() as db:
            used, budget = await llm_budget_state(db, self.svc.settings)
        if used >= budget:
            raise StageFailed("quota_llm_budget", "The app has reached this month's AI budget. "
                              "You can still enter the bill manually.", retryable=True)

    async def _apply_stage(self, job_id: UUID, owner_id: UUID, bill_id: UUID, extraction: ReceiptExtraction,
                           timings: dict[str, Any]) -> None:
        from app.services.bills import ChargeSpec, ItemSpec, parse_bill_date, replace_receipt

        items, charges, grand, subtotal = extraction_to_core(extraction)
        validation = validate_extraction(extraction)
        async with self.sm() as db:
            job = await db.scalar(select(ExtractionJob).where(ExtractionJob.id == job_id).with_for_update())
            if job is None or job.status not in ACTIVE_JOB_STATUSES:
                raise JobGone
            bill = await bills_repo.get_bill(db, owner_id, bill_id, full=True, for_update=True)
            if bill is None:
                raise StageFailed("bill_deleted", "This bill was deleted.", retryable=False)
            await replace_receipt(
                db, bill,
                [ItemSpec(None, i.name[:200], i.quantity, i.unit_price_cents, i.total_price_cents) for i in items],
                [ChargeSpec(c.name[:120], c.amount_cents) for c in charges],
                subtotal, grand,
            )
            store = extraction.store
            if store.name and store.name.strip():
                bill.merchant = store.name.strip()[:120]
                bill.title = bill.title or bill.merchant
            bill.bill_date = parse_bill_date(extraction.date) or bill.bill_date
            bill.receipt_meta = {k: v for k, v in {
                "receipt_number": extraction.receipt_number, "time": extraction.time,
                "store_address": store.address, "store_phone": store.phone,
                "payment_method": extraction.payment_method, "transaction_id": extraction.transaction_id,
                "notes": extraction.notes,
            }.items() if v}
            bill.status = "review"
            job.status = "succeeded" if validation.ok else "needs_review"
            job.error_code = None if validation.ok else (validation.errors[0].code if validation.errors else None)
            job.error_message = None if validation.ok else validation.message
            job.retryable = False
            job.finished_at = _now()
            job.heartbeat_at = _now()
            job.timings = timings
            await db.commit()


async def recover_stale_jobs(sm: async_sessionmaker[AsyncSession], stale_seconds: float,
                             skip: Callable[[UUID], bool] | None = None) -> int:
    """Active jobs whose heartbeat is older than ``stale_seconds`` → failed{interrupted, retryable}."""
    cutoff = _now() - timedelta(seconds=stale_seconds)
    count = 0
    async with sm() as db:
        for job in await repo.stale_active_jobs(db, cutoff):
            if skip is not None and skip(job.id):
                continue
            if await mark_job_failed(db, job.id, "interrupted",
                                     "Reading this receipt was interrupted. Tap retry to continue.", retryable=True):
                count += 1
        await db.commit()
    return count

