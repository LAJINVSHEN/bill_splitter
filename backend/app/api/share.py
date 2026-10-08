from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import CurrentUserDep
from app.ratelimit import ip_key, limiter, public_limit
from app.schemas.share import PublicShareOut, ShareLinkCreate, ShareLinkCreated, ShareLinkList
from app.services import share as svc
from app.services.container import ServicesDep

router = APIRouter(tags=["share"])
DB = Annotated[AsyncSession, Depends(get_db)]


@router.post("/bills/{bill_id}/share-links", response_model=ShareLinkCreated, status_code=201)
async def create_link(bill_id: UUID, user: CurrentUserDep, db: DB, services: ServicesDep,
                      data: ShareLinkCreate | None = None) -> ShareLinkCreated:
    """``person_id`` = per-person view; omit/null for the whole bill. The token is returned once."""
    return await svc.create_link(db, services.settings, user, bill_id, data or ShareLinkCreate())


@router.get("/bills/{bill_id}/share-links", response_model=ShareLinkList)
async def list_links(bill_id: UUID, user: CurrentUserDep, db: DB) -> ShareLinkList:
    return await svc.list_links(db, user, bill_id)


@router.delete("/bills/{bill_id}/share-links", status_code=204)
async def revoke_all(bill_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    await svc.revoke_links(db, user, bill_id)
    return Response(status_code=204)


@router.delete("/bills/{bill_id}/share-links/{link_id}", status_code=204)
async def revoke_one(bill_id: UUID, link_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    await svc.revoke_links(db, user, bill_id, link_id)
    return Response(status_code=204)


@router.get("/public/share/{token}", response_model=PublicShareOut)
@limiter.limit(public_limit, key_func=ip_key)
async def public_share(request: Request, token: str, db: DB, response: Response) -> PublicShareOut:
    """No login. Minimal read-only data; 404 for unknown/revoked/expired links."""
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return await svc.public_view(db, token)
