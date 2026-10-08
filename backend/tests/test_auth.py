"""JWT verification (HS256 + JWKS/ES256), provisioning, disabled users, temp passwords, admin gate."""

from __future__ import annotations

import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from app.config import Settings
from app.errors import AppError
from app.middleware.auth import JWKSCache, verify_token
from tests.conftest import Ctx, token_for


async def test_health_needs_no_auth(ctx: Ctx) -> None:
    r = await ctx.client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    r = await ctx.client.get("/api/health/ready")
    assert r.status_code == 200 and r.json()["db"] == "ok"


async def test_missing_and_malformed_tokens_are_401(ctx: Ctx) -> None:
    r = await ctx.client.get("/api/me")
    assert r.status_code == 401 and r.json()["code"] == "missing_token"
    r = await ctx.client.get("/api/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert r.status_code == 401 and r.json()["code"] == "invalid_token"
    r = await ctx.client.get("/api/me", headers={"Authorization": "Basic abc"})
    assert r.status_code == 401


async def test_bad_signature_expired_and_wrong_audience(ctx: Ctx) -> None:
    user = await ctx.user()
    forged = token_for(user.id, secret="some-other-secret-that-is-long-enough")
    r = await ctx.client.get("/api/me", headers={"Authorization": f"Bearer {forged}"})
    assert r.status_code == 401 and r.json()["code"] == "invalid_token"

    expired = token_for(user.id, exp_in=-3600)
    r = await ctx.client.get("/api/me", headers={"Authorization": f"Bearer {expired}"})
    assert r.status_code == 401 and r.json()["code"] == "token_expired"

    wrong_aud = token_for(user.id, aud="anon")
    r = await ctx.client.get("/api/me", headers={"Authorization": f"Bearer {wrong_aud}"})
    assert r.status_code == 403 and r.json()["code"] == "invalid_audience"


async def test_alg_none_is_rejected(ctx: Ctx) -> None:
    user = await ctx.user()
    token = jwt.encode({"sub": str(user.id), "aud": "authenticated", "exp": int(time.time()) + 60}, None,
                       algorithm="none")
    r = await ctx.client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


async def test_valid_token_without_profile_is_not_provisioned(ctx: Ctx) -> None:
    r = await ctx.client.get("/api/me", headers={"Authorization": f"Bearer {token_for(uuid.uuid4())}"})
    assert r.status_code == 403 and r.json()["code"] == "not_provisioned"


async def test_disabled_user_is_403(ctx: Ctx) -> None:
    user = await ctx.user("dora", disabled=True)
    r = await ctx.client.get("/api/me", headers=user.headers)
    assert r.status_code == 403 and r.json()["code"] == "account_disabled"


async def test_temp_password_must_be_changed_first(ctx: Ctx) -> None:
    user = await ctx.user("newbie", must_change=True)
    me = await ctx.client.get("/api/me", headers=user.headers)
    assert me.status_code == 200 and me.json()["must_change_password"] is True
    r = await ctx.client.get("/api/bills", headers=user.headers)
    assert r.status_code == 403 and r.json()["code"] == "password_change_required"
    r = await ctx.client.post("/api/me/password-changed", headers=user.headers)
    assert r.status_code == 200 and r.json()["must_change_password"] is False
    assert (await ctx.client.get("/api/bills", headers=user.headers)).status_code == 200


async def test_me_returns_profile_and_self_person(ctx: Ctx) -> None:
    user = await ctx.user("alice")
    body = (await ctx.client.get("/api/me", headers=user.headers)).json()
    assert body["username"] == "alice" and body["role"] == "member"
    assert body["self_person_id"] == str(user.self_person_id)
    r = await ctx.client.patch("/api/me", headers=user.headers, json={"display_name": "Ally", "default_currency": "myr"})
    assert r.status_code == 200 and r.json()["display_name"] == "Ally" and r.json()["default_currency"] == "MYR"
    people = (await ctx.client.get("/api/people", headers=user.headers)).json()["items"]
    assert people[0]["is_self"] and people[0]["name"] == "Ally"


async def test_admin_routes_require_admin(ctx: Ctx) -> None:
    member = await ctx.user("bob")
    admin = await ctx.user("root", role="admin")
    assert (await ctx.client.get("/api/admin/users", headers=member.headers)).json()["code"] == "admin_only"
    assert (await ctx.client.get("/api/admin/users", headers=member.headers)).status_code == 403
    assert (await ctx.client.get("/api/admin/users", headers=admin.headers)).status_code == 200


async def test_es256_tokens_via_jwks(ctx: Ctx) -> None:
    user = await ctx.user("eve")
    key = ec.generate_private_key(ec.SECP256R1())
    jwk = jwt.algorithms.ECAlgorithm.to_jwk(key.public_key(), as_dict=True)
    jwk.update({"kid": "kid-1", "alg": "ES256", "use": "sig"})
    cache = JWKSCache("https://example.invalid/jwks.json", 600)
    cache.set_keys({"kid-1": jwt.PyJWK(jwk)})
    ctx.app.state.jwks = cache

    now = int(time.time())
    claims = {"sub": str(user.id), "aud": "authenticated", "exp": now + 600, "iat": now}
    good = jwt.encode(claims, key, algorithm="ES256", headers={"kid": "kid-1"})
    assert (await ctx.client.get("/api/me", headers={"Authorization": f"Bearer {good}"})).status_code == 200

    other = ec.generate_private_key(ec.SECP256R1())
    forged = jwt.encode(claims, other, algorithm="ES256", headers={"kid": "kid-1"})
    assert (await ctx.client.get("/api/me", headers={"Authorization": f"Bearer {forged}"})).status_code == 401
    unknown_kid = jwt.encode(claims, key, algorithm="ES256", headers={"kid": "kid-unknown"})
    r = await ctx.client.get("/api/me", headers={"Authorization": f"Bearer {unknown_kid}"})
    assert r.status_code == 401


async def test_issuer_is_checked_when_supabase_url_is_set() -> None:
    settings = Settings(supabase_url="https://proj.supabase.co", supabase_jwt_secret="s" * 40)
    uid = uuid.uuid4()
    ok = token_for(uid, secret="s" * 40, iss="https://proj.supabase.co/auth/v1")
    assert (await verify_token(ok, settings, None)).user_id == uid
    bad = token_for(uid, secret="s" * 40, iss="https://evil.supabase.co/auth/v1")
    with pytest.raises(AppError) as exc:
        await verify_token(bad, settings, None)
    assert exc.value.status_code == 401


async def test_hs256_rejected_without_secret() -> None:
    settings = Settings(supabase_jwt_secret="")
    with pytest.raises(AppError):
        await verify_token(token_for(uuid.uuid4()), settings, None)


# ------------------------------------------------------------------------- live Supabase session (7-day tokens)
async def test_long_lived_token_needs_a_live_supabase_session(ctx: Ctx, monkeypatch) -> None:
    """Production uses 7-day access tokens; signing out (session row deleted) must still end them."""
    user = await ctx.user()
    live, ended, expired = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await ctx.sql("CREATE SCHEMA IF NOT EXISTS auth")
    await ctx.sql("CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL, "
                  "not_after timestamptz)")
    try:
        await ctx.sql("INSERT INTO auth.sessions (id, user_id, not_after) VALUES (:a, :u, NULL), "
                      "(:b, :u, now() - interval '1 minute')", a=live, b=expired, u=user.id)

        def get_me(**claims: object) -> object:
            token = token_for(user.id, exp_in=7 * 24 * 3600, **claims)
            return ctx.client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

        assert (await get_me(session_id=str(ended))).status_code == 200  # check off: unaffected
        monkeypatch.setattr(ctx.settings, "auth_require_live_session", True)
        assert (await get_me(session_id=str(live))).status_code == 200
        for claims in ({"session_id": str(ended)}, {"session_id": str(expired)}, {"session_id": "nope"}, {}):
            r = await get_me(**claims)
            assert r.status_code == 401 and r.json()["code"] == "session_ended", (claims, r.text)
        other = await ctx.user("other")
        r = await ctx.client.get("/api/me", headers={"Authorization": f"Bearer {token_for(other.id, session_id=str(live))}"})
        assert r.status_code == 401  # someone else's session id doesn't count
    finally:
        await ctx.sql("DROP SCHEMA auth CASCADE")
