"""Accounts together: friends, the Mailbox, placeholder links, shared co-edited bills, settling
up across owners, groups, account requests, and share links for people with accounts."""

from __future__ import annotations

import uuid

from tests.conftest import AppUser, Ctx, token_for
from tests.test_bills import new_bill, person


async def _ask(ctx: Ctx, user: AppUser, identifier: str):  # noqa: ANN202
    return await ctx.client.post("/api/friends/requests", headers=user.headers, json={"identifier": identifier})


async def _mailbox(ctx: Ctx, user: AppUser) -> dict:
    r = await ctx.client.get("/api/mailbox", headers=user.headers)
    assert r.status_code == 200, r.text
    return r.json()


async def befriend(ctx: Ctx, a: AppUser, b: AppUser) -> str:
    """Friends via the API; returns a's person id for b."""
    assert (await _ask(ctx, a, b.username)).json() == {"status": "sent"}
    req = next(r for r in (await _mailbox(ctx, b))["requests"] if r["kind"] == "friend_request")
    r = await ctx.client.post(f"/api/friends/requests/{req['id']}/accept", headers=b.headers)
    assert r.status_code == 204, r.text
    people = (await ctx.client.get("/api/people", headers=a.headers)).json()["items"]
    return next(p["id"] for p in people if p["account_id"] == str(b.id))


async def shared_bill(ctx: Ctx, owner: AppUser, people: list[str], *, complete: bool = True) -> dict:
    """Owner's bill with two items, everyone on it, owner paid."""
    bill = await new_bill(ctx, owner, title="Dinner")
    url = f"/api/bills/{bill['id']}"
    r = await ctx.client.put(f"{url}/participants", headers=owner.headers,
                             json={"person_ids": [str(owner.self_person_id), *people]})
    assert r.status_code == 200, r.text
    r = await ctx.client.put(f"{url}/receipt", headers=owner.headers, json={
        "items": [{"name": "Noodles", "unit_price_cents": 1000, "total_price_cents": 1000},
                  {"name": "Rice", "unit_price_cents": 600, "total_price_cents": 600}],
        "grand_total_cents": 1600})
    assert r.status_code == 200, r.text
    out = r.json()
    everyone = [{"person_id": p} for p in [str(owner.self_person_id), *people]]
    r = await ctx.client.put(f"{url}/assignments", headers=owner.headers, json={"assignments": [
        {"item_id": i["id"], "mode": "equal", "shares": everyone} for i in out["items"]]})
    assert r.status_code == 200, r.text
    if complete:
        r = await ctx.client.patch(url, headers=owner.headers, json={"status": "complete"})
        assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------- friends
async def test_asking_answers_the_same_whoever_is_behind_it(ctx: Ctx) -> None:
    alice, bob, hidden = await ctx.user("alice"), await ctx.user("bob"), await ctx.user("hidden")
    await ctx.sql("UPDATE profiles SET discoverable = false WHERE username = 'hidden'")
    for ident in ("bob@test.local", "nobody@nowhere.example", "@hidden", "ghost"):
        r = await _ask(ctx, alice, ident)
        assert r.status_code == 202 and r.json() == {"status": "sent"}, (ident, r.text)
    assert [r["kind"] for r in (await _mailbox(ctx, bob))["requests"]] == ["friend_request"]
    assert (await _mailbox(ctx, hidden))["requests"] == []
    sent = (await ctx.client.get("/api/friends", headers=alice.headers)).json()["outgoing"]
    assert sorted(s["identifier"] for s in sent) == ["@hidden", "bob@test.local", "ghost", "nobody@nowhere.example"]
    assert (await _ask(ctx, alice, "alice")).json()["code"] == "cannot_add_self"


