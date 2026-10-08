"""Scan pipeline with fake OCR/LLM: success, needs_review, escalation, failures, cancel, retry from
cache, interrupted recovery, idempotency, quotas, file rules, signed URLs, isolation."""

from __future__ import annotations

import asyncio
import uuid
from decimal import Decimal
from typing import Any

import httpx

from app.integrations.azure_ocr import OcrError
from app.ratelimit import limiter, reset_all
from app.services.pipeline import recover_stale_jobs
from tests.conftest import BAD_EXTRACTION, PDF, PNG, AppUser, Ctx, jpeg, make_extraction


async def new_bill(ctx: Ctx, user: AppUser, title: str = "Dinner") -> str:
    r = await ctx.client.post("/api/bills", headers=user.headers, json={"title": title})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def scan(ctx: Ctx, user: AppUser, bill_id: str, files: list[bytes], key: str | None = None) -> httpx.Response:
    headers = dict(user.headers)
    if key:
        headers["Idempotency-Key"] = key
    multipart = [("files", (f"r{i}", data, "application/octet-stream")) for i, data in enumerate(files)]
    return await ctx.client.post(f"/api/bills/{bill_id}/scans", headers=headers, files=multipart)


async def job(ctx: Ctx, user: AppUser, job_id: str) -> dict[str, Any]:
    r = await ctx.client.get(f"/api/jobs/{job_id}", headers=user.headers)
    assert r.status_code == 200, r.text
    return r.json()


async def wait_status(ctx: Ctx, user: AppUser, job_id: str, *statuses: str, timeout: float = 3) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        j = await job(ctx, user, job_id)
        if j["status"] in statuses or asyncio.get_running_loop().time() > deadline:
            return j
        await asyncio.sleep(0.02)


async def usage_rows(ctx: Ctx) -> list[tuple]:
    return await ctx.sql("SELECT kind, model, pages, input_tokens, output_tokens, cost_micros, ok, error_code "
                         "FROM usage_events ORDER BY id")


# ------------------------------------------------------------------------- happy path
async def test_scan_success_applies_receipt_and_logs_usage(ctx: Ctx) -> None:
    user = await ctx.user()
    bill_id = await new_bill(ctx, user)
    r = await scan(ctx, user, bill_id, [jpeg()])
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "queued" and body["replayed"] is False
    await ctx.drain()

    j = await job(ctx, user, body["job_id"])
    assert j["status"] == "succeeded" and j["model_used"] == "primary-mini" and j["pages_billed"] == 1
    assert j["validation"]["ok"] and j["error_code"] is None
    assert {"ocr_ms", "llm_ms", "total_ms"} <= set(j["timings"])

    bill = (await ctx.client.get(f"/api/bills/{bill_id}", headers=user.headers)).json()
    assert bill["status"] == "review" and bill["source"] == "scan"
    assert bill["title"] == "Dinner" and bill["merchant"] == "Noodle House" and bill["bill_date"] == "2026-10-05"
    assert [i["name"] for i in bill["items"]] == ["Laksa", "Char Kway Teow", "Iced Lemon Tea"]
    assert bill["subtotal_cents"] == 3460 and bill["grand_total_cents"] == 4149
    assert bill["validation"]["ok"] and bill["tax_scenario"] == "tax_exclusive"
    assert bill["receipt_meta"]["receipt_number"] == "R-1"
    assert bill["latest_job"]["status"] == "succeeded"
    assert len(bill["files"]) == 1 and bill["files"][0]["available"] and bill["files"][0]["pages"] == 1

    assert await usage_rows(ctx) == [
        ("ocr", "prebuilt-layout", 1, 0, 0, 0, True, None),
        ("llm", "primary-mini", 0, 1000, 200, 1800, True, None),
    ]
    usage = (await ctx.client.get("/api/me/usage", headers=user.headers)).json()
    assert usage["pages_used"] == 1 and usage["pages_remaining"] == 29 and usage["llm_calls"] == 1
    assert usage["scans_paused"] is False


