from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import CurrentUserDep
from app.schemas.people import PeopleList, PersonCreate, PersonOut, PersonPatch
from app.services import people as svc

router = APIRouter(prefix="/people", tags=["people"])
DB = Annotated[AsyncSession, Depends(get_db)]


@router.get("", response_model=PeopleList)
async def list_people(user: CurrentUserDep, db: DB, include_archived: bool = False) -> PeopleList:
    """All of the caller's people (bounded at 300 active, so not paginated)."""
    return await svc.list_people(db, user.id, include_archived)


@router.post("", response_model=PersonOut, status_code=201)
async def create_person(data: PersonCreate, user: CurrentUserDep, db: DB) -> PersonOut:
    return await svc.create_person(db, user.id, data)


@router.patch("/{person_id}", response_model=PersonOut)
async def patch_person(person_id: UUID, data: PersonPatch, user: CurrentUserDep, db: DB) -> PersonOut:
    return await svc.patch_person(db, user.id, person_id, data)


@router.delete("/{person_id}", status_code=204)
async def delete_person(person_id: UUID, user: CurrentUserDep, db: DB) -> Response:
    """Archives the person (old bills keep showing them)."""
    await svc.archive_person(db, user.id, person_id)
    return Response(status_code=204)
