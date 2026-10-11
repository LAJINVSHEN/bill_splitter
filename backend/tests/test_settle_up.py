"""Settle up across bills: original vs simplified, recording a row, merging currencies."""

from __future__ import annotations

from tests.conftest import AppUser, Ctx
from tests.test_bills import new_bill, person


async def _bill(ctx: Ctx, user: AppUser, payer: str, people: list[str], total: int, currency: str = "SGD") -> str:
    """A complete quick split, equal shares, paid by ``payer``."""
    bill = await new_bill(ctx, user, title="Bill", currency=currency)
    url = f"/api/bills/{bill['id']}"
    r = await ctx.client.put(f"{url}/quick", headers=user.headers,
                             json={"total_cents": total, "participants": [{"person_id": p} for p in people]})
    assert r.status_code == 200, r.text
    r = await ctx.client.patch(url, headers=user.headers, json={"payer_person_id": payer, "status": "complete"})
    assert r.status_code == 200, r.text
    return bill["id"]


def _rows(rows: list[dict]) -> list[tuple[str, str, int]]:
    return [(r["from_person"]["name"], r["to_person"]["name"], r["amount_cents"]) for r in rows]


async def test_chain_simplifies_and_recording_closes_both_bills(ctx: Ctx) -> None:
    user = await ctx.user()
    me, bob, cat = str(user.self_person_id), await person(ctx, user, "Bob"), await person(ctx, user, "Cat")
    b1 = await _bill(ctx, user, me, [me, bob], 1000)  # Bob owes me 5.00
    b2 = await _bill(ctx, user, bob, [bob, cat], 1000)  # Cat owes Bob 5.00

    r = await ctx.client.get("/api/me/settle-up", headers=user.headers)
    assert r.status_code == 200, r.text
    group, = r.json()["groups"]
    assert group["currency"] == "SGD"
    assert sorted(_rows(group["original"])) == [("Bob", "Alice", 500), ("Cat", "Bob", 500)]
    assert _rows(group["simplified"]) == [("Cat", "Alice", 500)] and group["simplified"][0]["bill_count"] == 2
    assert [(d["bill_id"], d["from_person"]["name"], d["to_person"]["name"], d["amount_cents"]) for d in group["debts"]] == [
        (b2, "Cat", "Bob", 500), (b1, "Bob", "Alice", 500)]  # newest bill first

    stale = {"view": "simplified", "currency": "SGD", "from_person_id": cat, "to_person_id": me, "amount_cents": 400}
    r = await ctx.client.post("/api/me/settle-up/payments", headers=user.headers, json=stale)
    assert r.status_code == 409 and r.json()["code"] == "plan_changed"

    r = await ctx.client.post("/api/me/settle-up/payments", headers=user.headers, json={**stale, "amount_cents": 500})
    assert r.status_code == 200, r.text
    assert r.json()["groups"] == []
    for bid, debtor in ((b1, bob), (b2, cat)):
        people = (await ctx.client.get(f"/api/bills/{bid}", headers=user.headers)).json()["split"]["people"]
        assert next(p for p in people if p["person_id"] == debtor)["outstanding_cents"] == 0


async def test_paid_toggles_back_exactly(ctx: Ctx) -> None:
    user = await ctx.user()
    me, bob, cat = str(user.self_person_id), await person(ctx, user, "Bob"), await person(ctx, user, "Cat")
    b1 = await _bill(ctx, user, me, [me, bob], 1000)  # Bob owes me 5.00
    await ctx.client.post(f"/api/bills/{b1}/participants/{bob}/settlement", headers=user.headers,
                          json={"amount_cents": 100})  # he'd already paid 1.00 of it
    await _bill(ctx, user, bob, [bob, cat], 1000)  # Cat owes Bob 5.00
    before = (await ctx.client.get("/api/me/settle-up", headers=user.headers)).json()

    r = await ctx.client.post("/api/me/settle-up/payments", headers=user.headers, json={
        "view": "simplified", "currency": "SGD", "from_person_id": cat, "to_person_id": me, "amount_cents": 400})
    assert r.status_code == 200, r.text
    applied = r.json()["applied"]
    assert sorted((p["person_id"], p["amount_cents"]) for p in applied) == sorted([(bob, 400), (cat, 400)])

    r = await ctx.client.post("/api/me/settle-up/undo", headers=user.headers, json={"pieces": applied})
    assert r.status_code == 200, r.text
    assert r.json()["groups"] == before["groups"]
    split = (await ctx.client.get(f"/api/bills/{b1}", headers=user.headers)).json()["split"]["people"]
    bobs = next(p for p in split if p["person_id"] == bob)
    assert bobs["settled_amount_cents"] == 100 and bobs["outstanding_cents"] == 400  # his own 1.00 stays

    r = await ctx.client.post("/api/me/settle-up/undo", headers=user.headers, json={"pieces": applied})
    assert r.status_code == 409 and r.json()["code"] == "plan_changed"  # can't take back twice


