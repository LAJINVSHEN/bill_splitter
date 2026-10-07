"""slowapi limiter. Keyed by the (unverified) JWT subject when present, else client IP.

The key only buckets requests; authentication still happens in the route dependency,
so a forged token can't do anything except spend its own bucket.
"""

from __future__ import annotations

import jwt
from fastapi import Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.config import get_settings
from app.errors import error_body


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
    default_limits=[_settings.rate_limit_default],
    storage_uri="memory://",
    enabled=_settings.rate_limit_enabled,
    headers_enabled=False,
)


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


__all__ = ["RateLimitExceeded", "limiter", "rate_limit_handler"]
