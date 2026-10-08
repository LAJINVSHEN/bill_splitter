from __future__ import annotations

from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import Field

from app.schemas.common import CleanStr, InputModel, OutputModel

PersonName = Annotated[CleanStr, Field(min_length=1, max_length=60)]
ColorSeed = Annotated[int, Field(ge=0, le=359)]


class PersonOut(OutputModel):
    id: UUID
    name: str
    color_seed: int
    is_self: bool
    last_used_at: datetime | None
    archived_at: datetime | None
    created_at: datetime


class PeopleList(OutputModel):
    items: list[PersonOut]


class PersonCreate(InputModel):
    name: PersonName
    color_seed: ColorSeed | None = None


class PersonPatch(InputModel):
    name: PersonName | None = None
    color_seed: ColorSeed | None = None
    archived: bool | None = None