async def test_accept_lists_each_other_and_decline_waits_30_days(ctx: Ctx) -> None:
    alice, bob, cat = await ctx.user("alice"), await ctx.user("bob"), await ctx.user("cat")
    bob_for_alice = await befriend(ctx, alice, bob)
    alice_people = (await ctx.client.get("/api/people", headers=alice.headers)).json()["items"]
    assert next(p for p in alice_people if p["id"] == bob_for_alice)["username"] == "bob"
    bob_people = (await ctx.client.get("/api/people", headers=bob.headers)).json()["items"]
    assert any(p["account_id"] == str(alice.id) for p in bob_people)
    assert (await _mailbox(ctx, alice))["updates"][0]["kind"] == "friend_accepted"
    assert (await _ask(ctx, alice, "bob")).json()["code"] == "already_friends"

    await _ask(ctx, alice, "cat")
    req = (await _mailbox(ctx, cat))["requests"][0]
    assert (await ctx.client.post(f"/api/friends/requests/{req['id']}/decline", headers=cat.headers)).status_code == 204
    assert (await _mailbox(ctx, alice))["updates"][0]["kind"] == "friend_declined"
    r = await _ask(ctx, alice, "cat")
    assert r.status_code == 409 and r.json()["code"] == "request_cooldown"
    # Cat changing their mind is fine, and asking back accepts a waiting request.
    await _ask(ctx, cat, "alice")
    assert (await _ask(ctx, alice, "cat")).json() == {"status": "accepted"}


async def test_unfriend_and_block_keep_bills_but_stop_new_ones(ctx: Ctx) -> None:
    alice, bob = await ctx.user("alice"), await ctx.user("bob")
    bob_p = await befriend(ctx, alice, bob)
    bill = await shared_bill(ctx, alice, [bob_p])
    assert (await ctx.client.delete(f"/api/friends/{bob.id}", headers=alice.headers)).status_code == 204
    assert (await ctx.client.get(f"/api/bills/{bill['id']}", headers=bob.headers)).status_code == 200
    fresh = await new_bill(ctx, alice)
    r = await ctx.client.put(f"/api/bills/{fresh['id']}/participants", headers=alice.headers,
                             json={"person_ids": [str(alice.self_person_id), bob_p]})
    assert r.status_code == 400 and r.json()["code"] == "person_archived"

    assert (await ctx.client.post(f"/api/friends/{alice.id}/block", headers=bob.headers)).status_code == 204
    await _ask(ctx, alice, "bob")
    assert (await _mailbox(ctx, bob))["requests"] == []  # never arrives


# ---------------------------------------------------------------------------- shared bills
async def test_a_friend_on_the_bill_sees_it_and_edits_items_but_not_people(ctx: Ctx) -> None:
    alice, bob, eve = await ctx.user("alice"), await ctx.user("bob"), await ctx.user("eve")
    bob_p = await befriend(ctx, alice, bob)
    bill = await shared_bill(ctx, alice, [bob_p], complete=False)
    url = f"/api/bills/{bill['id']}"

    mine = (await ctx.client.get("/api/bills", headers=bob.headers)).json()["items"]
    assert [(b["id"], b["role"], b["owner_name"]) for b in mine] == [(bill["id"], "member", "Alice")]
    seen = (await ctx.client.get(url, headers=bob.headers)).json()
    assert seen["role"] == "member" and seen["my_person_id"] == bob_p and seen["shared"]
    assert [p["name"] for p in seen["participants"] if p["is_self"]] == ["Bob"]
    assert (await ctx.client.get(url, headers=eve.headers)).status_code == 404

    items = [{"id": i["id"], "name": i["name"], "unit_price_cents": i["unit_price_cents"],
              "total_price_cents": i["total_price_cents"]} for i in seen["items"]]
    items[1]["name"] = "Fried rice"
    r = await ctx.client.put(f"{url}/receipt", headers=bob.headers, json={"items": items, "grand_total_cents": 1600})
    assert r.status_code == 200 and r.json()["items"][1]["name"] == "Fried rice"
    r = await ctx.client.put(f"{url}/participants", headers=bob.headers, json={"person_ids": [bob_p]})
    assert r.status_code == 403 and r.json()["code"] == "owner_only"
    assert (await ctx.client.patch(url, headers=bob.headers, json={"title": "Mine"})).status_code == 403
    assert (await ctx.client.patch(url, headers=bob.headers, json={"status": "complete"})).status_code == 403
    assert (await ctx.client.delete(url, headers=bob.headers)).status_code == 404
    added = (await _mailbox(ctx, bob))["updates"]
    assert [(u["kind"], u["bill_id"]) for u in added] == [("bill_added", bill["id"])]


