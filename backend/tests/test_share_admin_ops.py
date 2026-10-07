"""Share links (public view), admin user management/usage/settings, internal maintenance,
and HTTP guardrails (CORS, body size, error envelopes, rate limits), plus schema/RLS checks."""

from __future__ import annotations

import hashlib
from pathlib import Path

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from fastapi import FastAPI

from app.models import Base
from app.ratelimit import limiter, reset_all
from tests.conftest import AppUser, Ctx, jpeg
from tests.test_bills import full_bill


# ------------------------------------------------------------------------- share links
async def test_share_links_person_and_whole_bill(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)
    url = f"/api/bills/{bill['id']}/share-links"
    r = await ctx.client.post(url, headers=user.headers, json={"person_id": ids["B"], "expires_in_days": 30})
    assert r.status_code == 201, r.text
    link = r.json()
    assert link["path"] == f"/s/{link['token']}" and link["url"] == f"https://app.example.com/s/{link['token']}"
    assert len(link["token"]) >= 43 and link["expires_at"]
    stored = await ctx.sql("SELECT token_hash FROM share_links")
    assert stored == [(hashlib.sha256(link["token"].encode()).hexdigest(),)]  # only the hash is stored

    pub = await ctx.client.get(f"/api/public/share/{link['token']}")
    assert pub.status_code == 200 and pub.headers["cache-control"] == "no-store"
    body = pub.json()
    assert body["scope"] == "person" and body["people"] == [] and body["payer_name"] == "Alice"
    assert body["person"]["name"] == "Friend B" and body["person"]["total_cents"] == 1276
    assert [i["name"] for i in body["person"]["items"]] == ["Laksa", "Iced Lemon Tea"]
    assert body["currency"] == "SGD" and body["grand_total_cents"] == 4668
    flat = pub.text
    assert "person_id" not in flat and str(user.id) not in flat and "owner" not in flat  # minimal data

    whole = (await ctx.client.post(url, headers=user.headers)).json()
    body = (await ctx.client.get(f"/api/public/share/{whole['token']}")).json()
    assert body["scope"] == "bill" and body["person"] is None and len(body["people"]) == 4
    assert sum(p["total_cents"] for p in body["people"]) == 4668

    listed = (await ctx.client.get(url, headers=user.headers)).json()["items"]
    assert len(listed) == 2 and all("token" not in item for item in listed)
    assert listed[1]["last_viewed_at"] is not None

    # Revoke one, then all.
    assert (await ctx.client.delete(f"{url}/{link['id']}", headers=user.headers)).status_code == 204
    assert (await ctx.client.get(f"/api/public/share/{link['token']}")).status_code == 404
    assert (await ctx.client.get(f"/api/public/share/{whole['token']}")).status_code == 200
    assert (await ctx.client.delete(url, headers=user.headers)).status_code == 204
    assert (await ctx.client.get(f"/api/public/share/{whole['token']}")).status_code == 404


async def test_share_link_edge_cases(ctx: Ctx) -> None:
    user = await ctx.user()
    bill, ids = await full_bill(ctx, user)
    url = f"/api/bills/{bill['id']}/share-links"
    outsider = (await ctx.client.post("/api/people", headers=user.headers, json={"name": "Out"})).json()["id"]
    r = await ctx.client.post(url, headers=user.headers, json={"person_id": outsider})
    assert r.status_code == 400 and r.json()["code"] == "not_a_participant"
    assert (await ctx.client.post(url, headers=user.headers, json={"expires_in_days": 0})).status_code == 422
    link = (await ctx.client.post(url, headers=user.headers, json={"person_id": ids["D"]})).json()
    await ctx.client.post(f"/api/bills/{bill['id']}/participants/{ids['D']}/settlement", headers=user.headers)
    body = (await ctx.client.get(f"/api/public/share/{link['token']}")).json()
    assert body["person"]["settled"] is True and body["person"]["outstanding_cents"] == 0
    await ctx.sql("UPDATE share_links SET expires_at = now() - interval '1 minute'")
    assert (await ctx.client.get(f"/api/public/share/{link['token']}")).status_code == 404
    assert (await ctx.client.get("/api/public/share/nope")).status_code == 404
    assert (await ctx.client.get(f"/api/public/share/{'x' * 200}")).status_code == 404
    assert (await ctx.client.delete(f"{url}/{bill['id']}", headers=user.headers)).status_code == 404


