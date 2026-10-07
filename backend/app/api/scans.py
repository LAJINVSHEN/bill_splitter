from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.errors import AppError, BadRequest
from app.middleware.auth import CurrentUserDep
from app.ratelimit import limiter, scans_limit
from app.schemas.scans import JobOut, ScanCreated, SignedUrlOut
from app.services import scans as svc
from app.services.container import ServicesDep

router = APIRouter(tags=["scans"])
DB = Annotated[AsyncSession, Depends(get_db)]


async def _read_uploads(request: Request, max_files: int, max_bytes: int) -> list[svc.Upload]:
    form = await request.form(max_files=max_files + 1, max_fields=20)
    files = [v for k, v in form.multi_items() if k in ("files", "file") and isinstance(v, UploadFile)]
    if len(files) > max_files:
        raise BadRequest("too_many_files", f"Attach at most {max_files} files per scan.")
    uploads = []
    for f in files:
        data = await f.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise AppError(413, "file_too_large", f"Each file must be under {max_bytes // (1024 * 1024)} MB.")
        uploads.append(svc.Upload(filename=(f.filename or "receipt")[:200], data=data))
    return uploads


@router.post("/bills/{bill_id}/scans", response_model=ScanCreated, status_code=202,
             responses={200: {"description": "Idempotent replay of an earlier request"}})
@limiter.limit(scans_limit)
async def create_scan(
    request: Request,
    bill_id: UUID,
    user: CurrentUserDep,
    db: DB,
    services: ServicesDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JSONResponse:
    """multipart/form-data with one or more ``files`` parts (JPEG/PNG/HEIF/PDF).
    Returns 202 ``{job_id}``; poll ``GET /jobs/{job_id}``."""
    settings = services.settings
    uploads = await _read_uploads(request, settings.scan_max_files, settings.scan_max_file_bytes)
    result = await svc.create_scan(db, services, user, bill_id, uploads, idempotency_key)
    return JSONResponse(result.model_dump(mode="json"), status_code=200 if result.replayed else 202)


@router.get("/jobs/{job_id}", response_model=JobOut)
async def get_job(job_id: UUID, user: CurrentUserDep, db: DB, services: ServicesDep) -> JobOut:
    return await svc.get_job(db, services, user, job_id)


@router.post("/jobs/{job_id}/cancel", response_model=JobOut)
async def cancel_job(job_id: UUID, user: CurrentUserDep, db: DB, services: ServicesDep) -> JobOut:
    return await svc.cancel_job(db, services, user, job_id)


@router.post("/jobs/{job_id}/retry", response_model=JobOut, status_code=202)
@limiter.limit(scans_limit)
async def retry_job(request: Request, job_id: UUID, user: CurrentUserDep, db: DB, services: ServicesDep) -> JobOut:
    return await svc.retry_job(db, services, user, job_id)


@router.get("/bills/{bill_id}/files/{file_id}", response_model=SignedUrlOut)
async def file_url(bill_id: UUID, file_id: UUID, user: CurrentUserDep, db: DB, services: ServicesDep) -> SignedUrlOut:
    """A short-lived signed URL for a stored receipt photo/PDF."""
    return await svc.file_url(db, services, user, bill_id, file_id)
