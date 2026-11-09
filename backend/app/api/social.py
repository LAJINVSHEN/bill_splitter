"""Friends, the Mailbox, groups and account requests."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import CurrentUserDep, SignedInDep
from app.ratelimit import friend_request_limit, limiter
from app.schemas.social import (
    AccessRequestIn,
    AccessRequestOut,
    FriendRequestIn,
    FriendRequestSent,
    FriendsOut,
    GroupIn,
    GroupList,
    GroupOut,
    GroupPatch,
    MailboxOut,
    MailReadIn,
    SendPlanIn,
    SendPlanOut,
)
from app.services import access as access_svc
from app.services import friends as friends_svc
from app.services import groups as groups_svc
from app.services import links as links_svc
from app.services import mailbox as mailbox_svc
from app.services.container import ServicesDep

router = APIRouter(tags=["social"])
DB = Annotated[AsyncSession, Depends(get_db)]


def _done() -> Response:
    return Response(status_code=204)


# ---------------------------------------------------------------------------- friends
@router.get("/friends", response_model=FriendsOut)
async def friends(user: CurrentUserDep, db: DB) -> FriendsOut:
    """Friends, requests you sent, people you blocked, and people you share bills with."""
    return await friends_svc.friends(db, user)


@router.post("/friends/requests", response_model=FriendRequestSent, status_code=202)
@limiter.limit(friend_request_limit)
async def send_request(request: Request, data: FriendRequestIn, user: CurrentUserDep, db: DB,
                       services: ServicesDep) -> FriendRequestSent:
    """Exact email or user id. Answers "sent" whether or not an account matched."""
    return await friends_svc.request(db, services.settings, user, data)


@router.post("/friends/requests/{request_id}/accept", status_code=204)
async def accept_request(request_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    await friends_svc.accept(db, user, request_id)
    return _done()


@router.post("/friends/requests/{request_id}/decline", status_code=204)
async def decline_request(request_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    """They're told; they can ask again after 30 days."""
    await friends_svc.decline(db, user, request_id)
    return _done()


@router.delete("/friends/requests/{request_id}", status_code=204)
async def cancel_request(request_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    await friends_svc.cancel(db, user, request_id)
    return _done()


@router.delete("/friends/{account_id}", status_code=204)
async def unfriend(account_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    """Archives each side's entry; every bill keeps them."""
    await friends_svc.unfriend(db, user, account_id)
    return _done()


@router.post("/friends/{account_id}/block", status_code=204)
async def block(account_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    await friends_svc.block(db, user, account_id)
    return _done()


@router.delete("/friends/{account_id}/block", status_code=204)
async def unblock(account_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    await friends_svc.unblock(db, user, account_id)
    return _done()


# ---------------------------------------------------------------------------- mailbox
@router.get("/mailbox", response_model=MailboxOut)
async def mailbox(user: CurrentUserDep, db: DB) -> MailboxOut:
    return await mailbox_svc.mailbox(db, user)


@router.post("/mailbox/read", status_code=204)
async def mark_read(data: MailReadIn, user: CurrentUserDep, db: DB) -> Response:
    await mailbox_svc.mark_read(db, user, data.ids)
    return _done()


@router.post("/mailbox/links/{link_id}/accept", status_code=204)
async def accept_link(link_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    """Take over the placeholder: its bills are shared with you from now on."""
    await links_svc.accept(db, user, link_id)
    return _done()


@router.post("/mailbox/links/{link_id}/decline", status_code=204)
async def decline_link(link_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    await links_svc.decline(db, user, link_id)
    return _done()


# ---------------------------------------------------------------------------- groups
@router.get("/groups", response_model=GroupList)
async def list_groups(user: CurrentUserDep, db: DB) -> GroupList:
    return await groups_svc.list_groups(db, user)


@router.post("/groups", response_model=GroupOut, status_code=201)
async def create_group(data: GroupIn, user: CurrentUserDep, db: DB) -> GroupOut:
    return await groups_svc.create(db, user, data)


@router.patch("/groups/{group_id}", response_model=GroupOut)
async def patch_group(group_id: UUID, data: GroupPatch, user: CurrentUserDep, db: DB) -> GroupOut:
    return await groups_svc.patch(db, user, group_id, data)


@router.delete("/groups/{group_id}", status_code=204)
async def delete_group(group_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    """Only the saved set goes; people and bills are untouched."""
    await groups_svc.remove(db, user, group_id)
    return _done()


@router.post("/groups/{group_id}/send-plan", response_model=SendPlanOut)
async def send_plan(group_id: UUID, data: SendPlanIn, user: CurrentUserDep, db: DB) -> SendPlanOut:
    """Put each account's own rows of the group's simplified plan in their Mailbox."""
    return await groups_svc.send_plan(db, user, group_id, data)


# ---------------------------------------------------------------------------- account requests
@router.post("/access-requests", response_model=AccessRequestOut, status_code=201)
async def ask_for_access(data: AccessRequestIn, who: SignedInDep, db: DB, services: ServicesDep) -> AccessRequestOut:
    """Signed in with Google but no account yet: ask the admin for one."""
    return await access_svc.ask(db, services.settings, who, data)


@router.get("/access-requests/mine", response_model=AccessRequestOut)
async def my_access_request(who: SignedInDep, db: DB) -> AccessRequestOut:
    return await access_svc.mine(db, who)