async def test_only_overlapping_stale_saves_are_refused(ctx: Ctx) -> None:
    alice, bob = await ctx.user("alice"), await ctx.user("bob")
    bob_p = await befriend(ctx, alice, bob)
    bill = await shared_bill(ctx, alice, [bob_p])
    url, base = f"/api/bills/{bill['id']}", bill["version"]
    noodles, rice = (i["id"] for i in bill["items"])

    def only(item: str, who: str) -> dict:
        return {"assignments": [{"item_id": item, "mode": "single", "shares": [{"person_id": who}]}]}

    # Both edit from the same version, different items: both land.
    r = await ctx.client.put(f"{url}/assignments", headers={**bob.headers, "X-Bill-Version": str(base)},
                             json=only(noodles, bob_p))
    assert r.status_code == 200, r.text
    me = str(alice.self_person_id)
    r = await ctx.client.put(f"{url}/assignments", headers={**alice.headers, "X-Bill-Version": str(base)},
                             json=only(rice, me))
    assert r.status_code == 200, r.text
    # Alice saving noodles from before Bob's change: refused, with who changed it.
    r = await ctx.client.put(f"{url}/assignments", headers={**alice.headers, "X-Bill-Version": str(base)},
                             json=only(noodles, me))
    assert r.status_code == 409 and r.json()["code"] == "bill_changed" and r.json()["by"] == "Bob"
    # Your own earlier saves never count against you (Bob's noodles), nor do others' elsewhere (Alice's rice).
    r = await ctx.client.put(f"{url}/assignments", headers={**bob.headers, "X-Bill-Version": str(base)},
                             json=only(noodles, me))
    assert r.status_code == 200, r.text
    # Re-applied on the latest version, Alice's change lands.
    r = await ctx.client.put(f"{url}/assignments", headers={**alice.headers, "X-Bill-Version": str(r.json()["version"])},
                             json=only(noodles, bob_p))
    assert r.status_code == 200

    # Edits to a finished bill leave one coalesced line in the others' Mailbox.
    edited = [u for u in (await _mailbox(ctx, alice))["updates"] if u["kind"] == "bill_edited"]
    assert len(edited) == 1 and edited[0]["actor"]["name"] == "Bob" and edited[0]["unread"]
    await ctx.client.post("/api/mailbox/read", headers=alice.headers, json={})
    assert (await _mailbox(ctx, alice))["unread_count"] == 0


async def test_live_returns_viewers_and_the_bill_when_behind(ctx: Ctx) -> None:
    alice, bob = await ctx.user("alice"), await ctx.user("bob")
    bob_p = await befriend(ctx, alice, bob)
    bill = await shared_bill(ctx, alice, [bob_p])
    url = f"/api/bills/{bill['id']}/live"
    await ctx.client.get(url, headers=bob.headers, params={"version": bill["version"]})
    r = await ctx.client.get(url, headers=alice.headers, params={"version": bill["version"]})
    assert r.status_code == 200 and r.json()["bill"] is None
    assert sorted((v["name"], v["is_self"]) for v in r.json()["viewers"]) == [("Alice", True), ("Bob", False)]
    r = await ctx.client.get(url, headers=alice.headers, params={"version": bill["version"] - 1})
    assert r.json()["bill"]["id"] == bill["id"]


# ---------------------------------------------------------------------------- placeholders
async def test_linking_a_placeholder_shares_its_bills_on_accept(ctx: Ctx) -> None:
    alice, jeff = await ctx.user("alice"), await ctx.user("jeff")
    placeholder = await person(ctx, alice, "Jeff (old)")
    bill = await shared_bill(ctx, alice, [placeholder])
    await befriend(ctx, alice, jeff)
    r = await ctx.client.post(f"/api/people/{placeholder}/link", headers=alice.headers,
                              json={"account_id": str(jeff.id)})
    assert r.status_code == 204, r.text
    assert (await ctx.client.get(f"/api/bills/{bill['id']}", headers=jeff.headers)).status_code == 404
    invite = next(r for r in (await _mailbox(ctx, jeff))["requests"] if r["kind"] == "link_invite")
    assert invite["person_name"] == "Jeff (old)" and invite["bill_count"] == 1
    assert (await ctx.client.post(f"/api/mailbox/links/{invite['id']}/accept", headers=jeff.headers)).status_code == 204

    seen = (await ctx.client.get(f"/api/bills/{bill['id']}", headers=jeff.headers)).json()
    assert seen["my_person_id"] == placeholder
    summary = (await ctx.client.get("/api/me/summary", headers=jeff.headers)).json()
    assert summary["home"]["i_owe_cents"] == 800
    people = (await ctx.client.get("/api/people", headers=alice.headers)).json()["items"]
    linked = [p for p in people if p["account_id"] == str(jeff.id)]
    assert [p["id"] for p in linked] == [placeholder]  # the unused twin made at befriending is gone
    assert (await _mailbox(ctx, alice))["updates"][0]["kind"] == "link_accepted"


