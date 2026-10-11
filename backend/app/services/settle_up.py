"""Settle up across bills: the original debts, the fewest-payments plan, and recording a row.

Reads every open debt on the owner's complete bills (the same ``split_out`` the bill page
uses), groups it per effective currency (or merges currencies into one with the user's saved
rates, when asked), and hands it to the pure ``core.settle``. Recording a row writes ordinary
partial settlements on the bills it clears, so bill pages, share links and the summary agree.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.currencies import exponent
from app.core.money import convert_minor
from app.core.settle import Debt, Payment, Piece, by_pair, simplify
from app.errors import Conflict, NotFound
from app.middleware.auth import CurrentUser
from app.models import Bill, BillParticipant
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
from app.services import fx
from app.services.split_view import effective_currency, split_out


@dataclass
class _Ledger:
    combined_into: str | None
    currencies: list[str]
    missing_rates: list[str]
    debts: dict[str, list[Debt]] = field(default_factory=dict)  # plan currency → oldest bill first
    bills: dict[str, Bill] = field(default_factory=dict)
    people: dict[str, SettlePerson] = field(default_factory=dict)
    # (bill id, debtor id) → the participant row and what they still owe (bill's effective currency)
    owed: dict[tuple[str, str], tuple[Bill, BillParticipant, int]] = field(default_factory=dict)


async def _ledger(db: AsyncSession, user: CurrentUser, combine: str | None, *, lock: bool = False) -> _Ledger:
    rows: list[tuple[str, Bill, str, str, int]] = []  # (currency, bill, debtor, creditor, outstanding)
    people: dict[str, SettlePerson] = {}
    owed: dict[tuple[str, str], tuple[Bill, BillParticipant, int]] = {}
    for bill in reversed(await bills_repo.bills_with_open_balances(db, user.id, for_update=lock)):
        split = split_out(bill)
        if split.payer_person_id is None:
            continue
        parts = {p.person_id: p for p in bill.participants}
        for p in split.people:
            people.setdefault(str(p.person_id), SettlePerson(person_id=p.person_id, name=p.name,
                                                             color_seed=p.color_seed, is_self=p.is_self))
            if p.outstanding_cents > 0:
                rows.append((split.effective_currency, bill, str(p.person_id), str(split.payer_person_id),
                             p.outstanding_cents))
                owed[(str(bill.id), str(p.person_id))] = (bill, parts[p.person_id], p.outstanding_cents)

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

    ledger = _Ledger(combined_into=merge, currencies=currencies, missing_rates=missing, people=people, owed=owed,
                     bills={str(r[1].id): r[1] for r in rows})
    for cur, bill, debtor, creditor, amount in rows:
        target = merge or cur
        plan_amount = amount if cur == target else convert_minor(amount, rates[cur], exponent(cur), exponent(target))
        ledger.debts.setdefault(target, []).append(
            Debt(bill_id=str(bill.id), debtor=debtor, creditor=creditor, amount=plan_amount, original=amount))
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
    for cur in sorted(ledger.debts):
        debts = ledger.debts[cur]
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
            debts=[_debt(ledger, d) for d in reversed(debts)],
        ))
    return SettleUpOut(combined_into=ledger.combined_into, currencies=ledger.currencies,
                       missing_rates=ledger.missing_rates, groups=groups)


async def settle_up(db: AsyncSession, user: CurrentUser, combine: str | None) -> SettleUpOut:
    out = _out(await _ledger(db, user, combine))
    await db.commit()
    return out


def _pieces_for(ledger: _Ledger, data: SettleRecordIn) -> tuple[Piece, ...]:
    debts = ledger.debts.get(data.currency, [])
    if data.view == "cancel_out":
        pieces = simplify(debts).cancel_out
    else:
        rows = by_pair(debts) if data.view == "original" else simplify(debts).payments
        row = next((p for p in rows if p.payer == str(data.from_person_id) and p.payee == str(data.to_person_id)
                    and p.amount == data.amount_cents), None)
        pieces = row.pieces if row else ()
    if not pieces:
        raise Conflict("plan_changed", "Balances changed since this was shown. Here's the latest.")
    return pieces


async def record(db: AsyncSession, user: CurrentUser, data: SettleRecordIn) -> SettleUpOut:
    """Mark one row paid: add each cleared piece to that participant's settled amount."""
    ledger = await _ledger(db, user, data.combine, lock=True)
    now = datetime.now(UTC)
    pieces = _pieces_for(ledger, data)
    for piece in pieces:
        bill, part, outstanding = ledger.owed[(piece.bill_id, piece.debtor)]
        paid = (part.settled_amount_cents or 0) if part.settled_at else 0
        part.settled_amount_cents = paid + piece.amount
        part.settled_at = now
        bill.updated_at = now
        if piece.amount >= outstanding:  # paid off: a friend's pending "I've paid" has nothing left to decide
            await claims_svc.supersede(db, bill.id, UUID(piece.debtor))
    await db.commit()
    out = await settle_up(db, user, data.combine)
    out.applied = [SettlePiece(bill_id=UUID(p.bill_id), person_id=UUID(p.debtor), amount_cents=p.amount) for p in pieces]
    return out


async def undo(db: AsyncSession, user: CurrentUser, data: SettleUndoIn) -> SettleUpOut:
    """Reverse a recorded row: subtract each piece again. A payment that drops back to nothing
    is unmarked entirely (and a confirmed "I've paid" no longer stands)."""
    by_bill: dict[UUID, list[tuple[UUID, int]]] = {}
    for p in data.pieces:
        by_bill.setdefault(p.bill_id, []).append((p.person_id, p.amount_cents))
    for bill_id in sorted(by_bill):
        bill = await bills_repo.get_bill(db, user.id, bill_id, full=True, for_update=True)
        if bill is None:
            raise NotFound("Bill")
        parts = {p.person_id: p for p in bill.participants}
        for person_id, amount in by_bill[bill_id]:
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
        bill.updated_at = datetime.now(UTC)
    await db.commit()
    return await settle_up(db, user, data.combine)
