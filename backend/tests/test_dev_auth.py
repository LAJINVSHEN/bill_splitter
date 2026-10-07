"""Dev-only login + password mirror (fake Supabase admin) and the idempotent dev seed."""

from __future__ import annotations

import httpx
import pytest

from app.config import Settings
from app.devtools import dev_auth_enabled, seed
from app.main import create_app
from tests.conftest import Ctx


@pytest.fixture
def dev_password(ctx: Ctx):  # noqa: ANN201
    old = ctx.settings.dev_login_password
    ctx.settings.dev_login_password = "letmein-dev"
    yield "letmein-dev"
    ctx.settings.dev_login_password = old


async def _login(ctx: Ctx, username: str, password: str) -> httpx.Response:
    return await ctx.client.post("/api/dev/auth/login", json={"username": username, "password": password})


async def test_dev_login_with_dev_password(ctx: Ctx, dev_password: str) -> None:
    await ctx.user("alice")
    r = await _login(ctx, "Alice", dev_password)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token_type"] == "bearer" and body["expires_in"] == 12 * 3600
    me = await ctx.client.get("/api/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200 and me.json()["username"] == "alice"
    assert (await _login(ctx, "alice@test.local", dev_password)).status_code == 200  # email works too
    for user, pw in (("alice", "wrong"), ("nobody", dev_password)):
        r = await _login(ctx, user, pw)
        assert r.status_code == 401 and r.json()["code"] == "invalid_credentials"
    await ctx.user("dora", disabled=True)
    r = await _login(ctx, "dora", dev_password)
    assert r.status_code == 403 and r.json()["code"] == "account_disabled"


async def test_dev_login_rejects_everything_without_a_dev_password(ctx: Ctx) -> None:
    await ctx.user("alice")
    assert ctx.settings.dev_login_password == ""
    assert (await _login(ctx, "alice", "")).status_code == 422
    assert (await _login(ctx, "alice", "anything")).status_code == 401


async def test_fake_admin_password_flow_mirrors_supabase(ctx: Ctx, dev_password: str) -> None:
    admin = await ctx.user("root", role="admin")
    created = (await ctx.client.post("/api/admin/users", headers=admin.headers, json={"username": "neo"})).json()
    temp = created["temp_password"]
    # The fake admin knows this user, so only its password works (not DEV_LOGIN_PASSWORD).
    assert (await _login(ctx, "neo", dev_password)).status_code == 401
    token = (await _login(ctx, "neo", temp)).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    assert (await ctx.client.get("/api/bills", headers=h)).json()["code"] == "password_change_required"
    assert (await ctx.client.post("/api/dev/auth/password", headers=h, json={"password": "s3cret-new"})).status_code == 204
    assert (await ctx.client.post("/api/me/password-changed", headers=h)).status_code == 200
    assert (await _login(ctx, "neo", temp)).status_code == 401
    assert (await _login(ctx, "neo", "s3cret-new")).status_code == 200
    assert (await ctx.client.get("/api/bills", headers=h)).status_code == 200
    r = await ctx.client.post("/api/dev/auth/password", json={"password": "s3cret-new"})
    assert r.status_code == 401  # needs a Bearer token
    assert (await ctx.client.post("/api/dev/auth/password", headers=h, json={"password": "x"})).status_code == 422


@pytest.mark.parametrize("overrides", [
    {"environment": "production"},
    {"supabase_admin_backend": "supabase"},
    {"environment": "production", "supabase_admin_backend": "supabase"},
])
async def test_dev_routes_are_absent_outside_fake_dev(overrides: dict) -> None:
    settings = Settings(**overrides)
    assert not dev_auth_enabled(settings)
    app = create_app(settings)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        for path in ("/api/dev/auth/login", "/api/dev/auth/password"):
            r = await client.post(path, json={"username": "george", "password": "x"})
            assert r.status_code == 404, (overrides, path)


async def test_production_app_has_no_dev_routes_at_all() -> None:
    app = create_app(Settings(environment="production", storage_backend="local"))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        assert (await client.post("/api/dev/auth/login", json={})).status_code == 404
        assert (await client.get("/api/dev/files/x?exp=1&sig=x")).status_code == 404
        assert (await client.get("/docs")).status_code == 404


async def test_dev_seed_is_idempotent_and_loginable(ctx: Ctx, dev_password: str) -> None:
    first = await seed(ctx.sm, ctx.settings)
    counts = await ctx.sql("SELECT (SELECT count(*) FROM profiles), (SELECT count(*) FROM people), "
                           "(SELECT count(*) FROM bills), (SELECT count(*) FROM bill_items), "
                           "(SELECT count(*) FROM fx_rates), (SELECT count(*) FROM bill_participants)")
    # Simulate an E2E run mutating seeded data, then re-seed.
    token = (await _login(ctx, "george", dev_password)).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    hotpot = first.bill_ids[0]
    await ctx.client.patch(f"/api/bills/{hotpot}", headers=h, json={"title": "changed by a test"})
    second = await seed(ctx.sm, ctx.settings)
    assert second == first
    assert await ctx.sql("SELECT (SELECT count(*) FROM profiles), (SELECT count(*) FROM people), "
                         "(SELECT count(*) FROM bills), (SELECT count(*) FROM bill_items), "
                         "(SELECT count(*) FROM fx_rates), (SELECT count(*) FROM bill_participants)") == counts
    assert counts[0][:3] == (5, 10, 3)  # 5 users (+5 self people, +5 saved people for george), 3 bills

    bills = {b["title"]: b for b in (await ctx.client.get("/api/bills", headers=h)).json()["items"]}
    assert set(bills) == {"Saturday hotpot", "Kyoto ramen night", "Team lunch"}
    hot = (await ctx.client.get(f"/api/bills/{hotpot}", headers=h)).json()
    assert hot["status"] == "complete" and hot["validation"]["ok"] and hot["split"]["is_complete"]
    settled = [p for p in hot["split"]["people"] if p["settled_at"]]
    assert [p["outstanding_cents"] for p in settled] == [0, next(p["effective_total_cents"] for p in settled
                                                                   if p["name"] == "Arjun Nair") - 2000]
    ramen = (await ctx.client.get(f"/api/bills/{first.bill_ids[1]}", headers=h)).json()
    assert ramen["currency"] == "JPY" and ramen["settle_currency"] == "SGD" and ramen["fx_rate"] == "0.0091"
    assert ramen["tax_scenario"] == "tax_inclusive" and ramen["split"]["settle_grand_total_cents"] == 5060
    lunch = (await ctx.client.get(f"/api/bills/{first.bill_ids[2]}", headers=h)).json()
    assert lunch["status"] == "review" and lunch["validation"]["errors"][0]["code"] == "items_subtotal_mismatch"
    saved = (await ctx.client.get("/api/me/fx-rates", headers=h)).json()["items"]
    assert [(r["base"], r["quote"], r["rate"]) for r in saved] == [("JPY", "SGD", "0.0091")]
    summary = (await ctx.client.get("/api/me/summary", headers=h)).json()
    assert summary["home"]["currency"] == "SGD" and summary["home"]["owed_to_me_cents"] > 0
    members = [(await _login(ctx, u, dev_password)).status_code for u in ("maya", "arjun", "lena", "tomas")]
    assert members == [200, 200, 200, 200]
