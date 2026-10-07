"""Test fixtures. Real Postgres 16 (never SQLite); every external provider is faked.

Environment is pinned BEFORE the app is imported so no real key can be used.
"""

from __future__ import annotations

import os
import tempfile
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_STORAGE_DIR = tempfile.mkdtemp(prefix="bill-splitter-tests-")
os.environ.update({
    "ENVIRONMENT": "test",
    "LLM_BACKEND": "fake",
    "OCR_BACKEND": "fake",
    "SUPABASE_ADMIN_BACKEND": "fake",
    "STORAGE_BACKEND": "local",
    "LOCAL_STORAGE_DIR": _STORAGE_DIR,
    "SUPABASE_URL": "",
    "SUPABASE_JWT_SECRET": "test-jwt-secret-that-is-long-enough-for-hs256",
    "SUPABASE_SERVICE_ROLE_KEY": "",
    "OPENAI_API_KEY": "",
    "AZURE_DI_KEY": "",
    "AZURE_DI_ENDPOINT": "",
    "CRON_SECRET": "test-cron-secret",
    "RATE_LIMIT_ENABLED": "false",
    "CORS_ORIGINS": "http://localhost:3000,https://app.example.com",
    "PUBLIC_APP_URL": "https://app.example.com",
    "LLM_PRIMARY_MODEL": "primary-mini",
    "LLM_FALLBACK_MODEL": "fallback-big",
    "JOB_HEARTBEAT_SECONDS": "0.2",
    "JOB_STALE_SECONDS": "30",
    "DEFAULT_CURRENCY": "SGD",
    "APP_TIMEZONE": "Asia/Singapore",
})
os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5433/bill_splitter_test")
os.environ.setdefault("DATABASE_SSL", "disable")

import httpx  # noqa: E402
import jwt  # noqa: E402
import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker  # noqa: E402

from app.config import Settings, get_settings  # noqa: E402
from app.integrations.azure_ocr import FakeOcrClient  # noqa: E402
from app.integrations.llm import FakeLlmClient  # noqa: E402
from app.integrations.storage import LocalStorage  # noqa: E402
from app.integrations.supabase_admin import FakeSupabaseAdmin  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import Person, Profile  # noqa: E402
from app.schemas.extraction import BillItem, ReceiptExtraction, StoreInfo, TaxOrCharge  # noqa: E402
from app.services.container import Services  # noqa: E402
from app.services.pipeline import JobRunner  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
JWT_SECRET = os.environ["SUPABASE_JWT_SECRET"]
TABLES = ("usage_events", "share_links", "receipt_files", "ocr_cache", "extraction_jobs", "item_shares",
          "bill_participants", "bill_charges", "bill_items", "bills", "people", "profiles", "app_settings")


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> None:
    """Fresh schema via the real Alembic migrations (simulating Supabase's API roles)."""
    import asyncio

    import asyncpg

    async def _prepare() -> None:
        dsn = os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")
        conn = await asyncpg.connect(dsn)
        try:
            await conn.execute("""
                DO $$ BEGIN
                  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
                  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
                    THEN CREATE ROLE authenticated NOLOGIN; END IF;
                END $$;""")
            await conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
            # Like Supabase: API roles get default grants on new tables (the migration must revoke them).
            await conn.execute("GRANT USAGE ON SCHEMA public TO anon, authenticated")
            await conn.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated")
            await conn.execute(
                "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated")
        finally:
            await conn.close()

    asyncio.run(_prepare())
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")


# ------------------------------------------------------------------------- data builders
def make_extraction(items: list[tuple[str, int, float, float]], charges: list[tuple[str, float]] = (),
                    subtotal: float = 0.0, grand: float | None = None, store: str = "Noodle House",
                    date: str = "2026-10-05") -> ReceiptExtraction:
    total_items = round(sum(i[3] for i in items), 2)
    if grand is None:
        grand = round((subtotal or total_items) + sum(c[1] for c in charges), 2)
    return ReceiptExtraction(
        receipt_number="R-1", date=date, time="19:42", store=StoreInfo(name=store),
        items=[BillItem(name=n, quantity=q, unit_price=u, total_price=t) for n, q, u, t in items],
        subtotal=subtotal, taxes_or_charges=[TaxOrCharge(name=n, amount=a) for n, a in charges],
        grand_total=grand, payment_method="VISA",
    )


