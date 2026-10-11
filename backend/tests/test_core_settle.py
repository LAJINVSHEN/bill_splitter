"""Settle-up simplification (pure core)."""

from __future__ import annotations

import random
from collections import defaultdict

from app.core.settle import Debt, Piece, Plan, _groups, by_pair, simplify


def d(bill: str, debtor: str, creditor: str, amount: int, original: int | None = None) -> Debt:
    return Debt(bill_id=bill, debtor=debtor, creditor=creditor, amount=amount,
                original=amount if original is None else original)


def pairs(plan: Plan) -> list[tuple[str, str, int]]:
    return [(p.payer, p.payee, p.amount) for p in plan.payments]


def cleared(plan: Plan) -> dict[tuple[str, str], int]:
    out: dict[tuple[str, str], int] = defaultdict(int)
    for piece in [x for p in plan.payments for x in p.pieces] + list(plan.cancel_out):
        out[(piece.bill_id, piece.debtor)] += piece.amount
    return dict(out)


def test_chain_collapses_to_one_payment() -> None:
    plan = simplify([d("b1", "A", "B", 1000), d("b2", "B", "C", 1000)])
    assert pairs(plan) == [("A", "C", 1000)] and plan.debt_count == 2
    # Paying C clears A's debt to B and B's debt to C: both bills close.
    assert cleared(plan) == {("b1", "A"): 1000, ("b2", "B"): 1000}


def test_partial_chain_keeps_the_rest() -> None:
    plan = simplify([d("b1", "A", "B", 1000), d("b2", "B", "C", 600)])
    assert sorted(pairs(plan)) == [("A", "B", 400), ("A", "C", 600)]


def test_two_people_owing_each_other_net_out_and_close_both_bills() -> None:
    plan = simplify([d("b1", "A", "B", 1000), d("b2", "B", "A", 600)])
    assert pairs(plan) == [("A", "B", 400)] and plan.cancel_out == ()
    assert cleared(plan) == {("b1", "A"): 1000, ("b2", "B"): 600}  # the 600 loop rides along


def test_pure_loop_needs_no_money() -> None:
    plan = simplify([d("b1", "A", "B", 500), d("b2", "B", "C", 500), d("b3", "C", "A", 500)])
    assert plan.payments == () and len(plan.cancel_out) == 3
    assert cleared(plan) == {("b1", "A"): 500, ("b2", "B"): 500, ("b3", "C"): 500}


def test_everyone_owes_a_different_person() -> None:
    # A → B, B → C, C → D, D → A with different amounts: one loop of 300 plus a chain.
    plan = simplify([d("1", "A", "B", 1000), d("2", "B", "C", 800), d("3", "C", "D", 500), d("4", "D", "A", 300)])
    assert plan.debt_count == 4 and len(plan.payments) <= 3
    assert sum(p.amount for p in plan.payments) == 700  # = total of positive nets (200 + 300 + 200)


def test_disconnected_groups_never_pay_each_other() -> None:
    plan = simplify([d("1", "A", "B", 1000), d("2", "C", "D", 1000)])
    assert sorted(pairs(plan)) == [("A", "B", 1000), ("C", "D", 1000)]


def test_each_debtor_pays_one_creditor_when_amounts_fit() -> None:
    # B and C each owe A; A owes D. Best fit sends B and C straight to whoever they fit.
    plan = simplify([d("1", "B", "A", 300), d("2", "C", "A", 700), d("3", "A", "D", 700)])
    assert sorted(pairs(plan)) == [("B", "A", 300), ("C", "D", 700)]


def test_old_bills_clear_first() -> None:
    plan = simplify([d("old", "A", "B", 500), d("new", "A", "B", 500), d("back", "B", "A", 400)])
    assert pairs(plan) == [("A", "B", 600)]
    assert cleared(plan) == {("old", "A"): 500, ("new", "A"): 500, ("back", "B"): 400}


