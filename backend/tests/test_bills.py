"""People, bills, receipt, participants, assignments, quick split, settle-up, summary, isolation."""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from tests.conftest import Ctx, AppUser

RECEIPT = {
    "items": [
        {"name": "Laksa", "quantity": 2, "unit_price_cents": 850, "total_price_cents": 1700},
        {"name": "Char Kway Teow", "quantity": 1, "unit_price_cents": 980, "total_price_cents": 980},
        {"name": "Iced Lemon Tea", "quantity": 3, "unit_price_cents": 260, "total_price_cents": 780},
        {"name": "Fried Wanton", "quantity": 1, "unit_price_cents": 600, "total_price_cents": 600},
    ],
    "charges": [
        {"name": "Service Charge 10%", "amount_cents": 406},
        {"name": "GST 9%", "amount_cents": 402},
        {"name": "Member Discount", "amount_cents": -200},
    ],
    "subtotal_cents": 4060,
    "grand_total_cents": 4668,
}


async def person(ctx: Ctx, user: AppUser, name: str) -> str:
    r = await ctx.client.post("/api/people", headers=user.headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def new_bill(ctx: Ctx, user: AppUser, **body: Any) -> dict:
    r = await ctx.client.post("/api/bills", headers=user.headers, json=body or {"title": "Dinner"})
    assert r.status_code == 201, r.text
    return r.json()


async def full_bill(ctx: Ctx, user: AppUser) -> tuple[dict, dict[str, str]]:
    """Noodle-house bill with A (self), B, C, D assigned like the golden vector."""
    bill = await new_bill(ctx, user)
    ids = {"A": str(user.self_person_id)}
    for n in ("B", "C", "D"):
        ids[n] = await person(ctx, user, f"Friend {n}")
    bid = bill["id"]
    r = await ctx.client.put(f"/api/bills/{bid}/receipt", headers=user.headers, json=RECEIPT)
    assert r.status_code == 200, r.text
    items = [i["id"] for i in r.json()["items"]]
    r = await ctx.client.put(f"/api/bills/{bid}/participants", headers=user.headers,
                             json={"person_ids": [ids[n] for n in "ABCD"]})
    assert r.status_code == 200, r.text
    r = await ctx.client.put(f"/api/bills/{bid}/assignments", headers=user.headers, json={"assignments": [
        {"item_id": items[0], "mode": "equal", "shares": [{"person_id": ids["A"]}, {"person_id": ids["B"]}]},
        {"item_id": items[1], "mode": "single", "shares": [{"person_id": ids["C"]}]},
        {"item_id": items[2], "mode": "equal", "shares": [{"person_id": ids[n]} for n in "ABC"]},
        {"item_id": items[3], "mode": "single", "shares": [{"person_id": ids["D"]}]},
    ]})
    assert r.status_code == 200, r.text
    return r.json(), ids


# ------------------------------------------------------------------------- people
async def test_people_crud_and_archive(ctx: Ctx) -> None:
    user = await ctx.user()
    pid = await person(ctx, user, "  Bob   Tan ")
    people = (await ctx.client.get("/api/people", headers=user.headers)).json()["items"]
    assert [p["name"] for p in people] == ["Alice", "Bob Tan"]
    r = await ctx.client.patch(f"/api/people/{pid}", headers=user.headers, json={"name": "Bobby", "color_seed": 200})
    assert r.json()["name"] == "Bobby" and r.json()["color_seed"] == 200
    assert (await ctx.client.delete(f"/api/people/{pid}", headers=user.headers)).status_code == 204
    assert len((await ctx.client.get("/api/people", headers=user.headers)).json()["items"]) == 1
    archived = (await ctx.client.get("/api/people?include_archived=true", headers=user.headers)).json()["items"]
    assert any(p["archived_at"] for p in archived)
    r = await ctx.client.delete(f"/api/people/{user.self_person_id}", headers=user.headers)
    assert r.status_code == 409 and r.json()["code"] == "cannot_archive_self"


async def test_people_input_caps(ctx: Ctx) -> None:
    user = await ctx.user()
    r = await ctx.client.post("/api/people", headers=user.headers, json={"name": "x" * 61})
    assert r.status_code == 422 and r.json()["code"] == "validation_error"
    r = await ctx.client.post("/api/people", headers=user.headers, json={"name": ""})
    assert r.status_code == 422
    r = await ctx.client.post("/api/people", headers=user.headers, json={"name": "ok", "admin": True})
    assert r.status_code == 422  # unknown fields are rejected


# ------------------------------------------------------------------------- bills
@pytest.mark.parametrize("permanent", [False, True])
@pytest.mark.parametrize("bulk", [False, True])
async def test_bill_deletion_cancels_jobs_queues_photos_keeps_usage(ctx: Ctx, permanent: bool, bulk: bool) -> None:
    from app.services.maintenance import run_maintenance
    from tests.conftest import jpeg
    from tests.test_scans import scan, wait_status

    user, other = await ctx.user(), await ctx.user("other")
    bill = await new_bill(ctx, user)
    survivor = await new_bill(ctx, other)
    link = (await ctx.client.post(f"/api/bills/{bill['id']}/share-links", headers=user.headers)).json()
    ctx.ocr.delay = 5
    response = await scan(ctx, user, bill["id"], [jpeg()])
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]
    await wait_status(ctx, user, job_id, "ocr")
    await ctx.sql("INSERT INTO usage_events (user_id, job_id, kind, provider, pages, cost_micros, ok) "
                  "VALUES (:uid, :jid, 'llm', 'fake', 0, 42, true)", uid=user.id, jid=job_id)
    url = "/api/bills" if bulk else f"/api/bills/{bill['id']}"
    params = {"permanent": str(permanent).lower()}
    if bulk:
        params["confirmation"] = "DELETE ALL BILLS"
    for _ in range(2):
        response = await ctx.client.delete(url, headers=user.headers, params=params)
        assert response.status_code == 204, response.text
    assert not ctx.services.runner.is_running(uuid.UUID(job_id))
    assert await ctx.sql("SELECT status, pages_reserved, retryable FROM extraction_jobs WHERE id = :id",
                         id=job_id) == [("cancelled", 0, False)]
    assert await ctx.sql("SELECT sum(pages), sum(cost_micros) FROM usage_events WHERE user_id = :id",
                         id=user.id) == [(1, 42)]
    assert (await ctx.client.post(f"/api/jobs/{job_id}/retry", headers=user.headers)).status_code == 409
    assert (await ctx.client.get(f"/api/public/share/{link['token']}")).status_code == 404
    assert (await ctx.client.get(f"/api/bills/{survivor['id']}", headers=other.headers)).status_code == 200
    assert await ctx.sql("SELECT expires_at <= now(), deleted_at IS NULL FROM receipt_files WHERE bill_id = :id",
                         id=bill["id"]) == [(True, True)]
    if permanent:
        assert await ctx.sql("SELECT person_id FROM bill_participants WHERE bill_id = :id", id=bill["id"]) == []
        assert await ctx.sql("SELECT token_hash FROM share_links WHERE bill_id = :id", id=bill["id"]) == []
    result = await run_maintenance(ctx.services, ctx.sm)
    assert result.purged_files == 1 and result.purge_failures == 0
    assert await ctx.sql("SELECT deleted_at IS NOT NULL FROM receipt_files WHERE bill_id = :id",
                         id=bill["id"]) == [(True,)]