async def test_unpriced_component_lines_fold_into_their_item(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.llm.script = {"primary-mini": [make_extraction(
        [("Chicken", 1, 0.0, 0.0), ("Bundle", 1, 21.9, 21.9), ("Mashed Potatoes", 2, 0.0, 0.0),
         ("Upsize", 1, 0.6, 0.6), ("No Add Ons", 1, 0.0, 0.0)], subtotal=22.5, grand=22.5)]}
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    assert (await job(ctx, user, job_id))["status"] == "succeeded"
    bill = (await ctx.client.get(f"/api/bills/{bill_id}", headers=user.headers)).json()
    assert [(i["name"], i["details"], i["total_price_cents"]) for i in bill["items"]] == [
        ("Bundle", "Chicken, Mashed Potatoes ×2", 2190), ("Upsize", "No Add Ons", 60)]
    assert bill["validation"]["ok"] and bill["grand_total_cents"] == 2250

    # A Review save that doesn't send `details` keeps them; sending null clears them.
    items = [{k: i[k] for k in ("id", "name", "quantity", "unit_price_cents", "total_price_cents")}
             for i in bill["items"]]
    body = {"items": items, "charges": [], "subtotal_cents": 2250, "grand_total_cents": 2250}
    r = await ctx.client.put(f"/api/bills/{bill_id}/receipt", headers=user.headers, json=body)
    assert r.status_code == 200, r.text
    assert [i["details"] for i in r.json()["items"]] == ["Chicken, Mashed Potatoes ×2", "No Add Ons"]
    items[1]["details"] = None
    r = await ctx.client.put(f"/api/bills/{bill_id}/receipt", headers=user.headers, json=body)
    assert [i["details"] for i in r.json()["items"]] == ["Chicken, Mashed Potatoes ×2", None]


async def test_validation_failure_is_needs_review_not_an_error(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.llm.script = {"primary-mini": [BAD_EXTRACTION], "fallback-big": [BAD_EXTRACTION]}
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    j = await job(ctx, user, job_id)
    assert j["status"] == "needs_review" and j["error_code"] == "items_subtotal_mismatch"
    assert j["model_used"] == "fallback-big" and not j["validation"]["ok"]
    assert ctx.llm.calls == ["primary-mini", "fallback-big"]
    bill = (await ctx.client.get(f"/api/bills/{bill_id}", headers=user.headers)).json()
    assert bill["status"] == "review" and [i["name"] for i in bill["items"]] == ["Laksa", "Mystery"]
    assert not bill["validation"]["ok"]
    assert bill["validation"]["message"].startswith("The individual item prices")
    assert [r[0] for r in await usage_rows(ctx)] == ["ocr", "llm", "llm"]


async def test_escalates_when_primary_cannot_reconcile(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.llm.script = {"primary-mini": [BAD_EXTRACTION]}
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    j = await job(ctx, user, job_id)
    assert j["status"] == "succeeded" and j["model_used"] == "fallback-big"
    assert ctx.llm.calls == ["primary-mini", "fallback-big"]


async def test_escalates_when_primary_errors(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.llm.script = {"primary-mini": ["llm_timeout"]}
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    assert (await job(ctx, user, job_id))["status"] == "succeeded"
    llm_rows = [(r[1], r[6], r[7]) for r in await usage_rows(ctx) if r[0] == "llm"]
    assert llm_rows == [("primary-mini", False, "llm_timeout"), ("fallback-big", True, None)]


# ------------------------------------------------------------------------- failures + retry
async def test_llm_failure_then_retry_resumes_without_rebilling_ocr(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.llm.script = {"primary-mini": ["llm_http_500"], "fallback-big": ["llm_timeout"]}
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    j = await job(ctx, user, job_id)
    assert j["status"] == "failed" and j["error_code"] == "llm_timeout" and j["retryable"]
    bill = (await ctx.client.get(f"/api/bills/{bill_id}", headers=user.headers)).json()
    assert bill["status"] == "draft" and bill["items"] == []

    r = await ctx.client.post(f"/api/jobs/{job_id}/retry", headers=user.headers)
    assert r.status_code == 202 and r.json()["attempts"] == 2
    await ctx.drain()
    j = await job(ctx, user, job_id)
    assert j["status"] == "succeeded" and j["pages_billed"] == 1
    assert ctx.ocr.calls == 1  # OCR stage was skipped on retry
    rows = await usage_rows(ctx)
    assert sum(r[2] for r in rows if r[0] == "ocr") == 1 and len([r for r in rows if r[0] == "ocr"]) == 1
    r = await ctx.client.post(f"/api/jobs/{job_id}/retry", headers=user.headers)
    assert r.status_code == 409 and r.json()["code"] == "not_retryable"


async def test_ocr_failure_is_logged_and_retry_uses_cache_for_finished_files(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.ocr.fail_with = OcrError("ocr_rate_limited", "busy", retryable=True, submitted=False)
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    j = await job(ctx, user, job_id)
    assert j["status"] == "failed" and j["error_code"] == "ocr_rate_limited" and j["retryable"]
    assert await usage_rows(ctx) == [("ocr", "prebuilt-layout", 0, 0, 0, 0, False, "ocr_rate_limited")]
    ctx.ocr.fail_with = None
    assert (await ctx.client.post(f"/api/jobs/{job_id}/retry", headers=user.headers)).status_code == 202
    await ctx.drain()
    assert (await job(ctx, user, job_id))["status"] == "succeeded"
    # Retry again is not allowed, and a second scan of the same photo hits the cache.
    bill2 = await new_bill(ctx, user, "Again")
    files = await ctx.sql("SELECT storage_path FROM receipt_files")
    data = await ctx.services.storage.get(files[0][0])
    job2 = (await scan(ctx, user, bill2, [data])).json()["job_id"]
    await ctx.drain()
    j2 = await job(ctx, user, job2)
    assert j2["status"] == "succeeded" and j2["pages_billed"] == 0
    assert ctx.ocr.calls == 2  # one failed attempt + one success, none for the cached re-scan


async def test_non_retryable_failure_on_empty_ocr(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.ocr.default_text = "   "
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    j = await job(ctx, user, job_id)
    assert j["status"] == "failed" and j["error_code"] == "ocr_empty" and not j["retryable"]
    assert (await ctx.client.post(f"/api/jobs/{job_id}/retry", headers=user.headers)).status_code == 409


# ------------------------------------------------------------------------- cancel / interrupted
async def test_cancel_running_job_then_retry(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.ocr.delay = 5
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    assert (await wait_status(ctx, user, job_id, "ocr"))["status"] == "ocr"
    bill = (await ctx.client.get(f"/api/bills/{bill_id}", headers=user.headers)).json()
    assert bill["status"] == "scanning"
    r = await ctx.client.put(f"/api/bills/{bill_id}/receipt", headers=user.headers,
                             json={"items": [], "grand_total_cents": 0})
    assert r.status_code == 409 and r.json()["code"] == "scan_in_progress"

    r = await ctx.client.post(f"/api/jobs/{job_id}/cancel", headers=user.headers)
    assert r.status_code == 200 and r.json()["status"] == "cancelled" and r.json()["retryable"]
    assert not ctx.services.runner.is_running(uuid.UUID(job_id))
    bill = (await ctx.client.get(f"/api/bills/{bill_id}", headers=user.headers)).json()
    assert bill["status"] == "draft"
    # The in-flight OCR call is still accounted for (Azure may bill it).
    assert await usage_rows(ctx) == [("ocr", "prebuilt-layout", 1, 0, 0, 0, False, "cancelled")]

    ctx.ocr.delay = 0
    assert (await ctx.client.post(f"/api/jobs/{job_id}/retry", headers=user.headers)).status_code == 202
    await ctx.drain()
    assert (await job(ctx, user, job_id))["status"] == "succeeded"


async def test_cancel_after_finish_is_a_noop(ctx: Ctx) -> None:
    user = await ctx.user()
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    r = await ctx.client.post(f"/api/jobs/{job_id}/cancel", headers=user.headers)
    assert r.status_code == 200 and r.json()["status"] == "succeeded"


async def _stale_job(ctx: Ctx, user: AppUser) -> tuple[str, str]:
    bill_id = await new_bill(ctx, user)
    job_id = str(uuid.uuid4())
    await ctx.sql("INSERT INTO extraction_jobs (id, bill_id, owner_id, status, heartbeat_at, attempts) "
                  "VALUES (:id, :bill, :owner, 'llm', now() - interval '10 minutes', 1)",
                  id=job_id, bill=bill_id, owner=str(user.id))
    await ctx.sql("UPDATE bills SET status = 'scanning' WHERE id = :id", id=bill_id)
    return bill_id, job_id


async def test_stale_jobs_are_recovered_as_interrupted(ctx: Ctx) -> None:
    user = await ctx.user()
    bill_id, job_id = await _stale_job(ctx, user)
    fresh_bill = await new_bill(ctx, user, "fresh")
    fresh_job = str(uuid.uuid4())
    await ctx.sql("INSERT INTO extraction_jobs (id, bill_id, owner_id, status, heartbeat_at) "
                  "VALUES (:id, :bill, :owner, 'ocr', now())", id=fresh_job, bill=fresh_bill, owner=str(user.id))
    assert await recover_stale_jobs(ctx.sm, stale_seconds=60) == 1
    j = await job(ctx, user, job_id)
    assert j["status"] == "failed" and j["error_code"] == "interrupted" and j["retryable"]
    assert (await job(ctx, user, fresh_job))["status"] == "ocr"
    bill = (await ctx.client.get(f"/api/bills/{bill_id}", headers=user.headers)).json()
    assert bill["status"] == "draft"


async def test_polling_a_stale_job_marks_it_interrupted(ctx: Ctx) -> None:
    user = await ctx.user()
    _, job_id = await _stale_job(ctx, user)
    j = await job(ctx, user, job_id)
    assert j["status"] == "failed" and j["error_code"] == "interrupted"


async def test_interrupted_job_retry_resumes_from_saved_ocr(ctx: Ctx) -> None:
    user = await ctx.user()
    bill_id, job_id = await _stale_job(ctx, user)
    await ctx.sql("UPDATE extraction_jobs SET ocr_text = 'STORE\nItem 10.00' WHERE id = :id", id=job_id)
    await job(ctx, user, job_id)  # lazily marked interrupted
    assert (await ctx.client.post(f"/api/jobs/{job_id}/retry", headers=user.headers)).status_code == 202
    await ctx.drain()
    assert (await job(ctx, user, job_id))["status"] == "succeeded"
    assert ctx.ocr.calls == 0


async def test_shutdown_marks_running_jobs_interrupted(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.ocr.delay = 5
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await wait_status(ctx, user, job_id, "ocr")
    await ctx.services.runner.shutdown()
    j = await job(ctx, user, job_id)
    assert j["status"] == "failed" and j["error_code"] == "interrupted" and j["retryable"]


# ------------------------------------------------------------------------- idempotency
async def test_idempotency_key_replays_the_same_job(ctx: Ctx) -> None:
    user = await ctx.user()
    bill_id = await new_bill(ctx, user)
    first = await scan(ctx, user, bill_id, [jpeg()], key="scan-key-0001")
    assert first.status_code == 202
    replay = await scan(ctx, user, bill_id, [jpeg(), jpeg()], key="scan-key-0001")
    assert replay.status_code == 200
    assert replay.json() == {**first.json(), "replayed": True, "status": replay.json()["status"]}
    await ctx.drain()
    assert (await ctx.sql("SELECT count(*) FROM receipt_files"))[0][0] == 1
    assert (await ctx.sql("SELECT count(*) FROM extraction_jobs"))[0][0] == 1
    other_bill = await new_bill(ctx, user, "other")
    r = await scan(ctx, user, other_bill, [jpeg()], key="scan-key-0001")
    assert r.status_code == 409 and r.json()["code"] == "idempotency_key_reused"
    r = await scan(ctx, user, other_bill, [jpeg()], key="short")
    assert r.status_code == 400 and r.json()["code"] == "invalid_idempotency_key"


async def test_one_active_scan_per_bill(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.ocr.delay = 5
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    r = await scan(ctx, user, bill_id, [jpeg()])
    assert r.status_code == 409 and r.json()["code"] == "scan_in_progress" and r.json()["job_id"] == job_id
    await ctx.client.post(f"/api/jobs/{job_id}/cancel", headers=user.headers)


# ------------------------------------------------------------------------- quotas
async def test_user_quota_blocks_scans_but_not_manual_entry(ctx: Ctx) -> None:
    user = await ctx.user(quota=1)
    bill_id = await new_bill(ctx, user)
    r = await scan(ctx, user, bill_id, [jpeg(), jpeg()])
    assert r.status_code == 429 and r.json()["code"] == "quota_user_quota"
    assert ctx.ocr.calls == 0 and (await ctx.sql("SELECT count(*) FROM receipt_files"))[0][0] == 0
    same = jpeg("same-photo")
    assert (await scan(ctx, user, bill_id, [same])).status_code == 202
    await ctx.drain()
    bill2 = await new_bill(ctx, user, "second")
    r = await scan(ctx, user, bill2, [jpeg()])
    assert r.status_code == 429 and r.json()["code"] == "quota_user_quota" and r.json()["pages_used"] == 1
    # Re-scanning an already-read photo costs no pages, so it is still allowed.
    assert (await scan(ctx, user, bill2, [same])).status_code == 202
    await ctx.drain()
    usage = (await ctx.client.get("/api/me/usage", headers=user.headers)).json()
    assert usage["scans_paused"] and usage["pause_reason"] == "user_quota" and usage["pages_remaining"] == 0
    r = await ctx.client.put(f"/api/bills/{bill2}/receipt", headers=user.headers, json={
        "items": [{"name": "Manual", "unit_price_cents": 500, "total_price_cents": 500}], "grand_total_cents": 500})
    assert r.status_code == 200


async def test_global_caps_and_kill_switch(ctx: Ctx) -> None:
    admin = await ctx.user("root", role="admin")
    user = await ctx.user()
    bill_id = await new_bill(ctx, user)
    await ctx.client.patch("/api/admin/settings", headers=admin.headers, json={"global_monthly_page_cap": 1})
    r = await scan(ctx, user, bill_id, [jpeg(), jpeg()])
    assert r.status_code == 429 and r.json()["code"] == "quota_global_page_cap"
    await ctx.client.patch("/api/admin/settings", headers=admin.headers,
                           json={"global_monthly_page_cap": 450, "global_monthly_llm_budget_micros": 0})
    r = await scan(ctx, user, bill_id, [jpeg()])
    assert r.status_code == 429 and r.json()["code"] == "quota_llm_budget"
    await ctx.client.patch("/api/admin/settings", headers=admin.headers,
                           json={"global_monthly_llm_budget_micros": 5_000_000, "scans_enabled": False})
    r = await scan(ctx, user, bill_id, [jpeg()])
    assert r.status_code == 429 and r.json()["code"] == "quota_scans_disabled"
    await ctx.client.patch("/api/admin/settings", headers=admin.headers, json={"scans_enabled": True})
    assert (await scan(ctx, user, bill_id, [jpeg()])).status_code == 202


def llm_bound(ctx: Ctx, model: str) -> int:
    """The worst-case reservation the pipeline makes for one call on the fake OCR text."""
    from app.core.pricing import max_call_cost_micros
    from app.integrations.llm import max_input_tokens

    s = ctx.services.settings
    bound = max_call_cost_micros(model, max_input_tokens(ctx.ocr.default_text), s.llm_max_output_tokens,
                                 s.llm_max_retries + 1, s.llm_prices)
    assert bound is not None
    return bound


async def set_llm_budget(ctx: Ctx, admin: AppUser, micros: int) -> None:
    r = await ctx.client.patch("/api/admin/settings", headers=admin.headers,
                               json={"global_monthly_llm_budget_micros": micros})
    assert r.status_code == 200, r.text


async def llm_reserved(ctx: Ctx) -> int:
    return (await ctx.sql("SELECT coalesce(sum(llm_reserved_micros), 0) FROM extraction_jobs"))[0][0]


async def test_llm_budget_reserves_worst_case_before_a_near_cap_call(ctx: Ctx) -> None:
    admin, user = await ctx.user("root", role="admin"), await ctx.user()
    primary = llm_bound(ctx, "primary-mini")
    assert primary > 1800  # the fake call's real cost is below its worst case
    await set_llm_budget(ctx, admin, primary - 1)  # nothing spent yet, but one more call COULD overshoot
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    j = await job(ctx, user, job_id)
    assert j["status"] == "failed" and j["error_code"] == "quota_llm_budget" and j["retryable"]
    assert ctx.llm.calls == [] and await llm_reserved(ctx) == 0
    assert [r[0] for r in await usage_rows(ctx)] == ["ocr"]

    await set_llm_budget(ctx, admin, primary)  # exactly one worst case fits
    assert (await ctx.client.post(f"/api/jobs/{job_id}/retry", headers=user.headers)).status_code == 202
    await ctx.drain()
    assert (await job(ctx, user, job_id))["status"] == "succeeded"
    assert ctx.llm.calls == ["primary-mini"] and await llm_reserved(ctx) == 0


async def test_fallback_needs_its_own_reservation(ctx: Ctx) -> None:
    admin, user = await ctx.user("root", role="admin"), await ctx.user()
    # Room for the primary's worst case, but after its real cost (1800 µ$) not for the fallback's.
    await set_llm_budget(ctx, admin, 1800 + llm_bound(ctx, "fallback-big") - 1)
    ctx.llm.script = {"primary-mini": [BAD_EXTRACTION]}
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    j = await job(ctx, user, job_id)
    assert j["status"] == "failed" and j["error_code"] == "quota_llm_budget"
    assert ctx.llm.calls == ["primary-mini"] and await llm_reserved(ctx) == 0
    spent = await ctx.sql("SELECT sum(cost_micros) FROM usage_events WHERE kind = 'llm'")
    assert spent == [(1800,)]


async def test_concurrent_jobs_cannot_jointly_pass_the_budget(ctx: Ctx) -> None:
    admin, user = await ctx.user("root", role="admin"), await ctx.user()
    await set_llm_budget(ctx, admin, llm_bound(ctx, "primary-mini") * 2 - 1)  # room for ONE call in flight
    ctx.llm.delay = 0.3  # both jobs reach the LLM stage while the first call is still running
    job_ids = []
    for _ in range(2):
        bill_id = await new_bill(ctx, user)
        job_ids.append((await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"])
    await ctx.drain()
    jobs = [await job(ctx, user, jid) for jid in job_ids]
    statuses = sorted([j["status"], j["error_code"]] for j in jobs)
    assert statuses == [["failed", "quota_llm_budget"], ["succeeded", None]]
    assert ctx.llm.calls == ["primary-mini"] and await llm_reserved(ctx) == 0


async def test_reservation_is_released_when_the_call_fails_or_is_cancelled(ctx: Ctx) -> None:
    user = await ctx.user()
    ctx.llm.script = {"primary-mini": ["llm_timeout"], "fallback-big": ["llm_http_500"]}
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    assert (await job(ctx, user, job_id))["status"] == "failed" and await llm_reserved(ctx) == 0

    ctx.llm.delay = 5
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await wait_status(ctx, user, job_id, "llm")
    deadline = asyncio.get_running_loop().time() + 3
    while await llm_reserved(ctx) == 0 and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.02)
    assert await llm_reserved(ctx) == llm_bound(ctx, "primary-mini")
    assert (await ctx.client.post(f"/api/jobs/{job_id}/cancel", headers=user.headers)).status_code == 200
    await ctx.drain()
    assert await llm_reserved(ctx) == 0


async def test_unknown_model_is_reserved_at_the_most_expensive_price(ctx: Ctx, monkeypatch) -> None:
    from app.config import ModelPrice
    from app.core.pricing import max_call_cost_micros

    table = {"cheap": ModelPrice(input=Decimal("0.1"), output=Decimal("0.4")),
             "dear": ModelPrice(input=Decimal("10"), output=Decimal("50"))}
    assert max_call_cost_micros("mystery-model", 1000, 100, 2, table) == (1000 * 10 + 100 * 50) * 2
    assert max_call_cost_micros("dear-2026-01-01", 1000, 100, 1, table) == 1000 * 10 + 100 * 50
    assert max_call_cost_micros("cheap", 1000, 100, 0, {}) is None

    monkeypatch.setattr(ctx.services.settings, "llm_prices", {})
    user = await ctx.user()
    bill_id = await new_bill(ctx, user)
    job_id = (await scan(ctx, user, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    j = await job(ctx, user, job_id)
    assert j["status"] == "failed" and j["error_code"] == "llm_price_unknown" and ctx.llm.calls == []


# ------------------------------------------------------------------------- files
async def test_file_rules(ctx: Ctx) -> None:
    user = await ctx.user()
    bill_id = await new_bill(ctx, user)
    webp = b"RIFF\x00\x00\x00\x00WEBPVP8 "
    cases = [
        ([webp], 415, "unsupported_file_type"),
        ([b"just some text"], 415, "unsupported_file_type"),
        ([jpeg() for _ in range(6)], 400, "too_many_files"),
        ([b""], 400, "empty_file"),
        ([b"\xff\xd8\xff" + b"0" * (4 * 1024 * 1024)], 413, "file_too_large"),
        ([], 400, "no_files"),
    ]
    for files, status, code in cases:
        r = await scan(ctx, user, bill_id, files)
        assert (r.status_code, r.json()["code"]) == (status, code), (code, r.text)
    assert (await ctx.sql("SELECT count(*) FROM extraction_jobs"))[0][0] == 0
    assert ctx.ocr.calls == 0


async def test_multi_file_scan_bills_pdf_pages(ctx: Ctx) -> None:
    user = await ctx.user()
    bill_id = await new_bill(ctx, user)
    r = await scan(ctx, user, bill_id, [jpeg(), PDF + b"1", PNG + b"2", jpeg("dup"), jpeg("dup")])
    job_id = r.json()["job_id"]
    await ctx.drain()
    j = await job(ctx, user, job_id)
    assert j["status"] == "succeeded" and j["pages_billed"] == 1 + 2 + 1 + 1  # duplicate photo dropped
    rows = await ctx.sql("SELECT mime, pages, position FROM receipt_files ORDER BY position")
    assert rows == [("image/jpeg", 1, 0), ("application/pdf", 2, 1), ("image/png", 1, 2), ("image/jpeg", 1, 3)]
    text = (await ctx.sql("SELECT ocr_text FROM extraction_jobs"))[0][0]
    assert text.startswith("--- Page 1 of 4 ---") and "--- Page 4 of 4 ---" in text


async def test_signed_file_url_and_expiry(ctx: Ctx) -> None:
    user = await ctx.user()
    bill_id = await new_bill(ctx, user)
    photo = jpeg("photo")
    await scan(ctx, user, bill_id, [photo])
    await ctx.drain()
    file_id = (await ctx.client.get(f"/api/bills/{bill_id}", headers=user.headers)).json()["files"][0]["id"]
    r = await ctx.client.get(f"/api/bills/{bill_id}/files/{file_id}", headers=user.headers)
    assert r.status_code == 200 and r.json()["mime"] == "image/jpeg" and r.json()["expires_in"] == 300
    url = r.json()["url"]
    got = await ctx.client.get(url)
    assert got.status_code == 200 and got.content == photo
    assert (await ctx.client.get(url.replace("sig=", "sig=0"))).status_code == 404
    await ctx.sql("UPDATE receipt_files SET expires_at = now() - interval '1 second'")
    r = await ctx.client.get(f"/api/bills/{bill_id}/files/{file_id}", headers=user.headers)
    assert r.status_code == 410 and r.json()["code"] == "file_expired"


async def test_jobs_and_files_are_owner_isolated(ctx: Ctx) -> None:
    alice = await ctx.user("alice")
    mallory = await ctx.user("mallory")
    bill_id = await new_bill(ctx, alice)
    job_id = (await scan(ctx, alice, bill_id, [jpeg()])).json()["job_id"]
    await ctx.drain()
    file_id = (await ctx.client.get(f"/api/bills/{bill_id}", headers=alice.headers)).json()["files"][0]["id"]
    for method, url in [("GET", f"/api/jobs/{job_id}"), ("POST", f"/api/jobs/{job_id}/cancel"),
                        ("POST", f"/api/jobs/{job_id}/retry"), ("GET", f"/api/bills/{bill_id}/files/{file_id}")]:
        assert (await ctx.client.request(method, url, headers=mallory.headers)).status_code == 404, url
    r = await scan(ctx, mallory, bill_id, [jpeg()])
    assert r.status_code == 404


async def test_scan_rate_limit(ctx: Ctx) -> None:
    user = await ctx.user()
    bill_id = await new_bill(ctx, user)
    old = ctx.settings.rate_limit_scans
    ctx.settings.rate_limit_scans = "2/minute"
    limiter.enabled = True
    reset_all()
    try:
        codes = [(await scan(ctx, user, bill_id, [b"bad"])).status_code for _ in range(3)]
        assert codes[:2] == [415, 415] and codes[2] == 429
        r = await scan(ctx, user, bill_id, [b"bad"])
        assert r.json()["code"] == "rate_limited" and r.headers["retry-after"]
    finally:
        limiter.enabled = False
        reset_all()
        ctx.settings.rate_limit_scans = old