def test_merged_currencies_clear_in_each_bills_own_currency() -> None:
    # MYR bill converted at 0.3 into SGD: 1000 MYR cents = 300 SGD cents.
    plan = simplify([d("sgd", "A", "B", 500), d("myr", "B", "C", 300, original=1000)])
    assert sorted(pairs(plan)) == [("A", "B", 200), ("A", "C", 300)]
    assert cleared(plan) == {("sgd", "A"): 500, ("myr", "B"): 1000}


def test_amount_that_rounds_to_zero_cancels_out() -> None:
    plan = simplify([d("jpy", "A", "B", 0, original=1)])
    assert plan.payments == () and cleared(plan) == {("jpy", "A"): 1}


def _greedy_count(debts: list[Debt]) -> int:
    """The textbook min-cash-flow (ignores who's connected to whom) — a yardstick only."""
    net: dict[str, int] = defaultdict(int)
    for x in debts:
        net[x.debtor] -= x.amount
        net[x.creditor] += x.amount
    owes = sorted((-n for n in net.values() if n < 0), reverse=True)
    due = sorted((n for n in net.values() if n > 0), reverse=True)
    count = 0
    while owes:
        owes.sort(reverse=True)
        due.sort(reverse=True)
        f = min(owes[0], due[0])
        owes[0] -= f
        due[0] -= f
        owes = [o for o in owes if o]
        due = [o for o in due if o]
        count += 1
    return count


def test_random_ledgers_keep_nets_and_clear_every_debt() -> None:
    rng = random.Random(7)
    worse = 0
    for _ in range(400):
        people = [chr(65 + i) for i in range(rng.randint(2, 7))]
        debts = []
        for i in range(rng.randint(1, 12)):
            a, b = rng.sample(people, 2)
            debts.append(d(f"bill{i}", a, b, rng.randint(1, 5000)))
        plan = simplify(debts)
        # 1. every debt is cleared exactly once, nothing more
        want: dict[tuple[str, str], int] = defaultdict(int)
        for x in debts:
            want[(x.bill_id, x.debtor)] += x.amount
        assert cleared(plan) == dict(want)
        # 2. payments reproduce every net balance
        net: dict[str, int] = defaultdict(int)
        for x in debts:
            net[x.debtor] -= x.amount
            net[x.creditor] += x.amount
        paid: dict[str, int] = defaultdict(int)
        for p in plan.payments:
            assert p.amount > 0 and p.payer != p.payee
            paid[p.payer] -= p.amount
            paid[p.payee] += p.amount
        assert {k: v for k, v in net.items() if v} == {k: v for k, v in paid.items() if v}
        # 3. recording any ONE payment moves nets by exactly that payment (loops net to zero)
        for p in plan.payments:
            moved: dict[str, int] = defaultdict(int)
            owner = {(x.bill_id, x.debtor): x.creditor for x in debts}
            for piece in p.pieces:
                moved[piece.debtor] += piece.amount
                moved[owner[(piece.bill_id, piece.debtor)]] -= piece.amount
            assert {k: v for k, v in moved.items() if v} == (
                {p.payer: p.amount, p.payee: -p.amount})
        # 4. never more payments than debts; almost always as few as the unconstrained greedy
        assert len(plan.payments) <= plan.debt_count
        group = _groups(debts)
        by_group: dict[str, list[Debt]] = defaultdict(list)
        for x in debts:
            by_group[group[x.debtor]].append(x)
        worse += len(plan.payments) > sum(_greedy_count(g) for g in by_group.values())
    # Following debt chains is a constraint (it's what makes each payment recordable), but it
    # rarely costs an extra payment (~2% of random ledgers, when no chain links the people).
    assert worse <= 16


def test_by_pair_keeps_original_debts() -> None:
    debts = [d("1", "A", "B", 300), d("2", "A", "B", 200), d("3", "B", "C", 400), d("4", "B", "A", 100)]
    assert [(p.payer, p.payee, p.amount) for p in by_pair(debts)] == [
        ("A", "B", 500), ("B", "C", 400), ("B", "A", 100)]
    assert by_pair(debts)[0].pieces == (Piece("1", "A", 300), Piece("2", "A", 200))