async def test_public_share_rate_limit(ctx: Ctx) -> None:
    old = ctx.settings.rate_limit_public
    ctx.settings.rate_limit_public = "3/minute"
    limiter.enabled = True
    reset_all()
    try:
        codes = [(await ctx.client.get("/api/public/share/unknown-token")).status_code for _ in range(4)]
        assert codes == [404, 404, 404, 429]
    finally:
        limiter.enabled = False
        reset_all()
        ctx.settings.rate_limit_public = old


# ------------------------------------------------------------------------- admin
async def test_admin_creates_password_user_who_can_then_log_in(ctx: Ctx) -> None:
    admin = await ctx.user("root", role="admin")
    r = await ctx.client.post("/api/admin/users", headers=admin.headers,
                              json={"username": "  Charlie ", "display_name": "Charlie C", "monthly_scan_quota": 12})
    assert r.status_code == 201, r.text
    out = r.json()
    user = out["user"]
    assert user["username"] == "charlie" and user["email"] == "charlie@users.even.app"
    assert user["must_change_password"] is True and user["monthly_scan_quota"] == 12
    pw = out["temp_password"]
    assert len(pw) == 16 and any(c.isupper() for c in pw) and any(c.isdigit() for c in pw)
    fake = ctx.auth_admin.users
    assert len(fake) == 1
    (uid, record), = fake.items()
    assert str(uid) == user["id"] and record["password"] == pw and record["metadata"]["username"] == "charlie"

    from tests.conftest import token_for

    headers = {"Authorization": f"Bearer {token_for(uid)}"}
    me = (await ctx.client.get("/api/me", headers=headers)).json()
    assert me["must_change_password"] is True and me["display_name"] == "Charlie C" and me["self_person_id"]
    assert (await ctx.client.get("/api/bills", headers=headers)).status_code == 403

    r = await ctx.client.post("/api/admin/users", headers=admin.headers, json={"username": "charlie"})
    assert r.status_code == 409 and r.json()["code"] == "username_taken"
    for bad in ("ab", "has space", "-dash", "x" * 33):
        assert (await ctx.client.post("/api/admin/users", headers=admin.headers,
                                      json={"username": bad})).status_code == 422


async def test_admin_allowlists_google_account(ctx: Ctx) -> None:
    admin = await ctx.user("root", role="admin")
    r = await ctx.client.post("/api/admin/users", headers=admin.headers,
                              json={"username": "gina", "email": "Gina.Example@Gmail.com", "login": "google"})
    assert r.status_code == 201, r.text
    assert r.json()["temp_password"] is None
    assert r.json()["user"]["email"] == "gina.example@gmail.com" and r.json()["user"]["must_change_password"] is False
    r = await ctx.client.post("/api/admin/users", headers=admin.headers,
                              json={"username": "gina2", "email": "gina.example@gmail.com"})
    assert r.status_code == 409 and r.json()["code"] == "email_taken"
    assert (await ctx.client.post("/api/admin/users", headers=admin.headers,
                                  json={"username": "x1x", "email": "not-an-email"})).status_code == 422


async def test_admin_auth_provider_failure_is_502_and_leaves_no_profile(ctx: Ctx) -> None:
    admin = await ctx.user("root", role="admin")
    ctx.auth_admin.fail_next = "boom"
    r = await ctx.client.post("/api/admin/users", headers=admin.headers, json={"username": "zed"})
    assert r.status_code == 502 and r.json()["code"] == "auth_provider_error"
    assert (await ctx.sql("SELECT count(*) FROM profiles WHERE username = 'zed'"))[0][0] == 0


