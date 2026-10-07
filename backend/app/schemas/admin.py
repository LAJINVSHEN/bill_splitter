from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, Field

from app.schemas.common import CleanStr, InputModel, OutputModel

_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,31}$")
_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[A-Za-z]{2,}$")


def _username(v: str) -> str:
    v = v.strip().lower()
    if not _USERNAME_RE.match(v):
        raise ValueError("3–32 chars: letters, digits, '.', '_' or '-', starting with a letter or digit")
    return v


def _email(v: str) -> str:
    v = v.strip().lower()
    if len(v) > 254 or not _EMAIL_RE.match(v):
        raise ValueError("not a valid email address")
    return v


Username = Annotated[str, AfterValidator(_username)]
Email = Annotated[str, AfterValidator(_email)]
Quota = Annotated[int, Field(ge=0, le=10_000)]


class AdminUserOut(OutputModel):
    id: UUID
    username: str
    email: str | None
    display_name: str
    role: Literal["admin", "member"]
    must_change_password: bool
    monthly_scan_quota: int
    disabled_at: datetime | None
    created_at: datetime
    pages_used_this_month: int


class AdminUserCreate(InputModel):
    username: Username
    display_name: Annotated[CleanStr, Field(min_length=1, max_length=60)] | None = None
    # Real address (e.g. a Gmail) to allow-list Google sign-in; default is a synthetic
    # {username}@{AUTH_EMAIL_DOMAIN} address for username + password login.
    email: Email | None = None
    login: Literal["password", "google"] = "password"
    role: Literal["admin", "member"] = "member"
    monthly_scan_quota: Quota | None = None


class AdminUserCreated(OutputModel):
    user: AdminUserOut
    temp_password: str | None  # shown once (null for Google-only users)


class AdminUserPatch(InputModel):
    display_name: Annotated[CleanStr, Field(min_length=1, max_length=60)] | None = None
    role: Literal["admin", "member"] | None = None
    monthly_scan_quota: Quota | None = None
    disabled: bool | None = None


class PasswordReset(OutputModel):
    temp_password: str


class UsageTotals(OutputModel):
    ocr_pages: int
    ocr_calls: int
    llm_calls: int
    input_tokens: int
    output_tokens: int
    cost_micros: int
    failed_calls: int


class UserUsage(OutputModel):
    user_id: UUID | None
    username: str | None
    ocr_pages: int
    llm_calls: int
    cost_micros: int
    quota: int | None


class ModelUsage(OutputModel):
    model: str
    calls: int
    failed_calls: int
    input_tokens: int
    output_tokens: int
    cost_micros: int
    avg_latency_ms: int | None


class AdminUsageOut(OutputModel):
    month: str
    timezone: str
    totals: UsageTotals
    global_monthly_page_cap: int
    global_monthly_llm_budget_micros: int
    by_user: list[UserUsage]
    by_model: list[ModelUsage]


class LlmConfigOut(OutputModel):
    primary_model: str
    primary_reasoning_effort: str | None
    fallback_model: str | None
    fallback_reasoning_effort: str | None
    timeout_seconds: float
    max_retries: int
    backend: str


class AdminSettingsOut(OutputModel):
    global_monthly_page_cap: int
    global_monthly_llm_budget_micros: int
    default_user_quota: int
    scans_enabled: bool
    llm: LlmConfigOut
    ocr_backend: str
    ocr_max_pdf_pages: int
    scan_max_files: int
    scan_max_file_bytes: int
    receipt_retention_days: int
    app_timezone: str
    updated_at: datetime


class AdminSettingsPatch(InputModel):
    global_monthly_page_cap: Annotated[int, Field(ge=0, le=100_000)] | None = None
    global_monthly_llm_budget_micros: Annotated[int, Field(ge=0, le=10_000_000_000)] | None = None
    default_user_quota: Quota | None = None
    scans_enabled: bool | None = None
