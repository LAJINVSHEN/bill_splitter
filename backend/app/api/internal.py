from __future__ import annotations

import hmac
from dataclasses import asdict

from fastapi import APIRouter, Request

from app.errors import AppError
from app.services.container import ServicesDep
from app.services.maintenance import run_maintenance

router = APIRouter(prefix="/internal", tags=["internal"], include_in_schema=False)


def _check_cron(request: Request, secret: str) -> None:
    if not secret:
        raise AppError(503, "cron_not_configured", "CRON_SECRET is not set.")
    auth = request.headers.get("authorization", "")
    scheme, _, token = auth.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip().encode(), secret.encode()):
        raise AppError(401, "invalid_cron_secret", "Unauthorized.")


@router.post("/maintenance")
async def maintenance(request: Request, services: ServicesDep) -> dict[str, object]:
    """Bearer CRON_SECRET. Purge expired photos, fail stale jobs, touch the DB."""
    _check_cron(request, services.settings.cron_secret)
    result = await run_maintenance(services, request.app.state.db.sessionmaker)
    return asdict(result)