async def test_admin_patch_disable_reset_and_list(ctx: Ctx) -> None:
    admin = await ctx.user("root", role="admin")
    created = (await ctx.client.post("/api/admin/users", headers=admin.headers, json={"username": "dave"})).json()
    uid = created["user"]["id"]
    r = await ctx.client.patch(f"/api/admin/users/{uid}", headers=admin.headers,
                               json={"monthly_scan_quota": 5, "disabled": True, "role": "admin"})
    assert r.status_code == 200 and r.json()["monthly_scan_quota"] == 5 and r.json()["disabled_at"]
    assert r.json()["role"] == "admin"
    import uuid as _uuid

    assert ctx.auth_admin.users[_uuid.UUID(uid)]["banned"] is True
    from tests.conftest import token_for

    r = await ctx.client.get("/api/me", headers={"Authorization": f"Bearer {token_for(uid)}"})
    assert r.status_code == 403 and r.json()["code"] == "account_disabled"
    await ctx.client.patch(f"/api/admin/users/{uid}", headers=admin.headers, json={"disabled": False})
    assert ctx.auth_admin.users[_uuid.UUID(uid)]["banned"] is False

    r = await ctx.client.post(f"/api/admin/users/{uid}/reset-password", headers=admin.headers)
    assert r.status_code == 200 and r.json()["temp_password"] != created["temp_password"]
    assert ctx.auth_admin.users[_uuid.UUID(uid)]["password"] == r.json()["temp_password"]

    r = await ctx.client.patch(f"/api/admin/users/{admin.id}", headers=admin.headers, json={"disabled": True})
    assert r.status_code == 409 and r.json()["code"] == "cannot_disable_self"
    r = await ctx.client.patch(f"/api/admin/users/{admin.id}", headers=admin.headers, json={"role": "member"})
    assert r.status_code == 409 and r.json()["code"] == "cannot_demote_self"

    for name in ("erin", "fay", "gus"):
        await ctx.client.post("/api/admin/users", headers=admin.headers, json={"username": name})
    page1 = (await ctx.client.get("/api/admin/users?limit=3", headers=admin.headers)).json()
    page2 = (await ctx.client.get(f"/api/admin/users?limit=3&cursor={page1['next_cursor']}",
                                  headers=admin.headers)).json()
    names = [u["username"] for u in page1["items"] + page2["items"]]
    assert names == ["dave", "erin", "fay", "gus", "root"] and page2["next_cursor"] is None
    assert (await ctx.client.patch(f"/api/admin/users/{_uuid.uuid4()}", headers=admin.headers,
                                   json={"monthly_scan_quota": 1})).status_code == 404


