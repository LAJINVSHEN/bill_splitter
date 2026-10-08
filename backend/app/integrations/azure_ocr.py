"""Azure Document Intelligence (prebuilt-layout → markdown) with the async client.

Hard F0 guardrails live here and in ``services.usage`` / ``services.scans``:

* **Every HTTP request to Azure** (the analyze POST, each poll GET, each SDK retry) takes a
  slot from a process-wide sliding-window limiter (``AZURE_DI_CALLS_PER_MINUTE``, never above
  the provider's ``AZURE_DI_CALLS_PER_MINUTE_LIMIT``). It is an azure-core *per-retry*
  pipeline policy, so nothing bypasses it. Callers wait for a slot (bounded by
  ``OCR_RATE_WAIT_SECONDS``); a 429 blocks the limiter for ``Retry-After``. One uvicorn
  worker means an in-process limiter is the whole truth.
* Polls run every ``OCR_POLL_INTERVAL_SECONDS`` (~3 s) to keep GETs low.
* A 401/403 "quota"-style answer raises ``OcrError(code="provider_quota")`` so the pipeline
  pauses scanning for the rest of the month instead of retrying.

One call per file: a photo is one page; a PDF is limited to ``OCR_MAX_PDF_PAGES`` (all F0
analyses anyway). A semaphore also bounds concurrent analyses.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.config import Settings

logger = logging.getLogger(__name__)


class OcrError(Exception):
    def __init__(self, code: str, message: str, *, retryable: bool = True, submitted: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.submitted = submitted  # Azure accepted the document (pages are likely billed)


@dataclass(frozen=True)
class OcrResult:
    text: str
    pages: int
    latency_ms: int
    model: str = "prebuilt-layout"


class OcrClient(Protocol):
    provider: str

    async def analyze(self, data: bytes, mime: str) -> OcrResult: ...
    async def aclose(self) -> None: ...


# ------------------------------------------------------------------------------------ limiter
class RateLimitWaitExceeded(Exception):
    """No limiter slot within the allowed wait."""


class SlidingWindowLimiter:
    """At most ``limit`` acquisitions in any ``window`` seconds, process-wide.

    Waiters queue FIFO (the lock is held while sleeping). ``block_for`` pauses everyone, e.g.
    after a 429 with Retry-After. ``clock``/``sleep`` are injectable for tests.
    """

    def __init__(self, limit: int, window: float = 60.0, *, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
        self.limit = max(1, limit)
        self.window = window
        self.clock = clock
        self.sleep = sleep
        self._times: deque[float] = deque()
        self._blocked_until = 0.0
        self._lock = asyncio.Lock()
        self.acquired = 0  # total slots handed out (observability/tests)

    def block_for(self, seconds: float) -> None:
        self._blocked_until = max(self._blocked_until, self.clock() + max(0.0, seconds))

    async def acquire(self, max_wait: float) -> None:
        deadline = self.clock() + max_wait
        async with self._lock:
            while True:
                now = self.clock()
                while self._times and now - self._times[0] >= self.window:
                    self._times.popleft()
                if self._blocked_until > now:
                    wait = self._blocked_until - now
                elif len(self._times) >= self.limit:
                    wait = self.window - (now - self._times[0])
                else:
                    self._times.append(now)
                    self.acquired += 1
                    return
                if now + wait > deadline:
                    raise RateLimitWaitExceeded(f"no Azure request slot within {max_wait:.0f}s")
                await self.sleep(wait)


def _retry_after_seconds(headers: Any, default: float = 60.0) -> float:
    headers = {str(k).lower(): v for k, v in (headers or {}).items()}
    for name in ("retry-after-ms", "x-ms-retry-after-ms"):
        value = headers.get(name)
        if value:
            try:
                return float(value) / 1000
            except ValueError:
                pass
    value = headers.get("retry-after")
    try:
        return float(value) if value else default
    except ValueError:
        return default


def make_rate_limit_policy(limiter: SlidingWindowLimiter, max_wait: float):  # noqa: ANN201 - azure-core type
    """azure-core per-retry policy: one limiter slot per HTTP request; 429 → back off."""
    from azure.core.pipeline.policies import AsyncHTTPPolicy

    class AzureRateLimitPolicy(AsyncHTTPPolicy):
        async def send(self, request):  # noqa: ANN001, ANN202
            await limiter.acquire(max_wait)
            response = await self.next.send(request)
            http = response.http_response
            if http.status_code == 429:
                delay = _retry_after_seconds(http.headers)
                logger.warning("Azure DI returned 429; pausing all Azure requests for %.0fs", delay)
                limiter.block_for(delay)
            return response

    return AzureRateLimitPolicy()


def is_quota_exhausted(status: int, message: str) -> bool:
    """F0 monthly allowance used up: Azure answers 401/403 with a quota message."""
    return status in (401, 403) and "quota" in (message or "").lower()


# ------------------------------------------------------------------------------------ clients
class AzureOcrClient:
    provider = "azure"

    def __init__(self, endpoint: str, key: str, *, max_concurrency: int, max_pdf_pages: int,
                 timeout_seconds: float, calls_per_minute: int = 15, rate_wait_seconds: float = 90.0,
                 poll_interval_seconds: float = 3.0, limiter: SlidingWindowLimiter | None = None) -> None:
        from azure.ai.documentintelligence.aio import DocumentIntelligenceClient
        from azure.core.credentials import AzureKeyCredential

        endpoint = endpoint.strip().rstrip("/")
        if endpoint and not endpoint.startswith("https://"):
            endpoint = f"https://{endpoint}"
        if not endpoint or not key:
            raise OcrError("ocr_not_configured", "Azure Document Intelligence is not configured", retryable=False)
        self.limiter = limiter or SlidingWindowLimiter(calls_per_minute)
        self.rate_policy = make_rate_limit_policy(self.limiter, rate_wait_seconds)
        self._client = DocumentIntelligenceClient(
            endpoint=endpoint, credential=AzureKeyCredential(key),
            per_retry_policies=[self.rate_policy],  # after RetryPolicy → every attempt pays a slot
            retry_total=3, retry_backoff_factor=2.0,
        )
        self._sem = asyncio.Semaphore(max(1, max_concurrency))
        self.max_pdf_pages = max(1, max_pdf_pages)
        self.timeout = timeout_seconds
        self.poll_interval = poll_interval_seconds

    async def analyze(self, data: bytes, mime: str) -> OcrResult:
        from azure.ai.documentintelligence.models import AnalyzeDocumentRequest, DocumentContentFormat
        from azure.core.exceptions import AzureError, HttpResponseError

        pages = f"1-{self.max_pdf_pages}" if mime == "application/pdf" else None
        submitted = False
        async with self._sem:
            started = time.perf_counter()
            try:
                async with asyncio.timeout(self.timeout):
                    poller = await self._client.begin_analyze_document(
                        "prebuilt-layout",
                        AnalyzeDocumentRequest(bytes_source=data),
                        pages=pages,
                        output_content_format=DocumentContentFormat.MARKDOWN,
                        polling_interval=self.poll_interval,
                    )
                    submitted = True
                    result = await poller.result()
            except RateLimitWaitExceeded as exc:
                raise OcrError("ocr_rate_limited", "The OCR service is busy. Try again in a minute.",
                               submitted=submitted) from exc
            except TimeoutError as exc:
                raise OcrError("ocr_timeout", "Reading the receipt took too long.", submitted=submitted) from exc
            except HttpResponseError as exc:
                status = exc.status_code or 0
                if is_quota_exhausted(status, str(exc.message or exc)):
                    raise OcrError("provider_quota", "The free OCR allowance for this month is used up.",
                                   retryable=False, submitted=submitted) from exc
                retryable = status in (408, 429) or status >= 500
                code = "ocr_rate_limited" if status == 429 else ("ocr_rejected" if 400 <= status < 500 else "ocr_failed")
                raise OcrError(code, f"Azure rejected the document (HTTP {status}).", retryable=retryable,
                               submitted=submitted) from exc
            except AzureError as exc:
                if isinstance(exc.__cause__, RateLimitWaitExceeded) or "RateLimitWaitExceeded" in repr(exc):
                    raise OcrError("ocr_rate_limited", "The OCR service is busy. Try again in a minute.",
                                   submitted=submitted) from exc
                raise OcrError("ocr_failed", "Couldn't reach the OCR service.", submitted=submitted) from exc
            latency_ms = int((time.perf_counter() - started) * 1000)
        page_count = len(result.pages or []) or 1
        return OcrResult(text=(result.content or "").strip(), pages=page_count, latency_ms=latency_ms)

    async def aclose(self) -> None:
        await self._client.close()


@dataclass
class FakeOcrClient:
    """Deterministic OCR for tests/dev: returns ``texts[sha256]`` or ``default_text``."""

    provider: str = "fake"
    default_text: str = "STORE\nItem A 10.00\nTOTAL 10.00"
    texts: dict[str, str] = field(default_factory=dict)
    pages_for_pdf: int = 2
    fail_with: OcrError | None = None
    delay: float = 0.0
    calls: int = 0

    async def analyze(self, data: bytes, mime: str) -> OcrResult:
        import hashlib

        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail_with is not None:
            raise self.fail_with
        sha = hashlib.sha256(data).hexdigest()
        pages = self.pages_for_pdf if mime == "application/pdf" else 1
        return OcrResult(text=self.texts.get(sha, self.default_text), pages=pages, latency_ms=5)

    async def aclose(self) -> None:
        return None


class UnavailableOcrClient:
    provider = "azure"

    def __init__(self, reason: str) -> None:
        self.reason = reason

    async def analyze(self, data: bytes, mime: str) -> OcrResult:
        raise OcrError("ocr_not_configured", self.reason, retryable=False)

    async def aclose(self) -> None:
        return None


def build_ocr(settings: Settings) -> OcrClient:
    if settings.ocr_backend == "fake":
        return FakeOcrClient()
    try:
        return AzureOcrClient(settings.azure_di_endpoint, settings.azure_di_key,
                              max_concurrency=settings.ocr_max_concurrency,
                              max_pdf_pages=settings.ocr_max_pdf_pages,
                              timeout_seconds=settings.ocr_timeout_seconds,
                              calls_per_minute=settings.azure_calls_per_minute_effective,
                              rate_wait_seconds=settings.ocr_rate_wait_seconds,
                              poll_interval_seconds=settings.ocr_poll_interval_seconds)
    except OcrError as exc:
        logger.warning("OCR disabled: %s", exc)
        return UnavailableOcrClient(str(exc))