async def test_tagging_needs_a_friend_and_decline_changes_nothing(ctx: Ctx) -> None:
    alice, jeff = await ctx.user("alice"), await ctx.user("jeff")
    placeholder = await person(ctx, alice, "J")
    r = await ctx.client.post(f"/api/people/{placeholder}/link", headers=alice.headers,
                              json={"account_id": str(jeff.id)})
    assert r.status_code == 400 and r.json()["code"] == "not_friends"
    await befriend(ctx, alice, jeff)
    await ctx.client.post(f"/api/people/{placeholder}/link", headers=alice.headers, json={"account_id": str(jeff.id)})
    invite = next(r for r in (await _mailbox(ctx, jeff))["requests"] if r["kind"] == "link_invite")
    await ctx.client.post(f"/api/mailbox/links/{invite['id']}/decline", headers=jeff.headers)
    people = (await ctx.client.get("/api/people", headers=alice.headers)).json()["items"]
    assert next(p for p in people if p["id"] == placeholder)["account_id"] is None
    assert (await _mailbox(ctx, alice))["updates"][0]["kind"] == "link_declined"


# ---------------------------------------------------------------------------- money across owners
async def test_member_paying_becomes_a_claim_and_owner_settles_directly(ctx: Ctx) -> None:
    alice, bob = await ctx.user("alice"), await ctx.user("bob")
    bob_p = await befriend(ctx, alice, bob)
    bill = await shared_bill(ctx, alice, [bob_p])  # Bob owes Alice 8.00

    plan = (await ctx.client.get("/api/me/settle-up", headers=bob.headers)).json()["groups"][0]
    row = plan["simplified"][0]
    assert (row["from_person"]["is_self"], row["to_person"]["name"], row["amount_cents"]) == (True, "Alice", 800)
    body = {"view": "simplified", "currency": "SGD", "from_person_id": row["from_person"]["person_id"],
            "to_person_id": row["to_person"]["person_id"], "amount_cents": 800}
    r = await ctx.client.post("/api/me/settle-up/payments", headers=bob.headers, json=body)
    assert r.status_code == 200, r.text
    assert [p["pending"] for p in r.json()["applied"]] == [True]
    claim = next(r for r in (await _mailbox(ctx, alice))["requests"] if r["kind"] == "payment_claim")
    assert claim["actor"]["username"] == "bob" and claim["amount_cents"] == 800
    r = await ctx.client.post(f"/api/bills/{bill['id']}/claims/{claim['id']}/confirm", headers=alice.headers)
    assert r.status_code == 200
    assert next(p for p in r.json()["split"]["people"] if p["person_id"] == bob_p)["outstanding_cents"] == 0
    assert (await _mailbox(ctx, bob))["updates"][0]["kind"] == "claim_confirmed"
    # A member can't mark anyone paid on a bill they don't own and aren't owed on.
    r = await ctx.client.delete(f"/api/bills/{bill['id']}/participants/{bob_p}/settlement", headers=bob.headers)
    assert r.status_code == 403


async def test_in_app_claim_from_a_member(ctx: Ctx) -> None:
    alice, bob = await ctx.user("alice"), await ctx.user("bob")
    bob_p = await befriend(ctx, alice, bob)
    bill = await shared_bill(ctx, alice, [bob_p])
    r = await ctx.client.post(f"/api/bills/{bill['id']}/claims/mine", headers=bob.headers,
                              json={"client_key": str(uuid.uuid4())})
    assert r.status_code == 200 and r.json()["claims"][0]["via"] == "app"
    r = await ctx.client.delete(f"/api/bills/{bill['id']}/claims/mine", headers=bob.headers)
    assert r.json()["claims"] == []