async def test_admin_usage_and_settings(ctx: Ctx) -> None:
    admin = await ctx.user("root", role="admin")
    user = await ctx.user()
    bill = (await ctx.client.post("/api/bills", headers=user.headers, json={})).json()
    await ctx.client.post(f"/api/bills/{bill['id']}/scans", headers=user.headers,
                          files=[("files", ("a.jpg", jpeg(), "image/jpeg"))])
    await ctx.drain()
    usage = (await ctx.client.get("/api/admin/usage", headers=admin.headers)).json()
    assert usage["timezone"] == "Asia/Singapore"
    assert usage["totals"]["ocr_pages"] == 1 and usage["totals"]["llm_calls"] == 1
    assert usage["totals"]["cost_micros"] == 1800
    assert usage["by_user"][0]["username"] == "alice" and usage["by_user"][0]["ocr_pages"] == 1
    assert usage["by_model"][0]["model"] == "primary-mini" and usage["by_model"][0]["calls"] == 1
    old = (await ctx.client.get("/api/admin/usage?month=2020-01", headers=admin.headers)).json()
    assert old["totals"]["ocr_pages"] == 0
    assert (await ctx.client.get("/api/admin/usage?month=2020-13", headers=admin.headers)).status_code == 400
    users = (await ctx.client.get("/api/admin/users", headers=admin.headers)).json()["items"]
    assert {u["username"]: u["pages_used_this_month"] for u in users} == {"alice": 1, "root": 0}

    s = (await ctx.client.get("/api/admin/settings", headers=admin.headers)).json()
    assert s["llm"]["primary_model"] == "primary-mini" and s["llm"]["fallback_model"] == "fallback-big"
    assert s["global_monthly_page_cap"] == 450 and s["global_monthly_llm_budget_micros"] == 5_000_000
    assert s["default_user_quota"] == 30 and s["scans_enabled"] is True and s["ocr_max_pdf_pages"] == 2
    r = await ctx.client.patch("/api/admin/settings", headers=admin.headers, json={"default_user_quota": 10})
    assert r.json()["default_user_quota"] == 10
    created = (await ctx.client.post("/api/admin/users", headers=admin.headers, json={"username": "neo"})).json()
    assert created["user"]["monthly_scan_quota"] == 10
    assert (await ctx.client.patch("/api/admin/settings", headers=admin.headers,
                                   json={"global_monthly_page_cap": -1})).status_code == 422


async def test_admin_create_rate_limit(ctx: Ctx) -> None:
    admin = await ctx.user("root", role="admin")
    old = ctx.settings.rate_limit_admin_create
    ctx.settings.rate_limit_admin_create = "2/hour"
    limiter.enabled = True
    reset_all()
    try:
        codes = [(await ctx.client.post("/api/admin/users", headers=admin.headers,
                                        json={"username": f"user{i}x"})).status_code for i in range(3)]
        assert codes == [201, 201, 429]
    finally:
        limiter.enabled = False
        reset_all()
        ctx.settings.rate_limit_admin_create = old