async def test_original_row_settles_only_that_pair(ctx: Ctx) -> None:
    user = await ctx.user()
    me, bob = str(user.self_person_id), await person(ctx, user, "Bob")
    await _bill(ctx, user, me, [me, bob], 1000)  # Bob owes me 5.00
    await _bill(ctx, user, bob, [me, bob], 600)  # I owe Bob 3.00
    group, = (await ctx.client.get("/api/me/settle-up", headers=user.headers)).json()["groups"]
    assert _rows(group["simplified"]) == [("Bob", "Alice", 200)]  # the 3.00 loop rides along
    r = await ctx.client.post("/api/me/settle-up/payments", headers=user.headers, json={
        "view": "original", "currency": "SGD", "from_person_id": me, "to_person_id": bob, "amount_cents": 300})
    assert r.status_code == 200, r.text
    group, = r.json()["groups"]
    assert _rows(group["original"]) == [("Bob", "Alice", 500)] == _rows(group["simplified"])


async def test_loop_cancels_out_without_money(ctx: Ctx) -> None:
    user = await ctx.user()
    me, bob = str(user.self_person_id), await person(ctx, user, "Bob")
    await _bill(ctx, user, me, [me, bob], 1000)
    await _bill(ctx, user, bob, [me, bob], 1000)
    group, = (await ctx.client.get("/api/me/settle-up", headers=user.headers)).json()["groups"]
    assert group["simplified"] == [] and [p["name"] for p in group["cancel_out"]] == ["Alice", "Bob"]
    r = await ctx.client.post("/api/me/settle-up/payments", headers=user.headers,
                              json={"view": "cancel_out", "currency": "SGD"})
    assert r.status_code == 200 and r.json()["groups"] == []


async def test_currencies_stay_apart_until_merged_with_a_saved_rate(ctx: Ctx) -> None:
    user = await ctx.user()
    me, bob = str(user.self_person_id), await person(ctx, user, "Bob")
    await _bill(ctx, user, me, [me, bob], 2000)  # Bob owes me SGD 10.00
    myr = await _bill(ctx, user, bob, [me, bob], 2000, currency="MYR")  # I owe Bob MYR 10.00

    body = (await ctx.client.get("/api/me/settle-up", headers=user.headers)).json()
    assert body["currencies"] == ["MYR", "SGD"] and body["combined_into"] is None
    assert [(g["currency"], _rows(g["simplified"])) for g in body["groups"]] == [
        ("MYR", [("Alice", "Bob", 1000)]), ("SGD", [("Bob", "Alice", 1000)])]

    body = (await ctx.client.get("/api/me/settle-up?combine=sgd", headers=user.headers)).json()
    assert body["missing_rates"] == ["MYR"] and body["combined_into"] is None and len(body["groups"]) == 2

    await ctx.client.put("/api/me/fx-rates/MYR/SGD", headers=user.headers, json={"rate": "0.3"})
    body = (await ctx.client.get("/api/me/settle-up?combine=SGD", headers=user.headers)).json()
    assert body["combined_into"] == "SGD" and body["missing_rates"] == []
    group, = body["groups"]
    assert _rows(group["simplified"]) == [("Bob", "Alice", 700)]  # 10.00 − MYR 10.00 × 0.3
    mine = next(d for d in group["debts"] if d["currency"] == "MYR")
    assert (mine["amount_cents"], mine["original_cents"]) == (300, 1000)  # SGD in the plan, MYR on the bill

    r = await ctx.client.post("/api/me/settle-up/payments", headers=user.headers, json={
        "view": "simplified", "combine": "SGD", "currency": "SGD", "from_person_id": bob, "to_person_id": me,
        "amount_cents": 700})
    assert r.status_code == 200 and r.json()["groups"] == []
    people = (await ctx.client.get(f"/api/bills/{myr}", headers=user.headers)).json()["split"]["people"]
    mine = next(p for p in people if p["person_id"] == me)
    assert mine["outstanding_cents"] == 0 and mine["settled_amount_cents"] == 1000  # cleared in MYR


async def test_other_users_bills_never_show(ctx: Ctx) -> None:
    alice = await ctx.user()
    bob_id = await person(ctx, alice, "Bob")
    await _bill(ctx, alice, str(alice.self_person_id), [str(alice.self_person_id), bob_id], 1000)
    mallory = await ctx.user("mallory")
    assert (await ctx.client.get("/api/me/settle-up", headers=mallory.headers)).json()["groups"] == []
