from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from app.schemas.common import OutputModel

JobStatus = Literal["queued", "ocr", "llm", "validating", "succeeded", "needs_review", "failed", "cancelled"]


class ScanCreated(OutputModel):
    job_id: UUID
    status: JobStatus
    replayed: bool


class JobOut(OutputModel):
    id: UUID
    bill_id: UUID
    status: JobStatus
    attempts: int
    error_code: str | None
    error_message: str | None
    retryable: bool
    model_used: str | None
    pages_billed: int
    validation: dict[str, Any] | None
    timings: dict[str, Any]
    heartbeat_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime
    updated_at: datetime


class SignedUrlOut(OutputModel):
    url: str
    expires_in: int
    mime: str