# ------------------------------------------------------------------------- maintenance
async def test_maintenance_requires_cron_secret(ctx: Ctx) -> None:
    assert (await ctx.client.post("/api/internal/maintenance")).status_code == 401
    r = await ctx.client.post("/api/internal/maintenance", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401
    user = await ctx.user()
    r = await ctx.client.post("/api/internal/maintenance", headers=user.headers)
    assert r.status_code == 401


async def test_maintenance_purges_expired_photos_and_fails_stale_jobs(ctx: Ctx) -> None:
    user: AppUser = await ctx.user()
    bill = (await ctx.client.post("/api/bills", headers=user.headers, json={})).json()
    await ctx.client.post(f"/api/bills/{bill['id']}/scans", headers=user.headers,
                          files=[("files", ("a.jpg", jpeg(), "image/jpeg"))])
    await ctx.drain()
    path = (await ctx.sql("SELECT storage_path FROM receipt_files"))[0][0]
    await ctx.sql("UPDATE receipt_files SET expires_at = now() - interval '1 day'")
    await ctx.sql("INSERT INTO extraction_jobs (id, bill_id, owner_id, status, heartbeat_at) "
                  "VALUES (gen_random_uuid(), :b, :o, 'ocr', now() - interval '1 hour')",
                  b=bill["id"], o=str(user.id))
    r = await ctx.client.post("/api/internal/maintenance", headers={"Authorization": "Bearer test-cron-secret"})
    assert r.status_code == 200, r.text
    assert r.json() == {"purged_files": 1, "purge_failures": 0, "failed_stale_jobs": 1, "db": "ok"}
    assert (await ctx.sql("SELECT deleted_at IS NOT NULL FROM receipt_files"))[0][0] is True
    root = Path(ctx.services.storage.root)  # type: ignore[attr-defined]
    assert not (root / path).exists()
    # Bill data stays forever; the file is reported unavailable.
    files = (await ctx.client.get(f"/api/bills/{bill['id']}", headers=user.headers)).json()["files"]
    assert files[0]["available"] is False
    again = await ctx.client.post("/api/internal/maintenance", headers={"Authorization": "Bearer test-cron-secret"})
    assert again.json()["purged_files"] == 0


# ------------------------------------------------------------------------- guardrails
async def test_cors_preflight_allowlist(ctx: Ctx) -> None:
    ok = await ctx.client.options("/api/bills", headers={
        "Origin": "https://app.example.com", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,idempotency-key"})
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == "https://app.example.com"
    bad = await ctx.client.options("/api/bills", headers={
        "Origin": "https://evil.example.com", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers


async def test_error_envelopes_keep_cors_headers(ctx: Ctx) -> None:
    origin = {"Origin": "http://localhost:3000"}
    r = await ctx.client.get("/api/me", headers=origin)
    assert r.status_code == 401 and r.headers["access-control-allow-origin"] == "http://localhost:3000"
    user = await ctx.user()
    r = await ctx.client.post("/api/people", headers={**origin, **user.headers}, json={"name": 5})
    assert r.status_code == 422 and r.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert r.json()["code"] == "validation_error" and r.json()["errors"][0]["loc"] == ["body", "name"]


async def test_unhandled_error_is_json_500_with_cors(ctx: Ctx) -> None:
    app: FastAPI = ctx.app

    async def boom() -> None:
        raise RuntimeError("kaboom")

    app.add_api_route("/api/test-boom", boom)
    r = await ctx.client.get("/api/test-boom", headers={"Origin": "https://app.example.com"})
    assert r.status_code == 500
    assert r.json() == {"detail": "Something went wrong on our side.", "code": "internal_error"}
    assert r.headers["access-control-allow-origin"] == "https://app.example.com"


async def test_body_size_limit(ctx: Ctx) -> None:
    user = await ctx.user()
    big = {"name": "x", "padding": "y" * (300 * 1024)}
    r = await ctx.client.post("/api/people", headers={**user.headers, "Origin": "https://app.example.com"}, json=big)
    assert r.status_code == 413 and r.json()["code"] == "payload_too_large"
    assert r.headers["access-control-allow-origin"] == "https://app.example.com"

    async def chunks():  # noqa: ANN202 - streamed body without Content-Length
        for _ in range(40):
            yield b"x" * 10_000

    r = await ctx.client.post("/api/people", headers={**user.headers, "Content-Type": "application/json"},
                              content=chunks())
    assert r.status_code == 413


async def test_default_rate_limit_applies_to_every_api_route(ctx: Ctx) -> None:
    alice, bob = await ctx.user("alice"), await ctx.user("bob")
    old = ctx.settings.rate_limit_default
    ctx.settings.rate_limit_default = "3/minute"
    limiter.enabled = True
    reset_all()
    try:
        codes = [(await ctx.client.get("/api/people", headers=alice.headers)).status_code for _ in range(4)]
        assert codes == [200, 200, 200, 429]
        r = await ctx.client.get("/api/bills", headers=alice.headers)
        assert r.status_code == 429 and r.json()["code"] == "rate_limited" and r.headers["retry-after"] == "60"
        assert (await ctx.client.get("/api/people", headers=bob.headers)).status_code == 200  # per-user buckets
    finally:
        limiter.enabled = False
        ctx.settings.rate_limit_default = old
        reset_all()


# ------------------------------------------------------------------------- schema / RLS
async def test_every_public_table_has_rls_and_no_api_role_grants(ctx: Ctx) -> None:
    rows = await ctx.sql("""
        SELECT c.relname, c.relrowsecurity,
               has_table_privilege('anon', c.oid, 'SELECT'), has_table_privilege('authenticated', c.oid, 'INSERT')
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1""")
    assert len(rows) == 15
    assert all(rls for _, rls, _, _ in rows), rows
    assert not any(anon or auth for _, _, anon, auth in rows), rows
    policies = await ctx.sql("SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")
    assert policies == [(0,)]  # deny-all: RLS on, no policies


async def test_models_match_migrations(ctx: Ctx) -> None:
    async with ctx.app.state.db.engine.connect() as conn:
        def _diff(sync_conn):  # noqa: ANN001, ANN202
            mc = MigrationContext.configure(sync_conn, opts={"compare_type": True})
            return compare_metadata(mc, Base.metadata)

        diff = await conn.run_sync(_diff)
    assert diff == [], diff


# ------------------------------------------------------------------------- P1c: payment note + health commit
async def test_payment_note_trim_limits_and_clear(ctx: Ctx) -> None:
    user = await ctx.user()
    me = (await ctx.client.get("/api/me", headers=user.headers)).json()
    assert me["payment_note"] is None
    r = await ctx.client.patch("/api/me", headers=user.headers, json={"payment_note": "  PayNow 9123 4567  "})
    assert r.status_code == 200 and r.json()["payment_note"] == "PayNow 9123 4567"
    assert (await ctx.client.patch("/api/me", headers=user.headers, json={"display_name": "Al"})).json()[
        "payment_note"] == "PayNow 9123 4567"  # untouched when omitted
    assert (await ctx.client.patch("/api/me", headers=user.headers, json={"payment_note": "x" * 201})).status_code == 422
    assert (await ctx.client.patch("/api/me", headers=user.headers,
                                   json={"payment_note": "x" * 200})).json()["payment_note"] == "x" * 200
    for empty in ("   ", "", None):
        await ctx.client.patch("/api/me", headers=user.headers, json={"payment_note": "DuitNow 012"})
        r = await ctx.client.patch("/api/me", headers=user.headers, json={"payment_note": empty})
        assert r.status_code == 200 and r.json()["payment_note"] is None, empty


async def test_public_share_shows_payment_note_only_when_owner_paid(ctx: Ctx) -> None:
    owner = await ctx.user("alice")
    other = await ctx.user("mallory")
    await ctx.client.patch("/api/me", headers=owner.headers, json={"payment_note": "PayNow 9123 4567"})
    await ctx.client.patch("/api/me", headers=other.headers, json={"payment_note": "Mallory's bank"})
    bill, ids = await full_bill(ctx, owner)
    link = (await ctx.client.post(f"/api/bills/{bill['id']}/share-links", headers=owner.headers,
                                  json={"person_id": ids["B"]})).json()
    pub = (await ctx.client.get(f"/api/public/share/{link['token']}")).json()
    assert pub["payer_payment_note"] == "PayNow 9123 4567"
    # A friend paid: never leak the owner's (or anyone else's) note.
    await ctx.client.patch(f"/api/bills/{bill['id']}", headers=owner.headers, json={"payer_person_id": ids["C"]})
    pub = (await ctx.client.get(f"/api/public/share/{link['token']}")).json()
    assert pub["payer_payment_note"] is None and pub["payer_name"] == "Friend C"
    assert "Mallory" not in (await ctx.client.get(f"/api/public/share/{link['token']}")).text
    # Mallory's own bill shows only Mallory's note.
    mbill = (await ctx.client.post("/api/bills", headers=other.headers, json={})).json()
    mlink = (await ctx.client.post(f"/api/bills/{mbill['id']}/share-links", headers=other.headers)).json()
    assert (await ctx.client.get(f"/api/public/share/{mlink['token']}")).json()["payer_payment_note"] == "Mallory's bank"


async def test_health_reports_commit_without_db(ctx: Ctx) -> None:
    assert (await ctx.client.get("/api/health")).json()["commit"] is None
    ctx.settings.render_git_commit = "abc1234"
    db, ctx.app.state.db = ctx.app.state.db, None  # any DB access would now raise
    try:
        r = await ctx.client.get("/api/health")
        assert r.status_code == 200 and r.json() == {"status": "ok", "version": r.json()["version"],
                                                     "commit": "abc1234"}
    finally:
        ctx.app.state.db = db
        ctx.settings.render_git_commit = ""
