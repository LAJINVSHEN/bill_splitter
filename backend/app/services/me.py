from __future__ import annotations

from collections import defaultdict
from uuid import UUID

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.middleware.auth import CurrentUser
from app.models import Person, Profile
from app.repositories import bills as bills_repo
from app.schemas.me import CurrencyBalance, MeOut, MePatch, OutstandingBill, PersonBalance, SummaryOut
from app.services.people import ensure_self
from app.services.split_view import split_out


async def get_me(db: AsyncSession, user: CurrentUser) -> MeOut:
    me = await ensure_self(db, user.id, user.display_name)
    await db.commit()
    profile = await db.get(Profile, user.id, populate_existing=True)
    assert profile is not None
    return MeOut(id=profile.id, username=profile.username, display_name=profile.display_name, email=profile.email,
                 role=profile.role, must_change_password=profile.must_change_password,
                 monthly_scan_quota=profile.monthly_scan_quota, default_currency=profile.default_currency,
                 self_person_id=me.id, created_at=profile.created_at)


async def patch_me(db: AsyncSession, user: CurrentUser, data: MePatch) -> MeOut:
    values: dict[str, object] = {}
    if data.display_name is not None:
        values["display_name"] = data.display_name
    if data.default_currency is not None:
        values["default_currency"] = data.default_currency
    if values:
        await db.execute(update(Profile).where(Profile.id == user.id).values(**values))
        if "display_name" in values:  # keep the "Me" person in sync
            await db.execute(update(Person).where(Person.owner_id == user.id, Person.is_self.is_(True))
                             .values(name=str(values["display_name"])[:60]))
        await db.commit()
    return await get_me(db, user)


async def password_changed(db: AsyncSession, user: CurrentUser) -> MeOut:
    await db.execute(update(Profile).where(Profile.id == user.id).values(must_change_password=False))
    await db.commit()
    return await get_me(db, user)


async def summary(db: AsyncSession, user: CurrentUser) -> SummaryOut:
    """Outstanding balances over complete bills, per EFFECTIVE currency, per person and per bill.
    ``home`` sums only bills whose effective currency is the user's default currency; other
    currencies are listed separately and never converted implicitly."""
    me = await ensure_self(db, user.id, user.display_name)
    by_currency: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    by_person: dict[tuple[UUID, str], dict[str, object]] = {}
    bills_out: list[OutstandingBill] = []
    for bill in await bills_repo.bills_with_open_balances(db, user.id):
        split = split_out(bill)
        cur = split.effective_currency  # settle currency when converted; never mixed with others
        payer = split.payer_person_id
        if payer is None:
            continue
        payer_name = next((p.name for p in split.people if p.person_id == payer), "")
        owed_to_me = i_owe = unsettled = 0
        for p in split.people:
            if p.outstanding_cents <= 0:
                continue
            unsettled += 1
            if payer == me.id and p.person_id != me.id:
                owed_to_me += p.outstanding_cents
                key, name, direction = (p.person_id, cur), p.name, "they_owe_me_cents"
            elif p.person_id == me.id and payer != me.id:
                i_owe += p.outstanding_cents
                key, name, direction = (payer, cur), payer_name, "i_owe_them_cents"
            else:
                continue
            entry = by_person.setdefault(key, {"name": name, "they_owe_me_cents": 0, "i_owe_them_cents": 0,
                                               "bills": set()})
            entry[direction] = int(entry[direction]) + p.outstanding_cents  # type: ignore[call-overload]
            entry["bills"].add(bill.id)  # type: ignore[union-attr]
        if owed_to_me or i_owe:
            by_currency[cur][0] += owed_to_me
            by_currency[cur][1] += i_owe
            bills_out.append(OutstandingBill(bill_id=bill.id, title=bill.title or bill.merchant,
                                             bill_date=bill.bill_date.isoformat() if bill.bill_date else None,
                                             currency=cur, owed_to_me_cents=owed_to_me, i_owe_cents=i_owe,
                                             unsettled_people=unsettled))
    await db.commit()
    home = by_currency.get(user.default_currency, [0, 0])
    return SummaryOut(
        home=CurrencyBalance(currency=user.default_currency, owed_to_me_cents=home[0], i_owe_cents=home[1]),
        currencies=[CurrencyBalance(currency=c, owed_to_me_cents=v[0], i_owe_cents=v[1])
                    for c, v in sorted(by_currency.items())],
        people=sorted(
            (PersonBalance(person_id=pid, name=str(e["name"]), currency=cur,
                           they_owe_me_cents=int(e["they_owe_me_cents"]),  # type: ignore[call-overload]
                           i_owe_them_cents=int(e["i_owe_them_cents"]),  # type: ignore[call-overload]
                           bill_count=len(e["bills"]))  # type: ignore[arg-type]
             for (pid, cur), e in by_person.items()),
            key=lambda b: -(b.they_owe_me_cents + b.i_owe_them_cents),
        ),
        bills=bills_out,
    )
