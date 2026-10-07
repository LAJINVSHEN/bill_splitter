from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app import __version__

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    """Liveness: no DB access (used for keep-warm pings)."""
    return {"status": "ok", "version": __version__}


@router.get("/health/ready")
async def ready(request: Request) -> JSONResponse:
    try:
        async with request.app.state.db.sessionmaker() as db:
            await db.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        return JSONResponse({"status": "unavailable", "db": "error"}, status_code=503)
    return JSONResponse({"status": "ok", "db": "ok"})
