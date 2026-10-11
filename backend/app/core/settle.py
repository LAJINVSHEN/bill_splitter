"""Settle-up simplification. PURE: no I/O, no framework imports.

Every open bill debt is an edge ``debtor → creditor`` (the bill's payer). Simplifying keeps
everyone's NET balance and replaces the edges with as few payments as it can:

1. ``net[p]`` = owed to p − owed by p (sums to zero).
2. Biggest debtor first, pick a creditor reachable through chains of debts (``A → B → C``).
   Like the classic greedy, each payment should zero someone out: prefer the smallest creditor
   who can take the debtor's whole remainder (so each person pays one person), else a creditor
   the debtor can clear completely. Repeat until every net is zero.
3. What's left are debts that cancel out in a loop (``A → B → A``). They ride along with a
   payment in the same group of people, or stand alone when no money needs to move at all.

Payments only ever follow existing debt chains, so recording one maps back to real bill debts:
"A pays C" settles A's debt to B *and* B's debt to C, and every bill page stays true. That
constraint rarely costs a payment versus the unconstrained greedy (~2% of random ledgers, when
no chain links two people). Amounts are integer minor units of one currency (convert first to
merge currencies).
"""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import Decimal

from app.core.money import round_half_up


@dataclass(frozen=True)
class Debt:
    """What ``debtor`` still owes ``creditor`` on one bill.

    ``amount`` is in the plan currency; ``original`` in the bill's own (effective) currency,
    equal to ``amount`` unless the plan merges currencies."""

    bill_id: str
    debtor: str
    creditor: str
    amount: int
    original: int


@dataclass(frozen=True)
class Piece:
    """Part of one bill debt cleared by a payment, in the bill's own currency."""

    bill_id: str
    debtor: str
    amount: int


@dataclass(frozen=True)
class Payment:
    payer: str
    payee: str
    amount: int  # plan currency
    pieces: tuple[Piece, ...]  # every bill debt this payment clears (incl. loops riding along)


@dataclass(frozen=True)
class Plan:
    payments: tuple[Payment, ...]
    cancel_out: tuple[Piece, ...]  # loops with no payment in their group: clear them, no money moves
    debt_count: int  # distinct debtor → creditor pairs before simplifying


@dataclass
class _Open:
    debt: Debt
    amount: int
    original: int

    def take(self, amount: int) -> int:
        """Consume ``amount`` plan units; returns the original-currency part consumed."""
        if amount >= self.amount:
            used = self.original
        else:  # proportional, so a merged plan never needs to invert the rate
            used = min(self.original, round_half_up(Decimal(self.original) * amount / self.amount))
        self.amount -= amount
        self.original -= used
        return used


@dataclass
class _Draft:
    amount: int = 0
    pieces: dict[tuple[str, str], int] = field(default_factory=dict)

    def add(self, bill_id: str, debtor: str, amount: int) -> None:
        if amount:
            self.pieces[(bill_id, debtor)] = self.pieces.get((bill_id, debtor), 0) + amount


def _pieces(pieces: dict[tuple[str, str], int]) -> tuple[Piece, ...]:
    return tuple(Piece(bill_id=b, debtor=d, amount=a) for (b, d), a in pieces.items())