async def test_permanent_people_conflict_then_purge_associated_history(ctx: Ctx) -> None:
    user, other = await ctx.user(), await ctx.user("other")
    bill, ids = await full_bill(ctx, user)
    survivor = await new_bill(ctx, user, title="Keep me")
    foreign = await person(ctx, other, "Foreign")
    url = f"/api/people/{ids['B']}?permanent=true"
    before = (await ctx.client.get(f"/api/bills/{bill['id']}", headers=user.headers)).json()
    response = await ctx.client.delete(url, headers=user.headers)
    assert response.status_code == 409 and response.json()["code"] == "person_referenced"
    assert response.json()["bill_count"] == 1
    assert (await ctx.client.get(f"/api/bills/{bill['id']}", headers=user.headers)).json() == before
    await ctx.client.delete(f"/api/bills/{bill['id']}", headers=user.headers)
    assert (await ctx.client.delete(url, headers=user.headers)).status_code == 409
    assert (await ctx.client.delete(f"/api/people/{foreign}?permanent=true", headers=user.headers)).status_code == 204
    assert await ctx.sql("SELECT id FROM people WHERE id = :id", id=foreign)
    for _ in range(2):
        response = await ctx.client.delete("/api/bills", headers=user.headers, params={
            "permanent": "true", "person_id": ids["B"], "confirmation": "DELETE ASSOCIATED BILLS",
        })
        assert response.status_code == 204, response.text
    assert (await ctx.client.get(f"/api/bills/{survivor['id']}", headers=user.headers)).status_code == 200
    assert await ctx.sql("SELECT title, payer_person_id FROM bills WHERE id = :id", id=bill["id"]) == [(None, None)]
    for _ in range(2):
        assert (await ctx.client.delete(url, headers=user.headers)).status_code == 204
    assert await ctx.sql("SELECT id FROM people WHERE id = :id", id=ids["B"]) == []
    response = await ctx.client.delete(f"/api/people/{user.self_person_id}?permanent=true", headers=user.headers)
    assert response.status_code == 409 and response.json()["code"] == "cannot_delete_self"


async def test_clear_people_atomic_includes_archived_and_preserves_self(ctx: Ctx) -> None:
    user, other = await ctx.user(), await ctx.user("other")
    bill, ids = await full_bill(ctx, user)
    unused = await person(ctx, user, "Unused")
    foreign = await person(ctx, other, "Foreign")
    await ctx.client.delete(f"/api/people/{unused}", headers=user.headers)
    assert (await ctx.client.delete("/api/people?permanent=true", headers=user.headers)).status_code == 422
    params = {"permanent": "true", "confirmation": "DELETE ALL PEOPLE"}
    response = await ctx.client.delete("/api/people", headers=user.headers, params=params)
    assert response.status_code == 409 and response.json()["code"] == "person_referenced"
    assert await ctx.sql("SELECT id FROM people WHERE id = :id", id=unused)
    response = await ctx.client.delete(f"/api/bills/{bill['id']}?permanent=true", headers=user.headers)
    assert response.status_code == 204, response.text
    for _ in range(2):
        response = await ctx.client.delete("/api/people", headers=user.headers, params=params)
        assert response.status_code == 204, response.text
    people = (await ctx.client.get("/api/people?include_archived=true", headers=user.headers)).json()["items"]
    assert [p["id"] for p in people] == [str(user.self_person_id)]
    assert await ctx.sql("SELECT id FROM people WHERE id = :id", id=foreign)


