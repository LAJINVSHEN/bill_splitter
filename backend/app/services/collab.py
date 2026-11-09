"""Shared bills: who may do what, versions + the edit log, conflict checks and presence.

A bill is shared with every account on it (someone's linked entry for them). The owner does
everything; anyone else on the bill edits the receipt and who-had-what. Every write bumps
``bills.version`` and logs a ``bill_edits`` row. A save sent from an older version is only
refused when someone *else* touched the same thing since (two people assigning different
items both land). Nothing is pushed: open bill pages poll ``live`` (cheap at this app's
size), and finished bills leave a coalesced "Ben edited Dinner" in the others' Mailbox.
"""

from __future__ import annotations

import time
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import AppError, Conflict, NotFound
from app.middleware.auth import CurrentUser
from app.models import Bill, BillEdit, Profile
from app.repositories import bills as bills_repo
from app.services import mailbox

# Edits that change what others see on a finished bill (status flips and settlements don't).
CONTENT_KINDS = frozenset({"details", "receipt", "shares", "people", "quick", "currency", "scan"})


class OwnerOnly(AppError):
    def __init__(self, owner_name: str) -> None:
        super().__init__(403, "owner_only", f"Only {owner_name} can change that on their bill.")


def is_owner(bill: Bill, user: CurrentUser) -> bool:
    return bill.owner_id == user.id


async def owner_name(db: AsyncSession, bill: Bill) -> str:
    return await db.scalar(select(Profile.display_name).where(Profile.id == bill.owner_id)) or "the owner"


async def load(db: AsyncSession, user: CurrentUser, bill_id: UUID, *, for_update: bool = False,
               owner_only: bool = False) -> Bill:
    """A bill the user can see (owner, or on it). ``owner_only`` turns members away with a 403."""
    bill = await bills_repo.get_visible_bill(db, user.id, bill_id, full=True, for_update=for_update)
    if bill is None:
        raise NotFound("Bill")
    if owner_only and not is_owner(bill, user):
        raise OwnerOnly(await owner_name(db, bill))
    return bill


def accounts_on(bill: Bill) -> set[UUID]:
    """Every account the bill is shared with, the owner included."""
    return {bill.owner_id} | {p.person.account_id for p in bill.participants if p.person.account_id}


# ---------------------------------------------------------------------------- conflicts
def _clashes(kind: str, mine: set[UUID], edit: BillEdit) -> bool:
    theirs = set(edit.item_ids)
    if kind == "receipt":
        return edit.kind in ("receipt", "quick", "currency", "scan")
    if kind == "shares":
        return edit.kind in ("quick", "scan") or (edit.kind in ("shares", "receipt") and bool(mine & theirs))
    if kind == "quick":
        return edit.kind in ("receipt", "shares", "quick", "people", "scan")
    return False


async def check_base(db: AsyncSession, bill: Bill, user: CurrentUser, base_version: int | None, kind: str,
                     item_ids: Iterable[UUID] = ()) -> None:
    """Refuse a save made on an older version when someone else has since changed the same thing.
    Call with the bill row locked. ``base_version`` None (old clients, scripts) skips the check."""
    if base_version is None or base_version >= bill.version:
        return
    mine = set(item_ids)
    edits = (await db.scalars(select(BillEdit).where(
        BillEdit.bill_id == bill.id, BillEdit.version > base_version, BillEdit.actor_id != user.id,
    ).order_by(BillEdit.version.desc()))).all()
    clash = next((e for e in edits if _clashes(kind, mine, e)), None)
    if clash is not None:
        who = await db.scalar(select(Profile.display_name).where(Profile.id == clash.actor_id)) or "Someone"
        raise Conflict("bill_changed", f"{who} changed this while you were editing. Here's the latest: "
                                       "check it and make your change again.", by=who, version=bill.version)


async def record(db: AsyncSession, bill: Bill, user: CurrentUser | UUID | None, kind: str,
                 item_ids: Iterable[UUID] = ()) -> None:
    """Bump the version and log the edit (call before commit, with the bill row locked)."""
    actor = user.id if isinstance(user, CurrentUser) else user
    bill.version = (bill.version or 1) + 1
    bill.updated_by = actor
    bill.updated_at = datetime.now(UTC)
    db.add(BillEdit(bill_id=bill.id, actor_id=actor, version=bill.version, kind=kind,
                    item_ids=sorted(set(item_ids), key=str)))
    if kind in CONTENT_KINDS and bill.status == "complete" and actor is not None:
        for account in accounts_on(bill) - {actor}:
            await mailbox.notify(db, account, "bill_edited", actor_id=actor, bill_id=bill.id, coalesce=True)


# ---------------------------------------------------------------------------- presence
PRESENCE_TTL = 15.0  # seconds: a bill page polls every ~4 s while visible


@dataclass
class _Seen:
    name: str
    color_seed: int
    at: float


class Presence:
    """Who has a bill open right now. In memory: the API runs as one instance; a restart only
    forgets a few seconds of "Ben is here"."""

    def __init__(self) -> None:
        self._bills: dict[UUID, dict[UUID, _Seen]] = {}

    def touch(self, bill_id: UUID, user_id: UUID, name: str, color_seed: int) -> list[tuple[UUID, _Seen]]:
        now = time.monotonic()
        here = self._bills.setdefault(bill_id, {})
        here[user_id] = _Seen(name, color_seed, now)
        for uid in [u for u, s in here.items() if now - s.at > PRESENCE_TTL]:
            del here[uid]
        if len(self._bills) > 500:  # drop bills nobody has open
            for bid in [b for b, h in self._bills.items() if not h or b != bill_id and
                        all(now - s.at > PRESENCE_TTL for s in h.values())]:
                del self._bills[bid]
        return sorted(here.items(), key=lambda kv: kv[1].name.casefold())


presence = Presence()
