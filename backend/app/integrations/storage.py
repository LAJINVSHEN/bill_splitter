"""Receipt file storage: Supabase Storage (private bucket) or the local filesystem (dev/tests)."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import time
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)


class StorageError(Exception):
    pass


class Storage(Protocol):
    async def put(self, path: str, data: bytes, content_type: str) -> None: ...
    async def get(self, path: str) -> bytes: ...
    async def delete(self, paths: list[str]) -> None: ...
    async def signed_url(self, path: str, expires_in: int) -> str: ...
    async def aclose(self) -> None: ...


def _safe_path(path: str) -> str:
    parts = [p for p in path.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        raise StorageError("invalid storage path")
    return "/".join(parts)


class LocalStorage:
    """Files under ``LOCAL_STORAGE_DIR``; signed URLs point at the dev-only
    ``GET /api/dev/files/{path}?exp=&sig=`` route (HMAC with ``secret``)."""

    def __init__(self, root: str | Path, secret: str, url_base: str = "") -> None:
        self.root = Path(root)
        self.secret = (secret or "local-dev-storage").encode()
        self.url_base = url_base.rstrip("/")

    def _file(self, path: str) -> Path:
        return self.root / _safe_path(path)

    async def put(self, path: str, data: bytes, content_type: str) -> None:
        target = self._file(path)

        def _write() -> None:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

        await asyncio.to_thread(_write)

    async def get(self, path: str) -> bytes:
        target = self._file(path)
        try:
            return await asyncio.to_thread(target.read_bytes)
        except FileNotFoundError as exc:
            raise StorageError("file not found") from exc

    async def delete(self, paths: list[str]) -> None:
        def _rm() -> None:
            for p in paths:
                self._file(p).unlink(missing_ok=True)

        await asyncio.to_thread(_rm)

    def sign(self, path: str, exp: int) -> str:
        return hmac.new(self.secret, f"{_safe_path(path)}:{exp}".encode(), hashlib.sha256).hexdigest()

    def verify(self, path: str, exp: int, sig: str) -> bool:
        return exp >= int(time.time()) and hmac.compare_digest(self.sign(path, exp), sig)

    async def signed_url(self, path: str, expires_in: int) -> str:
        exp = int(time.time()) + expires_in
        return f"{self.url_base}/api/dev/files/{quote(_safe_path(path))}?exp={exp}&sig={self.sign(path, exp)}"

    async def aclose(self) -> None:
        return None


class SupabaseStorage:
    """Supabase Storage REST API with the service-role key (server only)."""

    def __init__(self, supabase_url: str, service_key: str, bucket: str, timeout: float = 30.0) -> None:
        if not supabase_url or not service_key:
            raise StorageError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase Storage")
        self.base = f"{supabase_url}/storage/v1"
        self.bucket = bucket
        headers = {"apikey": service_key}
        if service_key.startswith("eyJ"):  # legacy JWT service_role key; sb_secret_ keys go in apikey only
            headers["Authorization"] = f"Bearer {service_key}"
        self.client = httpx.AsyncClient(timeout=timeout, headers=headers)

    async def ensure_bucket(self) -> None:
        resp = await self.client.post(f"{self.base}/bucket", json={"id": self.bucket, "name": self.bucket,
                                                                  "public": False})
        if resp.status_code not in (200, 201, 400, 409):  # 400/409 = already exists
            raise StorageError(f"create bucket failed: HTTP {resp.status_code}")

    async def put(self, path: str, data: bytes, content_type: str) -> None:
        url = f"{self.base}/object/{self.bucket}/{quote(_safe_path(path))}"
        resp = await self.client.post(url, content=data, headers={"Content-Type": content_type, "x-upsert": "true"})
        if resp.status_code >= 300:
            raise StorageError(f"upload failed: HTTP {resp.status_code}")

    async def get(self, path: str) -> bytes:
        resp = await self.client.get(f"{self.base}/object/{self.bucket}/{quote(_safe_path(path))}")
        if resp.status_code >= 300:
            raise StorageError(f"download failed: HTTP {resp.status_code}")
        return resp.content

    async def delete(self, paths: list[str]) -> None:
        if not paths:
            return
        resp = await self.client.request("DELETE", f"{self.base}/object/{self.bucket}",
                                         json={"prefixes": [_safe_path(p) for p in paths]})
        if resp.status_code >= 300:
            raise StorageError(f"delete failed: HTTP {resp.status_code}")

    async def signed_url(self, path: str, expires_in: int) -> str:
        resp = await self.client.post(f"{self.base}/object/sign/{self.bucket}/{quote(_safe_path(path))}",
                                      json={"expiresIn": expires_in})
        if resp.status_code >= 300:
            raise StorageError(f"sign failed: HTTP {resp.status_code}")
        signed = resp.json().get("signedURL") or resp.json().get("signedUrl")
        if not signed:
            raise StorageError("sign failed: no URL returned")
        return signed if signed.startswith("http") else f"{self.base}{signed}"

    async def aclose(self) -> None:
        await self.client.aclose()


class UnavailableStorage:
    """Misconfigured storage: the API still starts (manual entry keeps working) and every
    storage call fails with a clear error (scans → 503 storage_unavailable)."""

    def __init__(self, reason: str) -> None:
        self.reason = reason

    async def _fail(self, *args: object, **kwargs: object) -> None:
        raise StorageError(self.reason)

    put = get = delete = signed_url = _fail  # type: ignore[assignment]

    async def aclose(self) -> None:
        return None


def build_storage(settings: Settings, api_base_url: str = "") -> Storage:
    if settings.storage_backend == "supabase":
        try:
            return SupabaseStorage(settings.supabase_url, settings.supabase_service_role_key,
                                   settings.storage_bucket)
        except StorageError as exc:
            logger.warning("Receipt storage disabled: %s", exc)
            return UnavailableStorage(str(exc))  # type: ignore[return-value]
    if settings.is_production:
        logger.warning("STORAGE_BACKEND=local in production: receipt files live on the container disk")
    return LocalStorage(settings.local_storage_dir, settings.cron_secret or settings.supabase_jwt_secret, api_base_url)
