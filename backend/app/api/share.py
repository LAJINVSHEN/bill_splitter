from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import CurrentUserDep
from app.ratelimit import claims_limit, ip_key, limiter, public_limit
from app.schemas.bills import BillOut, ClaimConfirmIn
from app.schemas.share import (
    EnsuredLink,
    EnsuredLinks,
    EnsureLinksIn,
    PublicClaimIn,
    PublicShareOut,
    ShareLinkCreate,
    ShareLinkCreated,
    ShareLinkList,
)
from app.services import claims as claims_svc
from app.services import share as svc
from app.services.container import ServicesDep

router = APIRouter(tags=["share"])
DB = Annotated[AsyncSession, Depends(get_db)]


@router.post("/bills/{bill_id}/share-links", response_model=ShareLinkCreated, status_code=201)
async def create_link(bill_id: UUID, user: CurrentUserDep, db: DB, services: ServicesDep,
                      data: ShareLinkCreate | None = None) -> ShareLinkCreated:
    """``person_id`` = per-person view; omit/null for the whole bill. The token is returned once."""
    return await svc.create_link(db, services.settings, user, bill_id, data or ShareLinkCreate())


@router.post("/bills/{bill_id}/share-links/ensure", response_model=EnsuredLinks)
async def ensure_links(bill_id: UUID, data: EnsureLinksIn, user: CurrentUserDep, db: DB,
                       services: ServicesDep) -> EnsuredLinks:
    """The one active link per person / for the group, created when missing (sharing again reuses it)."""
    return await svc.ensure_links(db, services.settings, user, bill_id, data)


@router.post("/bills/{bill_id}/share-links/{link_id}/reset", response_model=EnsuredLink)
async def reset_link(bill_id: UUID, link_id: UUID, user: CurrentUserDep, db: DB, services: ServicesDep) -> EnsuredLink:
    """Turn this link off and get a new one for the same scope."""
    return await svc.reset_link(db, services.settings, user, bill_id, link_id)


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


# ---------------------------------------------------------------------------- claims (owner)
@router.post("/bills/{bill_id}/claims/confirm-all", response_model=BillOut)
async def confirm_all(bill_id: UUID, user: CurrentUserDep, db: DB) -> BillOut:
    return await claims_svc.confirm_all(db, user, bill_id)


@router.post("/bills/{bill_id}/claims/{claim_id}/confirm", response_model=BillOut)
async def confirm_claim(bill_id: UUID, claim_id: UUID, user: CurrentUserDep, db: DB,
                        data: ClaimConfirmIn | None = None) -> BillOut:
    """Record the payment they told you about (default: the amount they claimed)."""
    return await claims_svc.confirm(db, user, bill_id, claim_id, (data or ClaimConfirmIn()).amount_cents)


@router.post("/bills/{bill_id}/claims/{claim_id}/reject", response_model=BillOut)
async def reject_claim(bill_id: UUID, claim_id: UUID, user: CurrentUserDep, db: DB) -> BillOut:
    """Not yet: the payment hasn't arrived. They can tell you again."""
    return await claims_svc.reject(db, user, bill_id, claim_id)


# ---------------------------------------------------------------------------- public
def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"


@router.get("/public/share/{token}", response_model=PublicShareOut)
@limiter.limit(public_limit, key_func=ip_key)
async def public_share(request: Request, token: str, db: DB, response: Response,
                       services: ServicesDep) -> PublicShareOut:
    """No login. Minimal data; 404 for unknown/revoked/expired links."""
    _private(response)
    return await svc.public_view(db, services.settings, token)


@router.post("/public/share/{token}/claims", response_model=PublicShareOut)
@limiter.limit(claims_limit, key_func=ip_key)
async def public_claim(request: Request, token: str, data: PublicClaimIn, db: DB, response: Response,
                       services: ServicesDep) -> PublicShareOut:
    """ "I've paid" (their full amount). The owner still confirms it. Safe to retry with the same client_key."""
    _private(response)
    return await svc.public_claim(db, services.settings, token, data)


@router.delete("/public/share/{token}/claims/{client_key}", response_model=PublicShareOut)
@limiter.limit(claims_limit, key_func=ip_key)
async def public_withdraw(request: Request, token: str, client_key: UUID, db: DB, response: Response,
                          services: ServicesDep) -> PublicShareOut:
    _private(response)
    return await svc.public_withdraw(db, services.settings, token, client_key)