async def test_clear_bills_all_pages_confirmation_and_isolation(ctx: Ctx) -> None:
    user, other = await ctx.user(), await ctx.user("other")
    bills = [await new_bill(ctx, user, title=f"Delete {index}") for index in range(23)]
    survivor = await new_bill(ctx, other)
    assert (await ctx.client.delete("/api/bills", headers=user.headers)).status_code == 422
    assert (await ctx.client.get("/api/bills", headers=user.headers)).json()["next_cursor"]
    for _ in range(2):
        response = await ctx.client.delete("/api/bills", headers=user.headers,
                                           params={"confirmation": "DELETE ALL BILLS"})
        assert response.status_code == 204, response.text
        assert (await ctx.client.get("/api/bills", headers=user.headers)).json()["items"] == []
    assert (await ctx.client.get(f"/api/bills/{survivor['id']}", headers=other.headers)).status_code == 200
    assert (await ctx.client.delete(f"/api/bills/{survivor['id']}", headers=user.headers)).status_code == 404
    assert (await ctx.client.delete(f"/api/bills/{bills[0]['id']}", headers=user.headers)).status_code == 204


async def test_create_bill_defaults_owner_as_participant_and_payer(ctx: Ctx) -> None:
    user = await ctx.user(currency="MYR")
    bill = await new_bill(ctx, user, title="Lunch")
    assert bill["currency"] == "MYR" and bill["status"] == "draft" and bill["source"] == "manual"
    assert [p["person_id"] for p in bill["participants"]] == [str(user.self_person_id)]
    assert bill["payer_person_id"] == str(user.self_person_id)
    assert bill["split"]["people"][0]["is_payer"] is True
    assert bill["validation"] is None


async def test_receipt_put_validates_and_split_matches_golden_vector(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)
    v = bill["validation"]
    assert v["ok"] and v["tax_scenario"] == "tax_exclusive" and v["final_subtotal_cents"] == 4060
    assert bill["tax_scenario"] == "tax_exclusive"
    assert [c["kind"] for c in bill["charges"]] == ["service", "tax", "discount"]
    assert [c["percent"] for c in bill["charges"]] == ["10", "9.9", "-4.93"]
    split = bill["split"]
    totals = {p["person_id"]: p["total_cents"] for p in split["people"]}
    assert totals == {ids["A"]: 1276, ids["B"]: 1276, ids["C"]: 1426, ids["D"]: 690}
    assert split["is_complete"] and split["grand_total_cents"] == 4668
    a = next(p for p in split["people"] if p["person_id"] == ids["A"])
    assert a["items_cents"] == 1110 and a["adjustment_cents"] == 166
    assert [i["share_cents"] for i in a["items"]] == [850, 260]
    assert a["outstanding_cents"] == 0  # A is the payer
    assert split["outstanding_total_cents"] == 1276 + 1426 + 690
    same = (await ctx.client.get(f"/api/bills/{bill['id']}/split", headers=user.headers)).json()
    assert same == split


async def test_receipt_validation_failure_still_saves(ctx: Ctx) -> None:
    user = await ctx.user()
    bill = await new_bill(ctx, user)
    body = {**RECEIPT, "grand_total_cents": 5000}
    r = await ctx.client.put(f"/api/bills/{bill['id']}/receipt", headers=user.headers, json=body)
    assert r.status_code == 200
    v = r.json()["validation"]
    assert not v["ok"] and v["errors"][0]["code"] == "grand_total_mismatch"
    assert v["message"].startswith("The subtotal plus taxes")
    assert r.json()["tax_scenario"] is None and len(r.json()["items"]) == 4


async def test_editing_items_keeps_assignments_of_kept_items(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)
    items = bill["items"]
    edited = {**RECEIPT, "items": [
        {"id": items[0]["id"], "name": "Laksa (L)", "quantity": "2", "unit_price_cents": 900, "total_price_cents": 1800},
        {"id": items[1]["id"], "name": items[1]["name"], "quantity": 1, "unit_price_cents": 980,
         "total_price_cents": 980},
        {"name": "New dessert", "quantity": 1, "unit_price_cents": 500, "total_price_cents": 500},
    ], "subtotal_cents": None, "charges": [], "grand_total_cents": 3280}
    r = await ctx.client.put(f"/api/bills/{bill['id']}/receipt", headers=user.headers, json=edited)
    assert r.status_code == 200, r.text
    out = r.json()
    assert [i["name"] for i in out["items"]] == ["Laksa (L)", "Char Kway Teow", "New dessert"]
    assert out["items"][0]["split_mode"] == "equal" and len(out["items"][0]["shares"]) == 2
    assert out["items"][2]["split_mode"] is None
    assert out["split"]["unassigned_item_ids"] == [out["items"][2]["id"]]
    assert not out["split"]["is_complete"]
    r = await ctx.client.put(f"/api/bills/{bill['id']}/receipt", headers=user.headers,
                             json={**edited, "items": [{**edited["items"][0], "id": str(uuid.uuid4())}]})
    assert r.status_code == 400 and r.json()["code"] == "unknown_item"


