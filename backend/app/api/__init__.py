from fastapi import APIRouter, Depends

from app.api import admin, bills, health, internal, me, people, scans, share
from app.ratelimit import default_limit


def build_api_router(*, dev_files: bool) -> APIRouter:
    router = APIRouter(prefix="/api", dependencies=[Depends(default_limit)])
    for module in (health, me, people, bills, scans, share, admin, internal):
        router.include_router(module.router)
    if dev_files:
        from app.api import dev

        router.include_router(dev.router)
    return router