def simplify(debts: Sequence[Debt]) -> Plan:
    """Fewest-payments plan for one currency. Debts are cleared in the order given (pass the
    oldest bill first so old bills close before new ones)."""
    edges: dict[tuple[str, str], list[_Open]] = defaultdict(list)
    worthless: list[_Open] = []  # owed in the bill's currency but rounds to 0 in the plan's
    net: dict[str, int] = defaultdict(int)
    for d in debts:
        if d.original <= 0 or d.debtor == d.creditor:
            continue
        if d.amount <= 0:
            worthless.append(_Open(d, 0, d.original))
            continue
        edges[(d.debtor, d.creditor)].append(_Open(d, d.amount, d.original))
        net[d.debtor] -= d.amount
        net[d.creditor] += d.amount
    debt_count = len(edges.keys() | {(o.debt.debtor, o.debt.creditor) for o in worthless})

    cap = {e: sum(o.amount for o in opens) for e, opens in edges.items()}
    out: dict[str, list[str]] = defaultdict(list)
    for u, v in sorted(edges):
        out[u].append(v)

    owes = {p: -n for p, n in net.items() if n < 0}
    due = {p: n for p, n in net.items() if n > 0}
    drafts: dict[tuple[str, str], _Draft] = {}
    for debtor in sorted(owes, key=lambda p: (-owes[p], p)):
        while owes[debtor] > 0:
            # A chain always reaches a creditor: flow out of a net debtor has to end somewhere.
            options = []
            for c in sorted(c for c in _reachable(cap, out, debtor) if due.get(c, 0) > 0):
                chains = _chains(dict(cap), out, debtor, c, min(owes[debtor], due[c]))
                options.append((c, sum(f for _, f in chains), chains))
            # Like the classic greedy, each payment should zero someone out: the debtor (best fit:
            # the smallest creditor who can take it all), else a creditor (the biggest), else as
            # much as the chains allow.
            clears_debtor = [o for o in options if o[1] == owes[debtor]]
            clears_creditor = [o for o in options if o[1] == due[o[0]]]
            creditor, flow, chains = (min(clears_debtor, key=lambda o: due[o[0]]) if clears_debtor
                                      else max(clears_creditor, key=lambda o: due[o[0]]) if clears_creditor
                                      else max(options, key=lambda o: o[1]))
            draft = drafts.setdefault((debtor, creditor), _Draft())
            draft.amount += flow
            for chain, f in chains:
                for e in chain:
                    cap[e] -= f
                    left = f
                    for o in edges[e]:
                        if left == 0:
                            break
                        step = min(left, o.amount)
                        if step:
                            draft.add(o.debt.bill_id, o.debt.debtor, o.take(step))
                            left -= step
            owes[debtor] -= flow
            due[creditor] -= flow

    # Leftovers cancel out: every net is now zero, so within each connected group of people they
    # form a closed loop. A group's WHOLE loop rides along with one of its payments (so recording
    # any single payment moves nets by exactly that payment); a group with no payments at all
    # gets a standalone "cancels out".
    group = _groups(debts)
    loops: dict[str, list[_Open]] = defaultdict(list)
    for o in [o for opens in edges.values() for o in opens if o.original > 0] + worthless:
        loops[group[o.debt.debtor]].append(o)
    standalone = _Draft()
    for gid, opens in loops.items():
        people = {p for o in opens for p in (o.debt.debtor, o.debt.creditor)}
        candidates = sorted((k for k in drafts if group[k[0]] == gid), key=lambda k: (-drafts[k].amount, k))
        target = next((k for k in candidates if people & set(k)), candidates[0] if candidates else None)
        for o in opens:
            (drafts[target] if target else standalone).add(o.debt.bill_id, o.debt.debtor, o.take(o.amount))

    payments = sorted(
        (Payment(payer=p, payee=q, amount=d.amount, pieces=_pieces(d.pieces)) for (p, q), d in drafts.items()),
        key=lambda x: (-x.amount, x.payer, x.payee))
    return Plan(payments=tuple(payments), cancel_out=_pieces(standalone.pieces), debt_count=debt_count)


Edge = tuple[str, str]


def _reachable(cap: dict[Edge, int], out: dict[str, list[str]], start: str) -> dict[str, str]:
    """BFS over debts still open: node → previous node (shortest chains first)."""
    prev: dict[str, str] = {start: start}
    queue = deque([start])
    while queue:
        u = queue.popleft()
        for v in out[u]:
            if v not in prev and cap[(u, v)] > 0:
                prev[v] = u
                queue.append(v)
    return prev


def _chains(cap: dict[Edge, int], out: dict[str, list[str]], src: str, dst: str,
            limit: int) -> list[tuple[list[Edge], int]]:
    """Up to ``limit`` from src to dst over shortest debt chains, one after another
    (mutates ``cap``: pass a copy to just measure)."""
    found: list[tuple[list[Edge], int]] = []
    while limit > 0:
        prev = _reachable(cap, out, src)
        if dst not in prev:
            break
        chain: list[Edge] = []
        node = dst
        while node != src:
            chain.append((prev[node], node))
            node = prev[node]
        chain.reverse()
        f = min(limit, *(cap[e] for e in chain))
        for e in chain:
            cap[e] -= f
        found.append((chain, f))
        limit -= f
    return found


def _groups(debts: Sequence[Debt]) -> dict[str, str]:
    """Connected groups of people (union-find over debts, ignoring direction)."""
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for d in debts:
        a, b = find(d.debtor), find(d.creditor)
        if a != b:
            parent[max(a, b)] = min(a, b)
    return {p: find(p) for p in list(parent)}


def by_pair(debts: Sequence[Debt]) -> tuple[Payment, ...]:
    """The original debts, unsimplified: one payment per debtor → creditor pair, clearing every
    bill debt between them (oldest bill first, biggest pair first)."""
    drafts: dict[tuple[str, str], _Draft] = {}
    for d in debts:
        if d.original <= 0 or d.debtor == d.creditor:
            continue
        draft = drafts.setdefault((d.debtor, d.creditor), _Draft())
        draft.amount += d.amount
        draft.add(d.bill_id, d.debtor, d.original)
    return tuple(sorted((Payment(payer=p, payee=q, amount=x.amount, pieces=_pieces(x.pieces))
                         for (p, q), x in drafts.items()), key=lambda x: (-x.amount, x.payer, x.payee)))