async def test_assignment_modes_weighted_and_custom(ctx: Ctx) -> None:
    user = await ctx.user()
    bill = await new_bill(ctx, user)
    b = await person(ctx, user, "B")
    a = str(user.self_person_id)
    bid = bill["id"]
    r = await ctx.client.put(f"/api/bills/{bid}/receipt", headers=user.headers, json={
        "items": [{"name": "Pizza", "unit_price_cents": 2500, "total_price_cents": 2500},
                  {"name": "Wine", "unit_price_cents": 3000, "total_price_cents": 3000}],
        "grand_total_cents": 5500})
    pizza, wine = (i["id"] for i in r.json()["items"])
    await ctx.client.put(f"/api/bills/{bid}/participants", headers=user.headers, json={"person_ids": [a, b]})
    r = await ctx.client.put(f"/api/bills/{bid}/assignments", headers=user.headers, json={"assignments": [
        {"item_id": pizza, "mode": "weighted", "shares": [{"person_id": a, "weight": "60"},
                                                          {"person_id": b, "weight": 40}]},
        {"item_id": wine, "mode": "custom", "shares": [{"person_id": a, "amount_cents": 1000},
                                                       {"person_id": b, "amount_cents": 1500}]},
    ]})
    assert r.status_code == 200, r.text
    split = r.json()["split"]
    assert [p["items_cents"] for p in split["people"]] == [2500, 2500]
    assert [i["code"] for i in split["issues"]] == ["custom_amounts_mismatch"]
    assert r.json()["items"][0]["shares"][0]["weight"] == "60"
    # Fix the custom amounts → complete.
    r = await ctx.client.put(f"/api/bills/{bid}/assignments", headers=user.headers, json={"assignments": [
        {"item_id": wine, "mode": "custom", "shares": [{"person_id": a, "amount_cents": 1000},
                                                       {"person_id": b, "amount_cents": 2000}]}]})
    assert r.json()["split"]["is_complete"]
    assert [p["total_cents"] for p in r.json()["split"]["people"]] == [2500, 3000]
    # Unassign.
    r = await ctx.client.put(f"/api/bills/{bid}/assignments", headers=user.headers,
                             json={"assignments": [{"item_id": wine, "mode": None}]})
    assert r.json()["split"]["unassigned_item_ids"] == [wine]


async def test_assignment_input_rules(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)
    item = bill["items"][0]["id"]
    url = f"/api/bills/{bill['id']}/assignments"
    bad_bodies = [
        {"item_id": item, "mode": "single", "shares": [{"person_id": ids["A"]}, {"person_id": ids["B"]}]},
        {"item_id": item, "mode": "weighted", "shares": [{"person_id": ids["A"]}]},
        {"item_id": item, "mode": "weighted", "shares": [{"person_id": ids["A"], "weight": 0}]},
        {"item_id": item, "mode": "custom", "shares": [{"person_id": ids["A"]}]},
        {"item_id": item, "mode": "equal", "shares": []},
        {"item_id": item, "mode": "equal", "shares": [{"person_id": ids["A"]}, {"person_id": ids["A"]}]},
        {"item_id": item, "mode": None, "shares": [{"person_id": ids["A"]}]},
    ]
    for body in bad_bodies:
        r = await ctx.client.put(url, headers=user.headers, json={"assignments": [body]})
        assert r.status_code == 422, body
    stranger = await person(ctx, user, "Not on bill")
    r = await ctx.client.put(url, headers=user.headers, json={"assignments": [
        {"item_id": item, "mode": "single", "shares": [{"person_id": stranger}]}]})
    assert r.status_code == 400 and r.json()["code"] == "not_a_participant"


async def test_removing_participant_unassigns_their_single_items(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)
    r = await ctx.client.put(f"/api/bills/{bill['id']}/participants", headers=user.headers,
                             json={"person_ids": [ids["A"], ids["B"], ids["C"]]})
    out = r.json()
    wanton = out["items"][3]
    assert wanton["split_mode"] is None and wanton["shares"] == []
    assert out["split"]["unassigned_item_ids"] == [wanton["id"]]
    tea = out["items"][2]
    assert tea["split_mode"] == "equal" and len(tea["shares"]) == 3


