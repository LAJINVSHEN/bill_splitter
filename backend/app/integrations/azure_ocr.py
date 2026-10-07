"""Azure Document Intelligence (prebuilt-layout → markdown) with the async client.

One call per file (a photo is one page; a PDF is limited to ``OCR_MAX_PDF_PAGES``,
which is all F0 analyses anyway). A process-wide semaphore bounds concurrent calls so
the F0 rate limit isn't hit when several scans run at once; azure-core already retries
429s honouring Retry-After.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Protocol

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


class AzureOcrClient:
    provider = "azure"

    def __init__(self, endpoint: str, key: str, *, max_concurrency: int, max_pdf_pages: int,
                 timeout_seconds: float) -> None:
        from azure.ai.documentintelligence.aio import DocumentIntelligenceClient
        from azure.core.credentials import AzureKeyCredential

        endpoint = endpoint.strip().rstrip("/")
        if endpoint and not endpoint.startswith("https://"):
            endpoint = f"https://{endpoint}"
        if not endpoint or not key:
            raise OcrError("ocr_not_configured", "Azure Document Intelligence is not configured", retryable=False)
        self._client = DocumentIntelligenceClient(endpoint=endpoint, credential=AzureKeyCredential(key))
        self._sem = asyncio.Semaphore(max(1, max_concurrency))
        self.max_pdf_pages = max(1, max_pdf_pages)
        self.timeout = timeout_seconds

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
                    )
                    submitted = True
                    result = await poller.result()
            except TimeoutError as exc:
                raise OcrError("ocr_timeout", "Reading the receipt took too long.", submitted=submitted) from exc
            except HttpResponseError as exc:
                status = exc.status_code or 0
                retryable = status in (408, 429) or status >= 500
                code = "ocr_rate_limited" if status == 429 else ("ocr_rejected" if 400 <= status < 500 else "ocr_failed")
                raise OcrError(code, f"Azure rejected the document (HTTP {status}).", retryable=retryable,
                               submitted=submitted) from exc
            except AzureError as exc:
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
                              timeout_seconds=settings.ocr_timeout_seconds)
    except OcrError as exc:
        logger.warning("OCR disabled: %s", exc)
        return UnavailableOcrClient(str(exc))
