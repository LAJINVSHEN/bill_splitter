"""Supabase JWT verification and the current-user dependencies.

* Asymmetric tokens (ES256/RS256/EdDSA) are verified against the project's JWKS
  (``{SUPABASE_URL}/auth/v1/.well-known/jwks.json``), cached for ``JWKS_CACHE_SECONDS``
  and refetched (at most every 30 s) when an unknown ``kid`` shows up.
* HS256 tokens are verified with the legacy ``SUPABASE_JWT_SECRET`` (fallback).
* ``aud`` must be ``authenticated``; ``iss`` is checked when SUPABASE_URL is set.

Semantics: missing/invalid/expired token → 401; wrong audience → 403; no ``profiles``
row (not provisioned by the admin) → 403 ``not_provisioned``; disabled → 403
``account_disabled``; temp password not yet changed → 403 ``password_change_required``
(except on the ``/me`` endpoints that let the user fix it).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any

import httpx
import jwt
from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.database import get_db
from app.errors import AppError
from app.models import Profile

logger = logging.getLogger(__name__)

ASYMMETRIC_ALGS = ("ES256", "RS256", "EdDSA")


class AuthError(AppError):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(status_code, code, message)


def _unauthorized(code: str, message: str) -> AuthError:
    return AuthError(401, code, message)


class JWKSCache:
    """Async JWKS fetcher with TTL + unknown-kid refresh (rate limited)."""

    def __init__(self, url: str, ttl_seconds: int, fetch_timeout: float = 5.0) -> None:
        self.url = url
        self.ttl = ttl_seconds
        self.fetch_timeout = fetch_timeout
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at = 0.0
        self._last_attempt = 0.0
        self._lock = asyncio.Lock()

    async def _fetch(self) -> None:
        self._last_attempt = time.monotonic()
        async with httpx.AsyncClient(timeout=self.fetch_timeout) as client:
            resp = await client.get(self.url)
            resp.raise_for_status()
            data = resp.json()
        keys: dict[str, jwt.PyJWK] = {}
        for jwk in data.get("keys", []):
            try:
                keys[jwk.get("kid", "")] = jwt.PyJWK(jwk)
            except jwt.PyJWTError:
                logger.warning("Skipping unusable JWK kid=%s", jwk.get("kid"))
        self._keys = keys
        self._fetched_at = time.monotonic()

    async def get(self, kid: str) -> jwt.PyJWK | None:
        now = time.monotonic()
        expired = now - self._fetched_at > self.ttl
        unknown = kid not in self._keys
        if expired or (unknown and now - self._last_attempt > 30):
            async with self._lock:
                if time.monotonic() - self._last_attempt > 1 or not self._keys:
                    try:
                        await self._fetch()
                    except (httpx.HTTPError, ValueError) as exc:
                        logger.warning("JWKS fetch failed: %s", type(exc).__name__)
        return self._keys.get(kid)

    def set_keys(self, keys: dict[str, jwt.PyJWK]) -> None:
        """Test hook: preload keys without HTTP."""
        self._keys = keys
        self._fetched_at = time.monotonic()
        self._last_attempt = time.monotonic()


@dataclass(frozen=True)
class TokenClaims:
    user_id: uuid.UUID
    email: str | None
    raw: dict[str, Any]


async def verify_token(token: str, settings: Settings, jwks: JWKSCache | None) -> TokenClaims:
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise _unauthorized("invalid_token", "Invalid access token.") from None
    alg = header.get("alg")
    if alg in ASYMMETRIC_ALGS:
        key = await jwks.get(header.get("kid", "")) if jwks else None
        if key is None:
            raise _unauthorized("invalid_token", "Unknown signing key.")
        verify_key: Any = key.key
    elif alg == "HS256":
        if not settings.supabase_jwt_secret:
            raise _unauthorized("invalid_token", "HS256 tokens are not accepted.")
        verify_key = settings.supabase_jwt_secret
    else:
        raise _unauthorized("invalid_token", "Unsupported token algorithm.")

    options = {"require": ["exp", "sub", "aud"]}
    try:
        claims = jwt.decode(
            token,
            verify_key,
            algorithms=[alg],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
            leeway=settings.jwt_leeway_seconds,
            options=options,
        )
    except jwt.ExpiredSignatureError:
        raise _unauthorized("token_expired", "Your session has expired. Please sign in again.") from None
    except jwt.InvalidAudienceError:
        raise AuthError(403, "invalid_audience", "This token is not valid for this app.") from None
    except jwt.PyJWTError:
        raise _unauthorized("invalid_token", "Invalid access token.") from None
    try:
        user_id = uuid.UUID(str(claims["sub"]))
    except ValueError:
        raise _unauthorized("invalid_token", "Invalid token subject.") from None
    return TokenClaims(user_id=user_id, email=claims.get("email"), raw=claims)


@dataclass(frozen=True)
class CurrentUser:
    id: uuid.UUID
    username: str
    display_name: str
    email: str | None
    role: str
    must_change_password: bool
    monthly_scan_quota: int
    default_currency: str
    disabled_at: datetime | None
    created_at: datetime

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @classmethod
    def from_profile(cls, p: Profile) -> CurrentUser:
        return cls(
            id=p.id, username=p.username, display_name=p.display_name, email=p.email, role=p.role,
            must_change_password=p.must_change_password, monthly_scan_quota=p.monthly_scan_quota,
            default_currency=p.default_currency, disabled_at=p.disabled_at, created_at=p.created_at,
        )


def _bearer(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    scheme, _, token = auth.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise _unauthorized("missing_token", "Sign in to continue.")
    return token.strip()


async def get_user_allow_password_change(
    request: Request, db: Annotated[AsyncSession, Depends(get_db)]
) -> CurrentUser:
    """Authenticated + provisioned + enabled. Does NOT enforce the temp-password change."""
    settings = get_settings()
    claims = await verify_token(_bearer(request), settings, getattr(request.app.state, "jwks", None))
    profile = await db.get(Profile, claims.user_id)
    if profile is None:
        raise AuthError(403, "not_provisioned", "This account hasn't been set up by the admin yet.")
    if profile.disabled_at is not None:
        raise AuthError(403, "account_disabled", "This account has been disabled.")
    request.state.user_id = profile.id
    return CurrentUser.from_profile(profile)


async def get_current_user(
    user: Annotated[CurrentUser, Depends(get_user_allow_password_change)],
) -> CurrentUser:
    if user.must_change_password:
        raise AuthError(403, "password_change_required", "Please set a new password first.")
    return user


async def require_admin(user: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
    if not user.is_admin:
        raise AuthError(403, "admin_only", "Only the admin can do that.")
    return user


CurrentUserDep = Annotated[CurrentUser, Depends(get_current_user)]
AdminDep = Annotated[CurrentUser, Depends(require_admin)]
PendingUserDep = Annotated[CurrentUser, Depends(get_user_allow_password_change)]
