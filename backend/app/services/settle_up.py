"""Settle up across bills: the original debts, the fewest-payments plan, and recording a row.

Reads every open debt on the complete bills the user can see (the same ``split_out`` the bill
page uses), groups it per effective currency (or merges currencies into one with the user's
saved rates, when asked), and hands it to the pure ``core.settle``.

Who is who: people are matched by account across bills. George's "Jeff" and Ben's "Jeffrey",
both linked to Jeff's account, are one person here; placeholders stay per bill owner. On bills
the user owns, every debt counts (as before); on bills shared with them, only their own.

A group narrows it to its members' debts (on any visible bill). Debts between accounts are
simplified; debts involving a placeholder are listed separately, never folded into an account.

Recording a row writes ordinary partial settlements on the bills it clears when the user owns
that bill or is the one being paid; any other piece becomes an "I've paid" claim the bill's
owner confirms. Bill pages, share links and the summary always agree.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.currencies import exponent
from app.core.money import convert_minor
from app.core.settle import Debt, Payment, Piece, by_pair, simplify
from app.errors import Conflict, NotFound
from app.middleware.auth import CurrentUser
from app.models import Bill, BillParticipant, Group, GroupMember, PaymentClaim, Person, Profile
from app.repositories import bills as bills_repo
from app.schemas.me import (
    SettleDebt,
    SettleGroup,
    SettlePayment,
    SettlePerson,
    SettlePiece,
    SettleRecordIn,
    SettleUndoIn,
    SettleUpOut,
)
from app.services import claims as claims_svc
from app.services import collab, fx
from app.services.people import ensure_self
from app.services.split_view import effective_currency, split_out


def key_of(person: Person) -> str:
    """The ledger identity: the account when there is one, else this placeholder."""
    return f"u:{person.account_id}" if person.account_id else f"p:{person.id}"


class Viewpoint:
    """How one user names everyone on the bills they can see."""

    def __init__(self, me: Person, mine: dict[UUID, Person], names: dict[UUID, str]) -> None:
        self.me = me
        self.me_key = f"u:{me.owner_id}"
        self._mine = mine  # account → the user's own entry for it
        self._names = names  # owner id → display name (for someone else's placeholder)

    @classmethod
    async def load(cls, db: AsyncSession, user: CurrentUser) -> Viewpoint:
        me = await ensure_self(db, user.id, user.display_name)
        rows = (await db.scalars(select(Person).where(Person.owner_id == user.id, Person.linked_profile_id.is_not(None))
                                 .order_by(Person.archived_at.desc().nulls_last()))).all()
        owners = select(Bill.owner_id).where(bills_repo.visible_to(user.id), Bill.deleted_at.is_(None))
        names = dict((await db.execute(select(Profile.id, Profile.display_name).where(Profile.id.in_(owners)))).all())
        return cls(me, {p.linked_profile_id: p for p in rows}, names)  # type: ignore[misc]

    def person(self, bill: Bill, person: Person) -> SettlePerson:
        account = person.account_id
        if account == self.me.owner_id:
            p = self.me
            return SettlePerson(person_id=p.id, name=p.name, color_seed=p.color_seed, is_self=True, account_id=account)
        if account is not None and account in self._mine:
            p = self._mine[account]
            return SettlePerson(person_id=p.id, name=p.name, color_seed=p.color_seed, is_self=False,
                                account_id=account)
        foreign = bill.owner_id != self.me.owner_id and account is None
        return SettlePerson(person_id=person.id, name=person.name, color_seed=person.color_seed, is_self=False,
                            account_id=account, owner_name=self._names.get(bill.owner_id) if foreign else None)


@dataclass
class _Ledger:
    combined_into: str | None
    currencies: list[str]
    missing_rates: list[str]
    view: Viewpoint
    debts: dict[str, list[Debt]] = field(default_factory=dict)  # plan currency → oldest bill first
    separate: dict[str, list[Debt]] = field(default_factory=dict)  # group: debts involving a placeholder
    bills: dict[str, Bill] = field(default_factory=dict)
    people: dict[str, SettlePerson] = field(default_factory=dict)
    creditor: dict[str, str] = field(default_factory=dict)  # bill id → its payer's key
    # (bill id, debtor key) → the participant rows behind it and what each still owes (bill's currency)
    owed: dict[tuple[str, str], list[tuple[BillParticipant, int]]] = field(default_factory=dict)


async def _group_keys(db: AsyncSession, user: CurrentUser, group_id: UUID, view: Viewpoint) -> set[str]:
    group = await db.scalar(select(Group).where(Group.id == group_id, Group.owner_id == user.id))
    if group is None:
        raise NotFound("Group")
    members = (await db.scalars(select(Person).join(GroupMember, GroupMember.person_id == Person.id)
                                .where(GroupMember.group_id == group_id))).all()
    return {key_of(p) for p in members} | {view.me_key}


async def _ledger(db: AsyncSession, user: CurrentUser, combine: str | None, *, lock: bool = False,
                  group_id: UUID | None = None) -> _Ledger:
    view = await Viewpoint.load(db, user)
    in_group = await _group_keys(db, user, group_id, view) if group_id else None
    rows: list[tuple[str, Bill, str, str, int]] = []  # (currency, bill, debtor, creditor, outstanding)
    people: dict[str, SettlePerson] = {}
    owed: dict[tuple[str, str], list[tuple[BillParticipant, int]]] = {}
    creditor_of: dict[str, str] = {}
    for bill in reversed(await bills_repo.bills_with_open_balances(db, user.id, for_update=lock)):
        split = split_out(bill)
        if split.payer_person_id is None:
            continue
        parts = {p.person_id: p for p in bill.participants}
        creditor = key_of(parts[split.payer_person_id].person)
        creditor_of[str(bill.id)] = creditor
        owned = bill.owner_id == user.id
        for p in split.people:
            part = parts[p.person_id]
            debtor = key_of(part.person)
            if p.outstanding_cents <= 0 or debtor == creditor:
                continue
            if in_group is not None:
                if debtor not in in_group or creditor not in in_group:
                    continue
            elif not owned and view.me_key not in (debtor, creditor):
                continue
            for k, person in ((debtor, part.person), (creditor, parts[split.payer_person_id].person)):
                people.setdefault(k, view.person(bill, person))
            rows.append((split.effective_currency, bill, debtor, creditor, p.outstanding_cents))
            owed.setdefault((str(bill.id), debtor), []).append((part, p.outstanding_cents))

    currencies = sorted({r[0] for r in rows})
    rates: dict[str, Decimal] = {}
    missing: list[str] = []
    if combine:
        for cur in currencies:
            if cur != combine:
                found = await fx.lookup(db, user.id, cur, combine)
                if found is None:
                    missing.append(cur)
                else:
                    rates[cur] = found.rate
    merge = combine if combine and not missing else None

    ledger = _Ledger(combined_into=merge, currencies=currencies, missing_rates=missing, view=view, people=people,
                     owed=owed, creditor=creditor_of, bills={str(r[1].id): r[1] for r in rows})
    seen: set[tuple[str, str]] = set()
    for cur, bill, debtor, creditor, _ in rows:
        if (str(bill.id), debtor) in seen:  # one human twice on a bill: one debt for both rows
            continue
        seen.add((str(bill.id), debtor))
        amount = sum(o for _, o in owed[(str(bill.id), debtor)])
        target = merge or cur
        plan_amount = amount if cur == target else convert_minor(amount, rates[cur], exponent(cur), exponent(target))
        debt = Debt(bill_id=str(bill.id), debtor=debtor, creditor=creditor, amount=plan_amount, original=amount)
        placeholder = debtor.startswith("p:") or creditor.startswith("p:")
        bucket = ledger.separate if in_group is not None and placeholder else ledger.debts
        bucket.setdefault(target, []).append(debt)
    return ledger


def _payment(ledger: _Ledger, p: Payment) -> SettlePayment:
    return SettlePayment(from_person=ledger.people[p.payer], to_person=ledger.people[p.payee],
                         amount_cents=p.amount, bill_count=len({x.bill_id for x in p.pieces}))


def _debt(ledger: _Ledger, d: Debt) -> SettleDebt:
    bill = ledger.bills[d.bill_id]
    return SettleDebt(bill_id=bill.id, title=bill.title or bill.merchant, bill_date=bill.bill_date,
                      from_person=ledger.people[d.debtor], to_person=ledger.people[d.creditor],
                      amount_cents=d.amount, currency=effective_currency(bill), original_cents=d.original)


def _out(ledger: _Ledger) -> SettleUpOut:
    groups = []
    for cur in sorted(ledger.debts.keys() | ledger.separate.keys()):
        debts = ledger.debts.get(cur, [])
        separate = ledger.separate.get(cur, [])
        plan = simplify(debts)
        cancel_people = sorted({x.debtor for x in plan.cancel_out}
                               | {d.creditor for d in debts for x in plan.cancel_out
                                  if (d.bill_id, d.debtor) == (x.bill_id, x.debtor)},
                               key=lambda pid: ledger.people[pid].name.casefold())
        groups.append(SettleGroup(
            currency=cur,
            original=[_payment(ledger, p) for p in by_pair(debts)],
            simplified=[_payment(ledger, p) for p in plan.payments],
            cancel_out=[ledger.people[pid] for pid in cancel_people],
            separate=[_payment(ledger, p) for p in by_pair(separate)],
            debts=[_debt(ledger, d) for d in reversed(debts + separate)],
        ))
    return SettleUpOut(combined_into=ledger.combined_into, currencies=ledger.currencies,
                       missing_rates=ledger.missing_rates, groups=groups)


async def settle_up(db: AsyncSession, user: CurrentUser, combine: str | None, group_id: UUID | None = None) -> SettleUpOut:
    out = _out(await _ledger(db, user, combine, group_id=group_id))
    await db.commit()
    return out


def _pieces_for(ledger: _Ledger, data: SettleRecordIn) -> tuple[Piece, ...]:
    debts = ledger.debts.get(data.currency, [])
    if data.view == "cancel_out":
        pieces = simplify(debts).cancel_out
    else:
        rows = (by_pair(debts) if data.view == "original" else by_pair(ledger.separate.get(data.currency, []))
                if data.view == "separate" else simplify(debts).payments)
        row = next((p for p in rows if ledger.people[p.payer].person_id == data.from_person_id
                    and ledger.people[p.payee].person_id == data.to_person_id and p.amount == data.amount_cents), None)
        pieces = row.pieces if row else ()
    if not pieces:
        raise Conflict("plan_changed", "Balances changed since this was shown. Here's the latest.")
    return pieces


async def record(db: AsyncSession, user: CurrentUser, data: SettleRecordIn) -> SettleUpOut:
    """Mark one row paid. Pieces on bills the user owns, or where they're the one paid, are
    settled now; the rest become "I've paid" claims for those bills' owners."""
    ledger = await _ledger(db, user, data.combine, lock=True, group_id=data.group_id)
    now = datetime.now(UTC)
    applied: list[SettlePiece] = []
    touched: dict[str, Bill] = {}
    for piece in _pieces_for(ledger, data):
        bill = ledger.bills[piece.bill_id]
        direct = bill.owner_id == user.id or ledger.creditor[piece.bill_id] == ledger.view.me_key
        left = piece.amount
        entries = ledger.owed[(piece.bill_id, piece.debtor)]
        for n, (part, outstanding) in enumerate(entries):
            amount = left if n == len(entries) - 1 else min(left, outstanding)
            if amount <= 0:
                continue
            left -= amount
            if direct:
                paid = (part.settled_amount_cents or 0) if part.settled_at else 0
                part.settled_amount_cents = paid + amount
                part.settled_at = now
                touched[piece.bill_id] = bill
                if amount >= outstanding:  # paid off: a pending "I've paid" has nothing left to decide
                    await claims_svc.supersede(db, bill.id, part.person_id)
            elif not await claims_svc.has_open_for(db, bill.id, part.person_id):
                db.add(PaymentClaim(bill_id=bill.id, person_id=part.person_id, owner_id=bill.owner_id, via="app",
                                    claimed_by=user.id, amount_cents=amount, currency=effective_currency(bill),
                                    expected_total_cents=outstanding, client_key=uuid4()))
            else:
                continue
            applied.append(SettlePiece(bill_id=bill.id, person_id=part.person_id, amount_cents=amount,
                                       pending=not direct))
    for bill in touched.values():
        await collab.record(db, bill, user, "settlement")
    await db.commit()
    out = await settle_up(db, user, data.combine, data.group_id)
    out.applied = applied
    return out


