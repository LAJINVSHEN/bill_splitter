"""Development-only helpers: local access tokens, dev login and deterministic seed data.

Everything here is guarded by ``dev_auth_enabled``: ``ENVIRONMENT != production`` **and**
``SUPABASE_ADMIN_BACKEND=fake``. Tokens are HS256 with ``SUPABASE_JWT_SECRET`` and the same
claims the real middleware expects, so no code path differs after login.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal

import jwt
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.core.currencies import exponent
from app.core.receipt_validation import ReceiptCharge, ReceiptItem, infer_charge_kind, validate_receipt
from app.models import Bill, BillCharge, BillItem, BillParticipant, ItemShare, Person, Profile

DEV_TOKEN_HOURS = 12
_NS = uuid.UUID("5d7c3a52-6f0e-4b8e-9a51-0e7b1f0c9e11")


def dev_auth_enabled(settings: Settings) -> bool:
    return not settings.is_production and settings.supabase_admin_backend == "fake"


def mint_dev_token(settings: Settings, user_id: uuid.UUID, hours: float = DEV_TOKEN_HOURS) -> tuple[str, int]:
    """(token, expires_in seconds) – identical claims to a Supabase access token."""
    now = int(time.time())
    ttl = int(hours * 3600)
    claims: dict[str, object] = {"sub": str(user_id), "aud": settings.jwt_audience, "role": "authenticated",
                                 "iat": now, "exp": now + ttl}
    if settings.jwt_issuer:
        claims["iss"] = settings.jwt_issuer
    return jwt.encode(claims, settings.supabase_jwt_secret, algorithm="HS256"), ttl


# ---------------------------------------------------------------------------------------- seed
def _id(*parts: object) -> uuid.UUID:
    return uuid.uuid5(_NS, ":".join(str(p) for p in parts))


SEED_PEOPLE = [  # (username, display name) – invented
    ("george", "George"),
    ("maya", "Maya Lim"),
    ("arjun", "Arjun Nair"),
    ("lena", "Lena Okafor"),
    ("tomas", "Tomás Silva"),
]
EXTRA_FRIEND = "Priya Raman"


@dataclass(frozen=True)
class SeedResult:
    admin_id: uuid.UUID
    member_ids: list[uuid.UUID]
    bill_ids: list[uuid.UUID]


async def _ensure_profile(db: AsyncSession, settings: Settings, username: str, display: str, role: str) -> Profile:
    profile = await db.scalar(select(Profile).where(Profile.username == username))
    if profile is None:
        profile = Profile(id=_id("user", username), username=username, email=f"{username}@{settings.auth_email_domain}",
                          display_name=display, role=role, must_change_password=False,
                          monthly_scan_quota=settings.default_user_monthly_quota,
                          default_currency=settings.default_currency)
        db.add(profile)
    else:  # stable state for E2E: active, no forced password change
        profile.display_name, profile.role = display, role
        profile.must_change_password, profile.disabled_at = False, None
    await db.flush()
    me = await db.scalar(select(Person).where(Person.owner_id == profile.id, Person.is_self.is_(True)))
    if me is None:
        db.add(Person(id=_id("person", profile.id, "self"), owner_id=profile.id, name=display, is_self=True,
                      color_seed=_id(username).int % 360))
    else:
        me.name, me.archived_at = display, None
    await db.flush()
    return profile


async def _ensure_person(db: AsyncSession, owner_id: uuid.UUID, name: str) -> uuid.UUID:
    pid = _id("person", owner_id, name)
    person = await db.get(Person, pid)
    if person is None:
        db.add(Person(id=pid, owner_id=owner_id, name=name, color_seed=pid.int % 360))
    else:
        person.name, person.archived_at = name, None
    await db.flush()
    return pid


async def _seed_bill(db: AsyncSession, owner_id: uuid.UUID, payer: uuid.UUID, key: str, *, title: str,
                     merchant: str, bill_date: date, currency: str, status: str, people: list[uuid.UUID],
                     items: list[tuple[str, str, str]], charges: list[tuple[str, str]], subtotal: str | None,
                     grand: str, assignments: list[tuple[int, str, list[tuple[uuid.UUID, str | None]]]],
                     settle: tuple[str, Decimal] | None = None) -> uuid.UUID:
    """items: (name, qty, unit price) in major units; assignments: (item index, mode, [(person, weight|amount)])."""
    exp = exponent(currency)
    scale = Decimal(1).scaleb(exp)

    def minor(v: str) -> int:
        return int((Decimal(v) * scale).to_integral_value())

    bill_id = _id("bill", owner_id, key)
    await db.execute(delete(Bill).where(Bill.id == bill_id))  # cascades to items, shares, charges, participants
    rows = [(n, Decimal(q), minor(u), minor(str(Decimal(q) * Decimal(u)))) for n, q, u in items]
    charge_rows = [(n, minor(a)) for n, a in charges]
    result = validate_receipt([ReceiptItem(n, q, u, t) for n, q, u, t in rows],
                              [ReceiptCharge(n, a) for n, a in charge_rows],
                              minor(grand), minor(subtotal) if subtotal else None, exp)
    db.add(Bill(id=bill_id, owner_id=owner_id, title=title, merchant=merchant, bill_date=bill_date, currency=currency,
                status=status, source="manual", payer_person_id=payer,
                subtotal_cents=minor(subtotal) if subtotal else None, grand_total_cents=minor(grand),
                tax_scenario=result.tax_scenario if result.ok else None,
                settle_currency=settle[0] if settle else None, fx_rate=settle[1] if settle else None,
                receipt_meta={"seed": key}))
    await db.flush()
    for pos, pid in enumerate(people):
        db.add(BillParticipant(bill_id=bill_id, person_id=pid, position=pos))
    item_ids = [_id("item", bill_id, i) for i in range(len(rows))]
    modes = {i: m for i, m, _ in assignments}
    for pos, ((name, qty, unit, total), iid) in enumerate(zip(rows, item_ids, strict=True)):
        db.add(BillItem(id=iid, bill_id=bill_id, position=pos, name=name, quantity=qty, unit_price_cents=unit,
                        total_price_cents=total, split_mode=modes.get(pos)))
    for pos, ((name, amount), pct) in enumerate(zip(charge_rows, result.charge_percents, strict=True)):
        db.add(BillCharge(bill_id=bill_id, position=pos, name=name, kind=infer_charge_kind(name, amount),
                          amount_cents=amount, percent=pct))
    await db.flush()
    for index, mode, shares in assignments:
        for pos, (pid, value) in enumerate(shares):
            db.add(ItemShare(item_id=item_ids[index], bill_id=bill_id, person_id=pid, position=pos,
                             weight=Decimal(value) if mode == "weighted" and value else
                             (Decimal(1) if mode == "equal" else None),
                             amount_cents=minor(value) if mode == "custom" and value else None))
    await db.flush()
    return bill_id


async def _settle(db: AsyncSession, owner_id: uuid.UUID, bill_id: uuid.UUID, person_id: uuid.UUID,
                  amount_cents: int | None) -> None:
    from app.repositories import bills as bills_repo
    from app.services.split_view import split_out

    bill = await bills_repo.get_bill(db, owner_id, bill_id, full=True)
    assert bill is not None
    part = next(p for p in bill.participants if p.person_id == person_id)
    if amount_cents is None:
        amount_cents = next(p.effective_total_cents for p in split_out(bill).people if p.person_id == person_id)
    part.settled_at = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)
    part.settled_amount_cents = amount_cents
    await db.flush()


async def seed(sm: async_sessionmaker[AsyncSession], settings: Settings) -> SeedResult:
    """Idempotent: re-running restores exactly the same users, people, rates and bills."""
    from app.services.fx import save_rate

    async with sm() as db:
        profiles = {}
        for username, display in SEED_PEOPLE:
            profiles[username] = await _ensure_profile(db, settings, username, display,
                                                       "admin" if username == "george" else "member")
        owner = profiles["george"].id
        me = (await db.scalar(select(Person.id).where(Person.owner_id == owner, Person.is_self.is_(True))))
        friend = {u: await _ensure_person(db, owner, d) for u, d in SEED_PEOPLE[1:]}
        await _ensure_person(db, owner, EXTRA_FRIEND)
        maya, arjun, lena, tomas = friend["maya"], friend["arjun"], friend["lena"], friend["tomas"]

        hotpot = await _seed_bill(
            db, owner, me, "hotpot", title="Saturday hotpot", merchant="Red Lantern Hotpot House",
            bill_date=date(2026, 10, 3), currency="SGD", status="complete", people=[me, maya, arjun, lena],
            items=[("Mala soup base (large)", "1", "28.00"), ("Wagyu beef platter", "1", "38.00"),
                   ("Prawn paste", "2", "9.80"), ("Tofu & mushroom set", "1", "14.50"), ("Jasmine tea", "4", "2.50")],
            charges=[("Service charge 10%", "11.01"), ("GST 9%", "10.90")], subtotal="110.10", grand="132.01",
            assignments=[(0, "equal", [(me, None), (maya, None), (arjun, None), (lena, None)]),
                         (1, "custom", [(me, "20.00"), (arjun, "18.00")]),
                         (2, "weighted", [(maya, "1"), (lena, "1")]),
                         (3, "single", [(lena, None)]),
                         (4, "equal", [(me, None), (maya, None), (arjun, None), (lena, None)])],
        )
        await _settle(db, owner, hotpot, maya, None)  # paid in full
        await _settle(db, owner, hotpot, arjun, 2000)  # partial: S$20.00

        rate = Decimal("0.0091")
        await save_rate(db, owner, "JPY", "SGD", rate)
        ramen = await _seed_bill(
            db, owner, me, "ramen", title="Kyoto ramen night", merchant="Menya Kazeguruma",
            bill_date=date(2026, 9, 20), currency="JPY", status="complete", people=[me, lena, tomas],
            items=[("Shoyu ramen", "3", "1100"), ("Gyoza", "2", "480"), ("Draft beer", "2", "650")],
            charges=[("Consumption tax 10% (incl.)", "505")], subtotal=None, grand="5560",
            assignments=[(0, "equal", [(me, None), (lena, None), (tomas, None)]),
                         (1, "equal", [(me, None), (tomas, None)]),
                         (2, "weighted", [(me, "1"), (tomas, "1")])],
            settle=("SGD", rate),
        )

        lunch = await _seed_bill(
            db, owner, me, "lunch", title="Team lunch", merchant="Kopi & Co. Canteen",
            bill_date=date(2026, 10, 6), currency="SGD", status="review", people=[me, maya, arjun, tomas],
            items=[("Chicken rice", "3", "5.50"), ("Laksa", "2", "6.80"), ("Iced lemon tea", "5", "1.80")],
            charges=[("GST 9%", "3.70")], subtotal="41.10", grand="44.80",  # items add up to 39.10 → mismatch
            assignments=[],
        )
        await db.commit()
        return SeedResult(admin_id=owner, member_ids=[profiles[u].id for u, _ in SEED_PEOPLE[1:]],
                          bill_ids=[hotpot, ramen, lunch])
