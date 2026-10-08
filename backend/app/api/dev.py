"""Dev-only: serves LocalStorage files behind HMAC-signed, expiring URLs
(mirrors Supabase signed URLs). Mounted only when STORAGE_BACKEND=local."""

from __future__ import annotations

from fastapi import APIRouter, Response

from app.errors import NotFound
from app.integrations.storage import LocalStorage, StorageError
from app.services.container import ServicesDep

router = APIRouter(prefix="/dev", tags=["dev"], include_in_schema=False)

_MIME = {"jpg": "image/jpeg", "png": "image/png", "heic": "image/heif", "pdf": "application/pdf"}


@router.get("/files/{path:path}")
async def dev_file(path: str, exp: int, sig: str, services: ServicesDep) -> Response:
    storage = services.storage
    if not isinstance(storage, LocalStorage) or not storage.verify(path, exp, sig):
        raise NotFound("File")
    try:
        data = await storage.get(path)
    except StorageError:
        raise NotFound("File") from None
    return Response(data, media_type=_MIME.get(path.rsplit(".", 1)[-1], "application/octet-stream"),
                    headers={"Cache-Control": "private, max-age=60"})