async def test_quick_split_equal_and_by_shares(ctx: Ctx) -> None:
    user = await ctx.user()
    bill = await new_bill(ctx, user, source="quick")
    b, c = await person(ctx, user, "B"), await person(ctx, user, "C")
    a = str(user.self_person_id)
    r = await ctx.client.put(f"/api/bills/{bill['id']}/quick", headers=user.headers, json={
        "total_cents": 10000, "participants": [{"person_id": a}, {"person_id": b}, {"person_id": c}],
        "title": "Taxi"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["source"] == "quick" and out["title"] == "Taxi" and len(out["items"]) == 1
    assert [p["total_cents"] for p in out["split"]["people"]] == [3334, 3333, 3333]
    r = await ctx.client.put(f"/api/bills/{bill['id']}/quick", headers=user.headers, json={
        "total_cents": 9000, "mode": "shares", "participants": [{"person_id": a, "weight": 2},
                                                                {"person_id": b, "weight": 1}]})
    out = r.json()
    assert [p["total_cents"] for p in out["split"]["people"]] == [6000, 3000]
    assert len(out["participants"]) == 2 and len(out["items"]) == 1
    r = await ctx.client.put(f"/api/bills/{bill['id']}/quick", headers=user.headers, json={
        "total_cents": 9000, "mode": "shares", "participants": [{"person_id": a}]})
    assert r.status_code == 422


async def test_patch_bill_fields_payer_and_status(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)
    url = f"/api/bills/{bill['id']}"
    r = await ctx.client.patch(url, headers=user.headers, json={"payer_person_id": ids["B"], "status": "complete",
                                                                "title": "Team dinner", "currency": "myr"})
    out = r.json()
    assert out["payer_person_id"] == ids["B"] and out["status"] == "complete" and out["currency"] == "MYR"
    assert next(p for p in out["split"]["people"] if p["person_id"] == ids["B"])["outstanding_cents"] == 0
    outsider = await person(ctx, user, "Outsider")
    r = await ctx.client.patch(url, headers=user.headers, json={"payer_person_id": outsider})
    assert r.status_code == 400 and r.json()["code"] == "payer_not_participant"
    r = await ctx.client.patch(url, headers=user.headers, json={"status": "scanning"})
    assert r.status_code == 422


async def test_list_bills_pagination_and_filter(ctx: Ctx) -> None:
    user = await ctx.user()
    created = [await new_bill(ctx, user, title=f"Bill {i}") for i in range(5)]
    await ctx.client.patch(f"/api/bills/{created[0]['id']}", headers=user.headers, json={"status": "complete"})
    page1 = (await ctx.client.get("/api/bills?limit=2", headers=user.headers)).json()
    assert [b["title"] for b in page1["items"]] == ["Bill 4", "Bill 3"] and page1["next_cursor"]
    page2 = (await ctx.client.get(f"/api/bills?limit=2&cursor={page1['next_cursor']}", headers=user.headers)).json()
    page3 = (await ctx.client.get(f"/api/bills?limit=2&cursor={page2['next_cursor']}", headers=user.headers)).json()
    assert [b["title"] for b in page2["items"] + page3["items"]] == ["Bill 2", "Bill 1", "Bill 0"]
    assert page3["next_cursor"] is None
    done = (await ctx.client.get("/api/bills?status=complete", headers=user.headers)).json()["items"]
    assert [b["title"] for b in done] == ["Bill 0"] and done[0]["participant_count"] == 1
    assert (await ctx.client.get("/api/bills?status=bogus", headers=user.headers)).status_code == 400
    assert (await ctx.client.get("/api/bills?cursor=garbage", headers=user.headers)).json()["code"] == "invalid_cursor"
    assert (await ctx.client.get("/api/bills?limit=1000", headers=user.headers)).status_code == 422


@pytest.mark.parametrize("settled", [True, False])
async def test_list_bills_settled_filter_sparse_pagination(ctx: Ctx, settled: bool) -> None:
    user = await ctx.user()
    friend = await person(ctx, user, "Bob")
    matches = {1, 4, 6}
    for index in range(9):
        bill = await new_bill(ctx, user, title=f"Bill {index}", source="quick")
        url = f"/api/bills/{bill['id']}"
        response = await ctx.client.put(f"{url}/quick", headers=user.headers, json={
            "total_cents": 1000, "participants": [
                {"person_id": str(user.self_person_id)}, {"person_id": friend},
            ],
        })
        assert response.status_code == 200, response.text
        await ctx.client.patch(url, headers=user.headers, json={"status": "complete"})
        if (index in matches) == settled:
            await ctx.client.post(f"{url}/participants/{friend}/settlement", headers=user.headers)
    await new_bill(ctx, user, title="Draft")
    query = {"limit": 2, "settled": str(settled).lower()}
    response = await ctx.client.get("/api/bills", headers=user.headers, params=query)
    assert response.status_code == 200, response.text
    page1 = response.json()
    assert [bill["title"] for bill in page1["items"]] == ["Bill 6", "Bill 4"]
    assert page1["next_cursor"] is not None
    page2 = (await ctx.client.get("/api/bills", headers=user.headers,
                                 params={**query, "cursor": page1["next_cursor"]})).json()
    assert [bill["title"] for bill in page2["items"]] == ["Bill 1"]
    assert page2["next_cursor"] is None
    empty = (await ctx.client.get("/api/bills", headers=user.headers,
                                 params={**query, "status": "draft,review"})).json()
    assert empty == {"items": [], "next_cursor": None}


@pytest.mark.parametrize("payment", [None, 0, 500, 2000])
async def test_list_bills_settled_filter_uses_outstanding_money(ctx: Ctx, payment: int | None) -> None:
    user = await ctx.user()
    friend = await person(ctx, user, "Bob")
    bill = await new_bill(ctx, user, source="quick")
    url = f"/api/bills/{bill['id']}"
    response = await ctx.client.put(f"{url}/quick", headers=user.headers, json={
        "total_cents": 3000, "mode": "shares", "participants": [
            {"person_id": str(user.self_person_id), "weight": 1},
            {"person_id": friend, "weight": 2},
        ],
    })
    assert response.status_code == 200, response.text
    await ctx.client.patch(url, headers=user.headers, json={"status": "complete"})
    if payment is not None:
        response = await ctx.client.post(f"{url}/participants/{friend}/settlement", headers=user.headers,
                                         json={"amount_cents": payment})
        assert response.status_code == 200, response.text
    for settled in (True, False):
        response = await ctx.client.get("/api/bills", headers=user.headers,
                                        params={"settled": str(settled).lower(), "status": "draft,complete"})
        assert response.status_code == 200, response.text
        expected = payment == 2000
        assert [row["id"] for row in response.json()["items"]] == ([bill["id"]] if settled == expected else [])
        assert response.json()["next_cursor"] is None
    assert (await ctx.client.get("/api/bills?settled=invalid", headers=user.headers)).status_code == 422
    assert (await ctx.client.get("/api/bills?settled=false&cursor=invalid", headers=user.headers)).status_code == 400


@pytest.mark.parametrize("paid_before", [False, True])
async def test_list_bills_zero_weight_is_even_with_or_without_payment(ctx: Ctx, paid_before: bool) -> None:
    user = await ctx.user()
    friend = await person(ctx, user, "Bob")
    bill = await new_bill(ctx, user, source="quick")
    url = f"/api/bills/{bill['id']}"
    body = {"total_cents": 3000, "mode": "shares", "participants": [
        {"person_id": str(user.self_person_id), "weight": 1}, {"person_id": friend, "weight": 1},
    ]}
    await ctx.client.put(f"{url}/quick", headers=user.headers, json=body)
    if paid_before:
        await ctx.client.post(f"{url}/participants/{friend}/settlement", headers=user.headers)
    body["participants"][1]["weight"] = 0
    response = await ctx.client.put(f"{url}/quick", headers=user.headers, json=body)
    assert response.status_code == 200, response.text
    friend_split = response.json()["split"]["people"][1]
    assert friend_split["outstanding_cents"] == 0
    assert bool(friend_split["settled_at"]) == paid_before
    await ctx.client.patch(url, headers=user.headers, json={"status": "complete"})
    even = (await ctx.client.get("/api/bills?settled=true", headers=user.headers)).json()
    assert [row["id"] for row in even["items"]] == [bill["id"]]
    assert even["items"][0]["unsettled_count"] == 0
    assert (await ctx.client.get("/api/bills?settled=false", headers=user.headers)).json()["items"] == []


async def test_list_bills_no_payer_uses_split_outstanding_and_owner_isolation(ctx: Ctx) -> None:
    user = await ctx.user()
    outsider = await ctx.user("mallory")
    friend = await person(ctx, user, "Bob")
    bill = await new_bill(ctx, user, source="quick")
    url = f"/api/bills/{bill['id']}"
    await ctx.client.put(f"{url}/quick", headers=user.headers, json={
        "total_cents": 1000, "participants": [{"person_id": friend}],
    })
    response = await ctx.client.patch(url, headers=user.headers,
                                      json={"status": "complete", "payer_person_id": None})
    assert response.status_code == 200, response.text
    assert response.json()["split"]["payer_person_id"] is None
    assert response.json()["split"]["outstanding_total_cents"] == 1000
    open_bills = (await ctx.client.get("/api/bills?settled=false", headers=user.headers)).json()["items"]
    assert [row["id"] for row in open_bills] == [bill["id"]]
    assert open_bills[0]["unsettled_count"] == 1 and open_bills[0]["participant_names"] == ["Bob"]
    for settled in ("true", "false"):
        assert (await ctx.client.get(f"/api/bills?settled={settled}", headers=outsider.headers)).json()["items"] == []


async def test_list_bills_progress_and_names_match_shared_detail(ctx: Ctx) -> None:
    user = await ctx.user()
    draft = await new_bill(ctx, user)
    listed = (await ctx.client.get("/api/bills", headers=user.headers)).json()["items"][0]
    assert listed["id"] == draft["id"] and listed["participant_names"] == ["You"]
    assert listed["unassigned_item_count"] == listed["price_issue_count"] == listed["validation_issue_count"] == 0
    bill, ids = await full_bill(ctx, user)
    url = f"/api/bills/{bill['id']}"
    body = {**RECEIPT, "grand_total_cents": 5000, "items": [
        {**item, "id": stored["id"]} for item, stored in zip(RECEIPT["items"], bill["items"], strict=True)
    ]}
    body["items"][0]["quantity"] = 3
    response = await ctx.client.put(f"{url}/receipt", headers=user.headers, json=body)
    assert response.status_code == 200, response.text
    response = await ctx.client.put(f"{url}/assignments", headers=user.headers, json={"assignments": [
        {"item_id": item["id"], "mode": None} for item in bill["items"][:2]
    ]})
    assert response.status_code == 200, response.text
    detail = response.json()
    listed = (await ctx.client.get("/api/bills", headers=user.headers)).json()["items"][0]
    assert listed["participant_names"] == ["You", "Friend B", "Friend C", "Friend D"]
    assert listed["participant_count"] == len(ids)
    assert listed["unassigned_item_count"] == len(detail["split"]["unassigned_item_ids"]) == 2
    assert listed["price_issue_count"] == len(detail["validation"]["warnings"]) == 1
    assert listed["validation_issue_count"] == len(detail["validation"]["errors"]) == 1


async def test_delete_bill_is_soft_and_revokes_share_links(ctx: Ctx) -> None:
    user = await ctx.user()
    bill = await new_bill(ctx, user)
    link = (await ctx.client.post(f"/api/bills/{bill['id']}/share-links", headers=user.headers)).json()
    assert (await ctx.client.delete(f"/api/bills/{bill['id']}", headers=user.headers)).status_code == 204
    assert (await ctx.client.get(f"/api/bills/{bill['id']}", headers=user.headers)).status_code == 404
    assert (await ctx.client.get(f"/api/public/share/{link['token']}")).status_code == 404
    rows = await ctx.sql("SELECT deleted_at IS NOT NULL FROM bills WHERE id = :id", id=bill["id"])
    assert rows == [(True,)]


async def test_receipt_input_caps(ctx: Ctx) -> None:
    user = await ctx.user()
    bill = await new_bill(ctx, user)
    url = f"/api/bills/{bill['id']}/receipt"
    one = {"name": "x", "unit_price_cents": 1, "total_price_cents": 1}
    r = await ctx.client.put(url, headers=user.headers, json={"items": [one] * 201, "grand_total_cents": 201})
    assert r.status_code == 422
    r = await ctx.client.put(url, headers=user.headers, json={"items": [one], "grand_total_cents": -1})
    assert r.status_code == 422
    r = await ctx.client.put(url, headers=user.headers,
                             json={"items": [{**one, "total_price_cents": 10**12}], "grand_total_cents": 1})
    assert r.status_code == 422
    r = await ctx.client.put(url, headers=user.headers,
                             json={"items": [{**one, "quantity": "1.23456"}], "grand_total_cents": 1})
    assert r.status_code == 422
    r = await ctx.client.post("/api/bills", headers=user.headers, json={"currency": "DOLLARS"})
    assert r.status_code == 422


# ------------------------------------------------------------------------- settle-up & summary
async def test_settle_and_unsettle(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)
    base = f"/api/bills/{bill['id']}/participants"
    r = await ctx.client.post(f"{base}/{ids['B']}/settlement", headers=user.headers)
    assert r.status_code == 200, r.text
    b = next(p for p in r.json()["split"]["people"] if p["person_id"] == ids["B"])
    assert b["settled_amount_cents"] == 1276 and b["outstanding_cents"] == 0 and b["settled_at"]
    again = await ctx.client.post(f"{base}/{ids['B']}/settlement", headers=user.headers)
    b2 = next(p for p in again.json()["split"]["people"] if p["person_id"] == ids["B"])
    assert b2["settled_at"] == b["settled_at"]  # idempotent: unchanged
    r = await ctx.client.post(f"{base}/{ids['C']}/settlement", headers=user.headers, json={"amount_cents": 1000})
    c = next(p for p in r.json()["split"]["people"] if p["person_id"] == ids["C"])
    assert c["outstanding_cents"] == 426  # partial payment
    r = await ctx.client.post(f"{base}/{ids['A']}/settlement", headers=user.headers)
    assert r.status_code == 409 and r.json()["code"] == "is_payer"
    r = await ctx.client.delete(f"{base}/{ids['B']}/settlement", headers=user.headers)
    b3 = next(p for p in r.json()["split"]["people"] if p["person_id"] == ids["B"])
    assert b3["settled_at"] is None and b3["outstanding_cents"] == 1276
    stranger = await person(ctx, user, "Nobody")
    assert (await ctx.client.post(f"{base}/{stranger}/settlement", headers=user.headers)).status_code == 404


async def test_partial_payment_stays_in_home_and_bill_list(ctx: Ctx) -> None:
    user = await ctx.user()
    friend = await person(ctx, user, "Bob")
    bill = await new_bill(ctx, user, source="quick", currency="SGD")
    url = f"/api/bills/{bill['id']}"
    response = await ctx.client.put(f"{url}/quick", headers=user.headers, json={
        "total_cents": 3000, "mode": "shares", "participants": [
            {"person_id": str(user.self_person_id), "weight": "1"},
            {"person_id": friend, "weight": "2"},
        ],
    })
    assert response.status_code == 200, response.text
    await ctx.client.patch(url, headers=user.headers, json={"status": "complete"})
    await ctx.client.post(f"{url}/participants/{friend}/settlement", headers=user.headers,
                          json={"amount_cents": 500})
    summary = (await ctx.client.get("/api/me/summary", headers=user.headers)).json()
    assert summary["home"]["owed_to_me_cents"] == 1500
    assert summary["bills"][0]["bill_id"] == bill["id"]
    assert summary["bills"][0]["unsettled_people"] == 1
    listed = (await ctx.client.get("/api/bills", headers=user.headers)).json()["items"]
    assert listed[0]["unsettled_count"] == 1
    await ctx.client.post(f"{url}/participants/{friend}/settlement", headers=user.headers)
    assert (await ctx.client.get("/api/me/summary", headers=user.headers)).json()["home"]["owed_to_me_cents"] == 0
    assert (await ctx.client.get("/api/bills", headers=user.headers)).json()["items"][0]["unsettled_count"] == 0
    await ctx.client.put(f"{url}/quick", headers=user.headers, json={
        "total_cents": 4500, "mode": "shares", "participants": [
            {"person_id": str(user.self_person_id), "weight": "1"},
            {"person_id": friend, "weight": "2"},
        ],
    })
    assert (await ctx.client.get("/api/me/summary", headers=user.headers)).json()["home"]["owed_to_me_cents"] == 1000
    assert (await ctx.client.get("/api/bills", headers=user.headers)).json()["items"][0]["unsettled_count"] == 1


async def test_summary_owed_and_owing(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)
    # Not complete yet → not counted.
    assert (await ctx.client.get("/api/me/summary", headers=user.headers)).json()["currencies"] == []
    await ctx.client.patch(f"/api/bills/{bill['id']}", headers=user.headers, json={"status": "complete"})
    await ctx.client.post(f"/api/bills/{bill['id']}/participants/{ids['D']}/settlement", headers=user.headers)
    # Second bill in MYR paid by B: I owe B.
    b2 = await new_bill(ctx, user, title="Brunch", currency="MYR")
    await ctx.client.put(f"/api/bills/{b2['id']}/participants", headers=user.headers,
                         json={"person_ids": [ids["A"], ids["B"]]})
    await ctx.client.put(f"/api/bills/{b2['id']}/quick", headers=user.headers, json={
        "total_cents": 5000, "participants": [{"person_id": ids["A"]}, {"person_id": ids["B"]}]})
    await ctx.client.patch(f"/api/bills/{b2['id']}", headers=user.headers,
                           json={"payer_person_id": ids["B"], "status": "complete"})
    s = (await ctx.client.get("/api/me/summary", headers=user.headers)).json()
    assert s["currencies"] == [
        {"currency": "MYR", "owed_to_me_cents": 0, "i_owe_cents": 2500},
        {"currency": "SGD", "owed_to_me_cents": 1276 + 1426, "i_owe_cents": 0},
    ]
    by_person = {(p["person_id"], p["currency"]): p for p in s["people"]}
    assert by_person[(ids["B"], "SGD")]["they_owe_me_cents"] == 1276
    assert by_person[(ids["B"], "MYR")]["i_owe_them_cents"] == 2500
    assert (ids["D"], "SGD") not in by_person
    assert {b["bill_id"] for b in s["bills"]} == {bill["id"], b2["id"]}


# ------------------------------------------------------------------------- isolation
async def test_owner_isolation_everywhere(ctx: Ctx) -> None:
    alice = await ctx.user("alice")
    mallory = await ctx.user("mallory")
    bill, ids = await full_bill(ctx, alice)
    bid, item = bill["id"], bill["items"][0]["id"]
    m = mallory.headers
    attempts = [
        ("GET", f"/api/bills/{bid}", None),
        ("PATCH", f"/api/bills/{bid}", {"title": "pwned"}),
        ("DELETE", f"/api/bills/{bid}", None),
        ("PUT", f"/api/bills/{bid}/receipt", RECEIPT),
        ("PUT", f"/api/bills/{bid}/participants", {"person_ids": []}),
        ("PUT", f"/api/bills/{bid}/assignments", {"assignments": [{"item_id": item, "mode": None}]}),
        ("PUT", f"/api/bills/{bid}/quick", {"total_cents": 1, "participants": [{"person_id": ids["B"]}]}),
        ("GET", f"/api/bills/{bid}/split", None),
        ("POST", f"/api/bills/{bid}/participants/{ids['B']}/settlement", None),
        ("DELETE", f"/api/bills/{bid}/participants/{ids['B']}/settlement", None),
        ("POST", f"/api/bills/{bid}/share-links", None),
        ("GET", f"/api/bills/{bid}/share-links", None),
        ("DELETE", f"/api/bills/{bid}/share-links", None),
        ("GET", f"/api/bills/{bid}/files/{uuid.uuid4()}", None),
        ("PATCH", f"/api/people/{ids['B']}", {"name": "pwned"}),
        ("DELETE", f"/api/people/{ids['B']}", None),
    ]
    for method, url, body in attempts:
        r = await ctx.client.request(method, url, headers=m, json=body)
        assert r.status_code == 404, (method, url, r.status_code, r.text)
    # Mallory can't put Alice's people on her own bill either.
    own = await new_bill(ctx, mallory)
    r = await ctx.client.put(f"/api/bills/{own['id']}/participants", headers=m, json={"person_ids": [ids["B"]]})
    assert r.status_code == 400 and r.json()["code"] == "unknown_person"
    assert (await ctx.client.get("/api/bills", headers=m)).json()["items"][0]["id"] == own["id"]
    assert len((await ctx.client.get("/api/bills", headers=m)).json()["items"]) == 1
    people = (await ctx.client.get("/api/people", headers=m)).json()["items"]
    assert [p["name"] for p in people] == ["Mallory"]
    # Alice's bill is untouched.
    assert (await ctx.client.get(f"/api/bills/{bid}", headers=alice.headers)).json()["title"] == "Dinner"


async def test_deleting_a_profile_cascades_but_people_on_bills_are_protected(ctx: Ctx) -> None:
    import pytest
    from sqlalchemy.exc import IntegrityError

    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)
    await ctx.client.post(f"/api/bills/{bill['id']}/share-links", headers=user.headers)
    with pytest.raises(IntegrityError):
        await ctx.sql("DELETE FROM people WHERE id = :id", id=ids["B"])
    await ctx.sql("DELETE FROM profiles WHERE id = :id", id=str(user.id))
    for table in ("bills", "people", "bill_participants", "bill_items", "share_links"):
        assert (await ctx.sql(f"SELECT count(*) FROM {table}"))[0][0] == 0, table