async def test_group_simplifies_accounts_and_lists_placeholders_apart(ctx: Ctx) -> None:
    alice, bob, cat = await ctx.user("alice"), await ctx.user("bob"), await ctx.user("cat")
    bob_p, cat_p = await befriend(ctx, alice, bob), await befriend(ctx, alice, cat)
    kim = await person(ctx, alice, "Kim")
    await shared_bill(ctx, alice, [bob_p, cat_p, kim])
    r = await ctx.client.post("/api/groups", headers=alice.headers,
                              json={"name": "Trip", "person_ids": [bob_p, cat_p, kim]})
    assert r.status_code == 201, r.text
    group = r.json()
    plan = (await ctx.client.get("/api/me/settle-up", headers=alice.headers,
                                 params={"group_id": group["id"]})).json()["groups"][0]
    assert sorted(p["from_person"]["name"] for p in plan["simplified"]) == ["Bob", "Cat"]
    assert [p["from_person"]["name"] for p in plan["separate"]] == ["Kim"]
    r = await ctx.client.post(f"/api/groups/{group['id']}/send-plan", headers=alice.headers, json={"currency": "SGD"})
    assert r.json() == {"sent_to": 2}
    sent = next(u for u in (await _mailbox(ctx, bob))["updates"] if u["kind"] == "plan_sent")
    assert sent["data"]["group"] == "Trip" and sent["data"]["rows"][0]["you_pay"]


# ---------------------------------------------------------------------------- access requests
async def test_unknown_google_sign_in_asks_and_admin_approves(ctx: Ctx) -> None:
    admin = await ctx.user("root", role="admin")
    stranger = uuid.uuid4()
    headers = {"Authorization": f"Bearer {token_for(stranger, email='Newbie@Gmail.com', user_metadata={'full_name': 'New Bie'})}"}
    assert (await ctx.client.get("/api/me", headers=headers)).json()["code"] == "not_provisioned"
    r = await ctx.client.post("/api/access-requests", headers=headers, json={"note": "Maya's friend"})
    assert r.status_code == 201 and r.json()["status"] == "pending" and r.json()["email"] == "newbie@gmail.com"
    pending = (await ctx.client.get("/api/admin/access-requests", headers=admin.headers)).json()["items"]
    assert [p["name"] for p in pending] == ["New Bie"]
    r = await ctx.client.post(f"/api/admin/access-requests/{pending[0]['id']}/approve", headers=admin.headers,
                              json={"username": "newbie"})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    me = (await ctx.client.get("/api/me", headers=headers)).json()
    assert me["username"] == "newbie" and not me["must_change_password"]
    assert (await ctx.client.get("/api/access-requests/mine", headers=headers)).json()["status"] == "approved"


# ---------------------------------------------------------------------------- share links
async def test_share_link_claim_for_an_account_needs_that_account(ctx: Ctx) -> None:
    alice, bob = await ctx.user("alice"), await ctx.user("bob")
    bob_p = await befriend(ctx, alice, bob)
    bill = await shared_bill(ctx, alice, [bob_p])
    link, = (await ctx.client.post(f"/api/bills/{bill['id']}/share-links/ensure", headers=alice.headers,
                                   json={"scopes": [{"person_id": bob_p}]})).json()["items"]
    url = f"/api/public/share/{link['token']}"
    view = (await ctx.client.get(url)).json()
    assert view["person"]["has_account"] and view["bill_id"] is None
    body = {"client_key": str(uuid.uuid4())}
    r = await ctx.client.post(f"{url}/claims", json=body)
    assert r.status_code == 403 and r.json()["code"] == "sign_in_required"
    assert (await ctx.client.post(f"{url}/claims", json=body, headers=alice.headers)).status_code == 403
    r = await ctx.client.post(f"{url}/claims", json=body, headers=bob.headers)
    assert r.status_code == 200 and r.json()["person"]["claim"]["status"] == "claimed"
    assert r.json()["bill_id"] == bill["id"] and r.json()["person"]["is_you"]


async def test_in_production_only_a_google_sign_in_can_ask(ctx: Ctx) -> None:
    from types import SimpleNamespace

    from app.errors import AppError
    from app.middleware.auth import SignedIn
    from app.schemas.social import AccessRequestIn
    from app.services import access as access_svc

    prod = SimpleNamespace(is_production=True)
    who = SignedIn(user_id=uuid.uuid4(), email="someone@gmail.com", name=None, provider="email")
    async with ctx.sm() as db:
        try:
            await access_svc.ask(db, prod, who, AccessRequestIn())  # type: ignore[arg-type]
        except AppError as exc:
            assert exc.code == "google_required"
        else:
            raise AssertionError("an email+password sign-in must not be able to ask")
        out = await access_svc.ask(db, prod, SignedIn(who.user_id, who.email, None, "google"), AccessRequestIn())  # type: ignore[arg-type]
        assert out.status == "pending"
