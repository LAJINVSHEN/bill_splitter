"""Sharing v2: derived links (one per scope), the public "I've paid" claim and the owner's confirm."""

from __future__ import annotations

import hashlib
import uuid

import pytest

from app.services import share as share_svc
from tests.conftest import AppUser, Ctx
from tests.test_bills import full_bill


async def _done_bill(ctx: Ctx, user: AppUser) -> tuple[dict, dict[str, str]]:
    bill, ids = await full_bill(ctx, user)
    r = await ctx.client.patch(f"/api/bills/{bill['id']}", headers=user.headers, json={"status": "complete"})
    assert r.status_code == 200, r.text
    return r.json(), ids


async def _ensure(ctx: Ctx, user: AppUser, bill_id: str, *person_ids: str | None) -> list[dict]:
    r = await ctx.client.post(f"/api/bills/{bill_id}/share-links/ensure", headers=user.headers,
                              json={"scopes": [{"person_id": p} for p in person_ids]})
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def _claim(ctx: Ctx, token: str, person_key: str | None = None, key: str | None = None):  # noqa: ANN202
    body = {"client_key": key or str(uuid.uuid4()), **({"person_key": person_key} if person_key else {})}
    return await ctx.client.post(f"/api/public/share/{token}/claims", json=body)


async def test_ensure_reuses_one_derived_link_per_scope(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await _done_bill(ctx, user)
    first = await _ensure(ctx, user, bill["id"], None, ids["B"])
    again = await _ensure(ctx, user, bill["id"], ids["B"], None, ids["B"])
    assert [x["token"] for x in again] == [first[1]["token"], first[0]["token"]]  # same links, deduped
    assert len(first[0]["token"]) == 22 and first[0]["path"] == f"/s/{first[0]['token']}"
    stored = {h for (h,) in await ctx.sql("SELECT token_hash FROM share_links WHERE token_kind = 'derived'")}
    assert stored == {hashlib.sha256(x["token"].encode()).hexdigest() for x in first}  # only hashes stored
    listed = (await ctx.client.get(f"/api/bills/{bill['id']}/share-links", headers=user.headers)).json()["items"]
    assert len(listed) == 2

    outsider = await ctx.user("mallory")
    r = await ctx.client.post(f"/api/bills/{bill['id']}/share-links/ensure", headers=outsider.headers,
                              json={"scopes": [{"person_id": None}]})
    assert r.status_code == 404


async def test_public_view_has_keys_host_and_no_ids(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await _done_bill(ctx, user)
    group, = await _ensure(ctx, user, bill["id"], None)
    r = await ctx.client.get(f"/api/public/share/{group['token']}")
    body = r.json()
    assert body["claims_open"] is True and body["host_name"] == "Alice" and body["payer_is_host"] is True
    assert len({p["key"] for p in body["people"]}) == 4 and all(p["claim"] is None for p in body["people"])
    flat = r.text
    assert all(v not in flat for v in ids.values()) and str(user.id) not in flat and "owner" not in flat


async def test_personal_claim_then_owner_confirms(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await _done_bill(ctx, user)
    link, = await _ensure(ctx, user, bill["id"], ids["B"])
    key = str(uuid.uuid4())
    r = await _claim(ctx, link["token"], key=key)
    assert r.status_code == 200, r.text
    me = r.json()["person"]
    assert me["claim"]["status"] == "claimed" and me["claim"]["amount_cents"] == 1276 and me["outstanding_cents"] == 1276
    # retried or tapped again: still one open claim
    assert (await _claim(ctx, link["token"], key=key)).status_code == 200
    assert (await _claim(ctx, link["token"])).status_code == 200
    assert (await ctx.sql("SELECT count(*) FROM payment_claims"))[0][0] == 1

    owner_bill = (await ctx.client.get(f"/api/bills/{bill['id']}", headers=user.headers)).json()
    assert [c["person_id"] for c in owner_bill["claims"]] == [ids["B"]] and owner_bill["currency_locked"] is True
    # nothing is settled until the owner confirms
    assert next(p for p in owner_bill["split"]["people"] if p["person_id"] == ids["B"])["outstanding_cents"] == 1276
    me_out = (await ctx.client.get("/api/me", headers=user.headers)).json()
    assert me_out["open_claims_count"] == 1
    inbox = (await ctx.client.get("/api/me/claims", headers=user.headers)).json()["items"]
    assert inbox[0]["person_name"] == "Friend B" and inbox[0]["bill_title"] == "Dinner"
    r = await ctx.client.patch(f"/api/bills/{bill['id']}", headers=user.headers, json={"currency": "MYR"})
    assert r.status_code == 409 and r.json()["code"] == "currency_locked"

    claim_id = owner_bill["claims"][0]["id"]
    r = await ctx.client.post(f"/api/bills/{bill['id']}/claims/{claim_id}/confirm", headers=user.headers)
    assert r.status_code == 200, r.text
    out = r.json()
    b = next(p for p in out["split"]["people"] if p["person_id"] == ids["B"])
    assert b["outstanding_cents"] == 0 and b["settled_amount_cents"] == 1276 and out["claims"] == []
    assert (await ctx.client.post(f"/api/bills/{bill['id']}/claims/{claim_id}/confirm",
                                  headers=user.headers)).status_code == 200  # idempotent
    pub = (await ctx.client.get(f"/api/public/share/{link['token']}")).json()["person"]
    assert pub["settled"] is True and pub["claim"]["status"] == "confirmed"
    r = await _claim(ctx, link["token"])
    assert r.status_code == 409 and r.json()["code"] == "nothing_owed"

    # Undo the settlement: the confirmed claim no longer stands
    await ctx.client.delete(f"/api/bills/{bill['id']}/participants/{ids['B']}/settlement", headers=user.headers)
    assert (await ctx.sql("SELECT status FROM payment_claims"))[0][0] == "reverted"


async def test_reject_then_claim_again_and_withdraw(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await _done_bill(ctx, user)
    link, = await _ensure(ctx, user, bill["id"], ids["C"])
    await _claim(ctx, link["token"])
    claim_id = (await ctx.client.get(f"/api/bills/{bill['id']}", headers=user.headers)).json()["claims"][0]["id"]
    r = await ctx.client.post(f"/api/bills/{bill['id']}/claims/{claim_id}/reject", headers=user.headers)
    assert r.status_code == 200 and r.json()["claims"] == []
    pub = (await ctx.client.get(f"/api/public/share/{link['token']}")).json()["person"]
    assert pub["claim"]["status"] == "rejected" and pub["outstanding_cents"] > 0
    r = await ctx.client.post(f"/api/bills/{bill['id']}/claims/{claim_id}/confirm", headers=user.headers)
    assert r.status_code == 409 and r.json()["code"] == "claim_closed"

    key = str(uuid.uuid4())
    assert (await _claim(ctx, link["token"], key=key)).json()["person"]["claim"]["status"] == "claimed"
    r = await ctx.client.delete(f"/api/public/share/{link['token']}/claims/{key}")
    assert r.status_code == 200 and r.json()["person"]["claim"]["status"] == "rejected"  # back to the last answer
    assert (await ctx.client.get(f"/api/bills/{bill['id']}", headers=user.headers)).json()["claims"] == []


async def test_group_link_claims_for_the_picked_person(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await _done_bill(ctx, user)
    group, = await _ensure(ctx, user, bill["id"], None)
    people = (await ctx.client.get(f"/api/public/share/{group['token']}")).json()["people"]
    d = next(p for p in people if p["name"] == "Friend D")
    payer = next(p for p in people if p["is_payer"])
    r = await _claim(ctx, group["token"], person_key=d["key"])
    assert r.status_code == 200
    assert next(p for p in r.json()["people"] if p["name"] == "Friend D")["claim"]["status"] == "claimed"
    claims = (await ctx.client.get(f"/api/bills/{bill['id']}", headers=user.headers)).json()["claims"]
    assert claims[0]["person_id"] == ids["D"] and claims[0]["via"] == "group_link"
    r = await _claim(ctx, group["token"], person_key="nope")
    assert r.status_code == 400 and r.json()["code"] == "unknown_person"
    r = await _claim(ctx, group["token"], person_key=payer["key"])
    assert r.status_code == 409 and r.json()["code"] == "is_payer"
    assert (await _claim(ctx, group["token"])).status_code == 400  # a group link needs a name


async def test_confirm_all_and_owner_mark_paid_supersedes(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await _done_bill(ctx, user)
    group, = await _ensure(ctx, user, bill["id"], None)
    people = (await ctx.client.get(f"/api/public/share/{group['token']}")).json()["people"]
    for name in ("Friend B", "Friend C", "Friend D"):
        await _claim(ctx, group["token"], person_key=next(p["key"] for p in people if p["name"] == name))
    # owner marks D paid directly: D's claim is superseded, not confirmed twice
    await ctx.client.post(f"/api/bills/{bill['id']}/participants/{ids['D']}/settlement", headers=user.headers)
    r = await ctx.client.post(f"/api/bills/{bill['id']}/claims/confirm-all", headers=user.headers)
    out = r.json()
    assert r.status_code == 200 and out["claims"] == [] and out["split"]["outstanding_total_cents"] == 0
    statuses = sorted(s for (s,) in await ctx.sql("SELECT status FROM payment_claims"))
    assert statuses == ["confirmed", "confirmed", "superseded"]
    # everyone's even: the link is read-only
    body = (await ctx.client.get(f"/api/public/share/{group['token']}")).json()
    assert body["claims_open"] is False


async def test_claims_closed_while_editing_and_link_closes_90_days_after_even(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)  # not finished yet
    link, = await _ensure(ctx, user, bill["id"], ids["B"])
    r = await _claim(ctx, link["token"])
    assert r.status_code == 409 and r.json()["code"] == "claims_closed"
    assert (await ctx.client.get(f"/api/public/share/{link['token']}")).json()["claims_open"] is False

    await ctx.client.patch(f"/api/bills/{bill['id']}", headers=user.headers, json={"status": "complete"})
    for p in ("B", "C", "D"):
        await ctx.client.post(f"/api/bills/{bill['id']}/participants/{ids[p]}/settlement", headers=user.headers)
    assert (await ctx.client.get(f"/api/public/share/{link['token']}")).status_code == 200
    await ctx.sql("UPDATE bill_participants SET settled_at = now() - interval '91 days' WHERE settled_at IS NOT NULL")
    assert (await ctx.client.get(f"/api/public/share/{link['token']}")).status_code == 404


async def test_reset_turns_the_old_link_off(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await _done_bill(ctx, user)
    old, = await _ensure(ctx, user, bill["id"], ids["B"])
    r = await ctx.client.post(f"/api/bills/{bill['id']}/share-links/{old['link_id']}/reset", headers=user.headers)
    new = r.json()
    assert r.status_code == 200 and new["token"] != old["token"] and new["person_id"] == ids["B"]
    assert (await ctx.client.get(f"/api/public/share/{old['token']}")).status_code == 404
    assert (await ctx.client.get(f"/api/public/share/{new['token']}")).status_code == 200
    assert (await _ensure(ctx, user, bill["id"], ids["B"]))[0]["token"] == new["token"]


async def test_daily_claim_cap_per_link(ctx: Ctx, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(share_svc, "CLAIMS_PER_LINK_PER_DAY", 1)
    user = await ctx.user()
    bill, ids = await _done_bill(ctx, user)
    link, = await _ensure(ctx, user, bill["id"], ids["B"])
    key = str(uuid.uuid4())
    await _claim(ctx, link["token"], key=key)
    await ctx.client.delete(f"/api/public/share/{link['token']}/claims/{key}")
    r = await _claim(ctx, link["token"])
    assert r.status_code == 429 and r.json()["code"] == "too_many_claims"


async def test_claim_routes_are_owner_only(ctx: Ctx) -> None:
    alice = await ctx.user("alice")
    mallory = await ctx.user("mallory")
    bill, ids = await _done_bill(ctx, alice)
    link, = await _ensure(ctx, alice, bill["id"], ids["B"])
    await _claim(ctx, link["token"])
    claim_id = (await ctx.client.get(f"/api/bills/{bill['id']}", headers=alice.headers)).json()["claims"][0]["id"]
    for path in (f"claims/{claim_id}/confirm", f"claims/{claim_id}/reject", "claims/confirm-all",
                 f"share-links/{link['link_id']}/reset"):
        r = await ctx.client.post(f"/api/bills/{bill['id']}/{path}", headers=mallory.headers)
        assert r.status_code == 404, (path, r.status_code)
    assert (await ctx.client.get("/api/me/claims", headers=mallory.headers)).json()["items"] == []
    assert (await ctx.client.get("/api/me", headers=mallory.headers)).json()["open_claims_count"] == 0
