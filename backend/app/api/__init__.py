from fastapi import APIRouter

from app.api import admin, bills, health, internal, me, people, scans, share


def build_api_router(*, dev_files: bool) -> APIRouter:
    router = APIRouter(prefix="/api")
    for module in (health, me, people, bills, scans, share, admin, internal):
        router.include_router(module.router)
    if dev_files:
        from app.api import dev

        router.include_router(dev.router)
    return router
