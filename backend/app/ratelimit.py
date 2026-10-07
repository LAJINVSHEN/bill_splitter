"""Rate limiting.

* Stricter per-route limits (scans, public share view, admin user creation) use slowapi
  decorators.
* The default limit for every ``/api`` route is a router-level dependency
  (``default_limit``). slowapi's middleware can't see endpoints inside FastAPI's nested
  routers (>= 0.13x wraps them in ``_IncludedRouter``), so it would silently skip them.

Keys are the (unverified) JWT subject when present, else the client IP. The key only
buckets requests; authentication still happens in the route dependency, so a forged
token can't do anything except spend its own bucket.
"""

from __future__ import annotations

import jwt
from fastapi import Request
from fastapi.responses import JSONResponse
from limits import parse_many
from limits.storage import MemoryStorage
from limits.strategies import MovingWindowRateLimiter
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.config import get_settings
from app.errors import AppError, error_body


def rate_limit_key(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        try:
            claims = jwt.decode(auth[7:].strip(), options={"verify_signature": False})
            sub = claims.get("sub")
            if isinstance(sub, str) and sub:
                return f"user:{sub}"
        except jwt.PyJWTError:
            pass
    return f"ip:{get_remote_address(request)}"


def ip_key(request: Request) -> str:
    return f"ip:{get_remote_address(request)}"


_settings = get_settings()

limiter = Limiter(
    key_func=rate_limit_key,
    storage_uri="memory://",
    enabled=_settings.rate_limit_enabled,
    headers_enabled=False,
)


class DefaultLimit:
    """FastAPI dependency enforcing RATE_LIMIT_DEFAULT on every /api route."""

    def __init__(self) -> None:
        self._storage = MemoryStorage()
        self._strategy = MovingWindowRateLimiter(self._storage)

    def reset(self) -> None:
        self._storage.reset()

    async def __call__(self, request: Request) -> None:
        if not limiter.enabled:
            return
        key = rate_limit_key(request)
        for item in parse_many(get_settings().rate_limit_default):
            if not self._strategy.hit(item, "default", key):
                raise AppError(429, "rate_limited", "Too many requests. Please slow down.", retry_after=60)


default_limit = DefaultLimit()


def reset_all() -> None:
    limiter.reset()
    default_limit.reset()


def scans_limit() -> str:
    return get_settings().rate_limit_scans


def public_limit() -> str:
    return get_settings().rate_limit_public


def admin_create_limit() -> str:
    return get_settings().rate_limit_admin_create


async def rate_limit_handler(_: Request, exc: Exception) -> JSONResponse:
    detail = str(getattr(exc, "detail", "")) or "rate limit"
    return JSONResponse(
        error_body("rate_limited", "Too many requests. Please slow down.", limit=detail),
        status_code=429,
        headers={"Retry-After": "60"},
    )


__all__ = ["RateLimitExceeded", "default_limit", "limiter", "rate_limit_handler", "reset_all"]
