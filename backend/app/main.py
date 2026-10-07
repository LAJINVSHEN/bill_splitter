"""FastAPI application factory.

Middleware order (outermost first): ServerError → CORS → CatchAll(500 JSON) →
BodySizeLimit → SlowAPI → routes. Errors produced inside therefore keep CORS headers.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi.middleware import SlowAPIMiddleware

from app import __version__
from app.api import build_api_router
from app.config import Settings, get_settings
from app.database import create_database
from app.errors import CatchAllMiddleware, install_exception_handlers
from app.integrations.azure_ocr import build_ocr
from app.integrations.llm import build_llm
from app.integrations.storage import build_storage
from app.integrations.supabase_admin import SupabaseAdmin, SupabaseAdminError, build_supabase_admin
from app.logging_setup import setup_logging
from app.middleware.auth import JWKSCache
from app.middleware.body_limit import BodySizeLimitMiddleware
from app.ratelimit import RateLimitExceeded, limiter, rate_limit_handler
from app.services.container import Services
from app.services.pipeline import JobRunner, recover_stale_jobs

logger = logging.getLogger("app")


class _UnconfiguredAuthAdmin:
    """Used when Supabase admin keys are missing: admin user routes return 502."""

    def __init__(self, reason: str) -> None:
        self.reason = reason

    async def _fail(self, *args: object, **kwargs: object) -> None:
        raise SupabaseAdminError(self.reason)

    create_user = set_password = set_disabled = delete_user = find_user_by_email = _fail  # type: ignore[assignment]

    async def aclose(self) -> None:
        return None


def _auth_admin(settings: Settings) -> SupabaseAdmin:
    try:
        return build_supabase_admin(settings)
    except SupabaseAdminError as exc:
        logger.warning("Supabase admin API disabled: %s", exc)
        return _UnconfiguredAuthAdmin(str(exc))  # type: ignore[return-value]


def build_services(settings: Settings, runner: JobRunner) -> Services:
    services = Services(settings=settings, storage=build_storage(settings), ocr=build_ocr(settings),
                        llm=build_llm(settings), auth_admin=_auth_admin(settings), runner=runner)
    runner.services = services
    return services


def create_app(settings: Settings | None = None,
               services_factory: Callable[[Settings, JobRunner], Services] | None = None) -> FastAPI:
    settings = settings or get_settings()
    setup_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db = create_database(settings)
        runner = JobRunner(db.sessionmaker)
        services = (services_factory or build_services)(settings, runner)
        runner.services = services
        app.state.db = db
        app.state.services = services
        app.state.jwks = JWKSCache(settings.jwks_url, settings.jwks_cache_seconds) if settings.jwks_url else None
        try:
            recovered = await recover_stale_jobs(db.sessionmaker, settings.job_stale_seconds)
            if recovered:
                logger.info("Marked %d interrupted scan job(s) as failed", recovered)
        except Exception:  # noqa: BLE001 - the DB may still be waking up; maintenance retries later
            logger.warning("Startup job recovery skipped (database unavailable?)")
        logger.info("Bill Splitter API %s started (env=%s, llm=%s→%s)", __version__, settings.environment,
                    settings.llm_primary_model, settings.llm_fallback_model or "-")
        try:
            yield
        finally:
            await runner.shutdown()
            for closer in (services.storage, services.ocr, services.llm, services.auth_admin):
                try:
                    await closer.aclose()
                except Exception:  # noqa: BLE001
                    logger.warning("error closing %s", type(closer).__name__)
            await db.dispose()

    app = FastAPI(
        title="Bill Splitter API",
        version=__version__,
        lifespan=lifespan,
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/openapi.json",
    )
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_handler)
    install_exception_handlers(app)

    def body_limit(method: str, path: str) -> int:
        if method == "POST" and path.startswith("/api/bills/") and path.endswith("/scans"):
            return settings.scan_max_request_bytes
        return settings.max_json_body_bytes

    # add_middleware prepends: the last one added is the outermost.
    app.add_middleware(SlowAPIMiddleware)
    app.add_middleware(BodySizeLimitMiddleware, limit_for=body_limit)
    app.add_middleware(CatchAllMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
        max_age=600,
    )
    app.include_router(build_api_router(dev_files=settings.storage_backend == "local" and not settings.is_production))
    return app


app = create_app()
