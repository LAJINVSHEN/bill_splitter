"""Process-wide service objects (built in the app lifespan, swapped for fakes in tests)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated

from fastapi import Depends, Request

from app.config import Settings
from app.integrations.azure_ocr import OcrClient
from app.integrations.llm import LlmClient
from app.integrations.storage import Storage
from app.integrations.supabase_admin import SupabaseAdmin

if TYPE_CHECKING:
    from app.services.pipeline import JobRunner


@dataclass
class Services:
    settings: Settings
    storage: Storage
    ocr: OcrClient
    llm: LlmClient
    auth_admin: SupabaseAdmin
    runner: JobRunner


def get_services(request: Request) -> Services:
    return request.app.state.services


ServicesDep = Annotated[Services, Depends(get_services)]
