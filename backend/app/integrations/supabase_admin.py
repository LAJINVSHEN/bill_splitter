"""Supabase Auth admin API (service-role key) – create / reset / disable users.

Signups are disabled in Supabase, so pre-creating a user here is also how a Google
account is allow-listed: Google sign-in links to the existing user with the same email.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from app.config import Settings

BAN_FOREVER = "876000h"  # ~100 years


class SupabaseAdminError(Exception):
    def __init__(self, message: str, status_code: int | None = None, code: str = "auth_admin_error") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class EmailTaken(SupabaseAdminError):
    def __init__(self) -> None:
        super().__init__("A user with this email already exists", 422, "email_taken")


@dataclass(frozen=True)
class AuthUser:
    id: uuid.UUID
    email: str


class SupabaseAdmin(Protocol):
    async def create_user(self, email: str, password: str, metadata: dict[str, Any]) -> AuthUser: ...
    async def set_password(self, user_id: uuid.UUID, password: str) -> None: ...
    async def set_disabled(self, user_id: uuid.UUID, disabled: bool) -> None: ...
    async def delete_user(self, user_id: uuid.UUID) -> None: ...
    async def find_user_by_email(self, email: str) -> AuthUser | None: ...
    async def aclose(self) -> None: ...


class HttpSupabaseAdmin:
    def __init__(self, supabase_url: str, service_key: str, timeout: float = 15.0) -> None:
        if not supabase_url or not service_key:
            raise SupabaseAdminError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
        self.base = f"{supabase_url}/auth/v1/admin/users"
        headers = {"apikey": service_key}
        if service_key.startswith("eyJ"):
            headers["Authorization"] = f"Bearer {service_key}"
        self.client = httpx.AsyncClient(timeout=timeout, headers=headers)

    @staticmethod
    def _raise(resp: httpx.Response, action: str) -> None:
        if resp.status_code < 300:
            return
        try:
            body = resp.json()
        except ValueError:
            body = {}
        text = str(body.get("msg") or body.get("message") or body.get("error_description") or "")
        err_code = str(body.get("error_code") or body.get("code") or "")
        if resp.status_code == 422 and ("email_exists" in err_code or "already" in text.lower()):
            raise EmailTaken()
        raise SupabaseAdminError(f"{action} failed (HTTP {resp.status_code}) {text[:200]}", resp.status_code)

    async def create_user(self, email: str, password: str, metadata: dict[str, Any]) -> AuthUser:
        resp = await self.client.post(self.base, json={
            "email": email, "password": password, "email_confirm": True, "user_metadata": metadata,
        })
        self._raise(resp, "create user")
        data = resp.json()
        return AuthUser(id=uuid.UUID(data["id"]), email=data.get("email", email))

    async def set_password(self, user_id: uuid.UUID, password: str) -> None:
        resp = await self.client.put(f"{self.base}/{user_id}", json={"password": password})
        self._raise(resp, "reset password")

    async def set_disabled(self, user_id: uuid.UUID, disabled: bool) -> None:
        resp = await self.client.put(f"{self.base}/{user_id}",
                                     json={"ban_duration": BAN_FOREVER if disabled else "none"})
        self._raise(resp, "disable user" if disabled else "enable user")

    async def delete_user(self, user_id: uuid.UUID) -> None:
        resp = await self.client.delete(f"{self.base}/{user_id}")
        if resp.status_code != 404:
            self._raise(resp, "delete user")

    async def find_user_by_email(self, email: str) -> AuthUser | None:
        # Small user base: page through the list (50/page) – no server-side email filter exists.
        for page in range(1, 21):
            resp = await self.client.get(self.base, params={"page": page, "per_page": 50})
            self._raise(resp, "list users")
            users = resp.json().get("users", [])
            for u in users:
                if str(u.get("email", "")).lower() == email.lower():
                    return AuthUser(id=uuid.UUID(u["id"]), email=u["email"])
            if len(users) < 50:
                break
        return None

    async def aclose(self) -> None:
        await self.client.aclose()


@dataclass
class FakeSupabaseAdmin:
    """In-memory stand-in for tests and local development without Supabase."""

    users: dict[uuid.UUID, dict[str, Any]] = field(default_factory=dict)
    fail_next: str | None = None

    def _maybe_fail(self) -> None:
        if self.fail_next:
            msg, self.fail_next = self.fail_next, None
            raise SupabaseAdminError(msg, 500)

    async def create_user(self, email: str, password: str, metadata: dict[str, Any]) -> AuthUser:
        self._maybe_fail()
        if any(u["email"].lower() == email.lower() for u in self.users.values()):
            raise EmailTaken()
        uid = uuid.uuid4()
        self.users[uid] = {"email": email, "password": password, "metadata": metadata, "banned": False}
        return AuthUser(id=uid, email=email)

    async def set_password(self, user_id: uuid.UUID, password: str) -> None:
        self._maybe_fail()
        self.users.setdefault(user_id, {"email": "", "banned": False})["password"] = password

    async def set_disabled(self, user_id: uuid.UUID, disabled: bool) -> None:
        self._maybe_fail()
        self.users.setdefault(user_id, {"email": "", "password": ""})["banned"] = disabled

    async def delete_user(self, user_id: uuid.UUID) -> None:
        self.users.pop(user_id, None)

    async def find_user_by_email(self, email: str) -> AuthUser | None:
        for uid, u in self.users.items():
            if u["email"].lower() == email.lower():
                return AuthUser(uid, u["email"])
        return None

    async def aclose(self) -> None:
        return None


def build_supabase_admin(settings: Settings) -> SupabaseAdmin:
    if settings.supabase_admin_backend == "fake":
        return FakeSupabaseAdmin()
    return HttpSupabaseAdmin(settings.supabase_url, settings.supabase_service_role_key)