GOOD_EXTRACTION = make_extraction(
    [("Laksa", 2, 8.5, 17.0), ("Char Kway Teow", 1, 9.8, 9.8), ("Iced Lemon Tea", 3, 2.6, 7.8)],
    [("Service Charge 10%", 3.46), ("GST 9%", 3.43)], subtotal=34.6, grand=41.49,
)
# Items don't match the printed subtotal → fails reconciliation.
BAD_EXTRACTION = make_extraction([("Laksa", 2, 8.5, 17.0), ("Mystery", 1, 5.0, 5.0)],
                                 [("GST 9%", 3.43)], subtotal=34.6, grand=41.49)

JPEG = b"\xff\xd8\xff\xe0" + b"jpeg-bytes-"
PNG = b"\x89PNG\r\n\x1a\n" + b"png-bytes-"
PDF = b"%PDF-1.7\n" + b"pdf-bytes-"


def jpeg(tag: str = "") -> bytes:
    """A tiny "JPEG" (magic bytes only). Same tag → same content (OCR cache hit)."""
    return JPEG + (tag.encode() if tag else uuid.uuid4().bytes)


def token_for(user_id: uuid.UUID | str, *, aud: str = "authenticated", exp_in: int = 3600,
              secret: str = JWT_SECRET, **claims: Any) -> str:
    now = int(time.time())
    payload = {"sub": str(user_id), "aud": aud, "role": "authenticated", "iat": now, "exp": now + exp_in, **claims}
    return jwt.encode(payload, secret, algorithm="HS256")


@dataclass
class TestUser:
    id: uuid.UUID
    username: str
    self_person_id: uuid.UUID
    token: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}


@dataclass
class Ctx:
    app: Any
    client: httpx.AsyncClient
    services: Services
    sm: async_sessionmaker[AsyncSession]
    settings: Settings

    @property
    def ocr(self) -> FakeOcrClient:
        return self.services.ocr  # type: ignore[return-value]

    @property
    def llm(self) -> FakeLlmClient:
        return self.services.llm  # type: ignore[return-value]

    @property
    def auth_admin(self) -> FakeSupabaseAdmin:
        return self.services.auth_admin  # type: ignore[return-value]

    async def user(self, username: str = "alice", *, role: str = "member", must_change: bool = False,
                   quota: int = 30, disabled: bool = False, currency: str = "SGD") -> TestUser:
        uid = uuid.uuid4()
        async with self.sm() as db:
            db.add(Profile(id=uid, username=username, email=f"{username}@test.local", display_name=username.title(),
                           role=role, must_change_password=must_change, monthly_scan_quota=quota,
                           default_currency=currency,
                           disabled_at=datetime.now(UTC) if disabled else None))
            await db.flush()
            me = Person(owner_id=uid, name=username.title(), is_self=True, color_seed=10)
            db.add(me)
            await db.commit()
            return TestUser(id=uid, username=username, self_person_id=me.id, token=token_for(uid))

    async def drain(self) -> None:
        await self.services.runner.drain()

    async def sql(self, statement: str, **params: Any) -> list[Any]:
        async with self.sm() as db:
            result = await db.execute(text(statement), params)
            rows = list(result.all()) if result.returns_rows else []
            await db.commit()
            return rows


def fake_services_factory(settings: Settings, runner: JobRunner) -> Services:
    storage_dir = tempfile.mkdtemp(prefix="bs-storage-")
    services = Services(
        settings=settings,
        storage=LocalStorage(storage_dir, "test-storage-secret"),
        ocr=FakeOcrClient(),
        llm=FakeLlmClient(default=GOOD_EXTRACTION),
        auth_admin=FakeSupabaseAdmin(),
        runner=runner,
    )
    runner.services = services
    return services


@pytest.fixture
async def ctx() -> AsyncIterator[Ctx]:
    settings = get_settings()
    app = create_app(settings, services_factory=fake_services_factory)
    async with app.router.lifespan_context(app):
        db = app.state.db
        async with db.engine.begin() as conn:
            await conn.execute(text(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield Ctx(app=app, client=client, services=app.state.services, sm=db.sessionmaker, settings=settings)
        await app.state.services.runner.drain(timeout=5)


__all__ = ["BAD_EXTRACTION", "GOOD_EXTRACTION", "PDF", "PNG", "Ctx", "TestUser", "jpeg", "make_extraction",
           "token_for"]
