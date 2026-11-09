from fastapi import APIRouter, Depends

from app.api import admin, bills, health, internal, me, people, scans, share, social
from app.ratelimit import default_limit


def build_api_router(*, dev_files: bool, dev_auth: bool = False) -> APIRouter:
    router = APIRouter(prefix="/api", dependencies=[Depends(default_limit)])
    for module in (health, me, people, bills, scans, share, social, admin, internal):
        router.include_router(module.router)
    if dev_files:
        from app.api import dev

        router.include_router(dev.router)
    if dev_auth:  # ENVIRONMENT != production and SUPABASE_ADMIN_BACKEND=fake
        from app.api import dev_auth as dev_auth_routes

        router.include_router(dev_auth_routes.router)
    return router