async def undo(db: AsyncSession, user: CurrentUser, data: SettleUndoIn) -> SettleUpOut:
    """Reverse a recorded row: subtract each piece again, and take back the claims it sent. A
    payment that drops back to nothing is unmarked entirely (and a confirmed claim no longer stands)."""
    from app.services.bills import can_settle

    by_bill: dict[UUID, list[tuple[UUID, int, bool]]] = {}
    for p in data.pieces:
        by_bill.setdefault(p.bill_id, []).append((p.person_id, p.amount_cents, p.pending))
    for bill_id in sorted(by_bill):
        bill = await bills_repo.get_visible_bill(db, user.id, bill_id, full=True, for_update=True)
        if bill is None:
            raise NotFound("Bill")
        parts = {p.person_id: p for p in bill.participants}
        changed = False
        for person_id, amount, pending in by_bill[bill_id]:
            if pending:
                await db.execute(update(PaymentClaim).where(
                    PaymentClaim.bill_id == bill_id, PaymentClaim.person_id == person_id,
                    PaymentClaim.claimed_by == user.id, PaymentClaim.status == "claimed",
                ).values(status="withdrawn", decided_at=datetime.now(UTC)))
                continue
            if not can_settle(bill, user):
                raise collab.OwnerOnly(await collab.owner_name(db, bill))
            part = parts.get(person_id)
            paid = (part.settled_amount_cents or 0) if part is not None and part.settled_at else 0
            if part is None or paid < amount:
                raise Conflict("plan_changed", "That payment was already changed elsewhere. Here's the latest.")
            if paid == amount:
                part.settled_at = None
                part.settled_amount_cents = None
                await claims_svc.revert(db, bill.id, person_id)
            else:
                part.settled_amount_cents = paid - amount
            changed = True
        if changed:
            await collab.record(db, bill, user, "settlement")
    await db.commit()
    return await settle_up(db, user, data.combine, data.group_id)


__all__ = ["Viewpoint", "key_of", "record", "settle_up", "undo"]
