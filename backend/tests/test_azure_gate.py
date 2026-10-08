"""Azure F0 hard gate: request limiter (fake clock), per-retry policy, provider ceilings,
atomic page reservations under the advisory lock, and the provider-quota pause."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.integrations.azure_ocr import (
    AzureOcrClient,
    OcrError,
    RateLimitWaitExceeded,
    SlidingWindowLimiter,
    is_quota_exhausted,
    make_rate_limit_policy,
)
from app.services import scans as scans_service
from app.services.pipeline import StageFailed
from tests.conftest import AppUser, Ctx, jpeg


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.slept.append(round(seconds, 3))
        self.now += seconds


def limiter(limit: int = 15) -> tuple[SlidingWindowLimiter, FakeClock]:
    clock = FakeClock()
    return SlidingWindowLimiter(limit, 60.0, clock=clock, sleep=clock.sleep), clock


# ------------------------------------------------------------------------- limiter
async def test_limiter_allows_15_per_minute_then_waits() -> None:
    lim, clock = limiter(15)
    for _ in range(15):
        await lim.acquire(90)
    assert clock.slept == []
    await lim.acquire(90)  # 16th: waits until the first slot leaves the window
    assert clock.slept == [60.0] and lim.acquired == 16
    clock.now += 30
    for _ in range(14):
        await lim.acquire(90)
    assert clock.slept == [60.0]  # slots freed as the window slides


async def test_limiter_sliding_window_never_exceeds_limit() -> None:
    lim, clock = limiter(15)
    stamps = []
    for _ in range(100):
        await lim.acquire(1000)
        stamps.append(clock.now)
    for i, t in enumerate(stamps):  # any 60 s window holds at most 15 requests
        assert sum(1 for s in stamps[i:] if s - t < 60) <= 15


async def test_limiter_bounded_wait() -> None:
    lim, clock = limiter(2)
    await lim.acquire(90)
    await lim.acquire(90)
    with pytest.raises(RateLimitWaitExceeded):
        await lim.acquire(10)  # next slot is 60 s away
    lim.block_for(200)  # e.g. a 429 with Retry-After: 200
    clock.now += 61
    with pytest.raises(RateLimitWaitExceeded):
        await lim.acquire(90)  # 139 s left > 90 s allowed
    await lim.acquire(150)
    assert clock.now == 1200


# ------------------------------------------------------------------------- azure-core policy
class FakeTransport:
    def __init__(self, statuses: list[tuple[int, dict[str, str]]]) -> None:
        self.statuses = statuses
        self.sent: list[str] = []

    async def __aenter__(self):  # noqa: ANN204
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def send(self, request, **kwargs):  # noqa: ANN001, ANN201
        self.sent.append(request.method)
        status, headers = self.statuses.pop(0) if self.statuses else (200, {})
        return SimpleNamespace(status_code=status, headers=headers, request=request)


async def test_policy_takes_a_slot_for_post_and_every_poll() -> None:
    from azure.core.pipeline import AsyncPipeline
    from azure.core.rest import HttpRequest

    lim, clock = limiter(15)
    transport = FakeTransport([(202, {}), (200, {}), (200, {}), (200, {})])
    pipeline = AsyncPipeline(transport, policies=[make_rate_limit_policy(lim, 90)])  # type: ignore[arg-type]
    await pipeline.run(HttpRequest("POST", "https://x.cognitiveservices.azure.com/analyze"))
    for _ in range(3):
        await pipeline.run(HttpRequest("GET", "https://x.cognitiveservices.azure.com/analyzeResults/1"))
    assert transport.sent == ["POST", "GET", "GET", "GET"] and lim.acquired == 4


async def test_policy_backs_off_after_429_retry_after() -> None:
    from azure.core.pipeline import AsyncPipeline
    from azure.core.rest import HttpRequest

    lim, clock = limiter(15)
    transport = FakeTransport([(429, {"Retry-After": "30"}), (200, {})])
    pipeline = AsyncPipeline(transport, policies=[make_rate_limit_policy(lim, 90)])  # type: ignore[arg-type]
    await pipeline.run(HttpRequest("GET", "https://x/analyzeResults/1"))
    assert clock.slept == []
    await pipeline.run(HttpRequest("GET", "https://x/analyzeResults/1"))
    assert clock.slept == [30.0]  # everyone waits out Retry-After before the next request


async def test_azure_client_wires_policy_per_retry_and_slow_polling(monkeypatch: pytest.MonkeyPatch) -> None:
    from azure.core.pipeline.policies import AsyncRetryPolicy

    client = AzureOcrClient("https://example.cognitiveservices.azure.com", "not-a-real-key", max_concurrency=1,
                            max_pdf_pages=2, timeout_seconds=30, calls_per_minute=15, poll_interval_seconds=3)
    try:
        policies = client._client._client._pipeline._impl_policies  # noqa: SLF001
        kinds = [type(p).__name__ for p in policies]
        retry_at = next(i for i, p in enumerate(policies) if isinstance(p, AsyncRetryPolicy))
        assert policies.index(client.rate_policy) > retry_at, kinds  # per-retry: every attempt pays a slot
        seen: dict[str, object] = {}

        class Poller:
            async def result(self):  # noqa: ANN202
                return SimpleNamespace(content="TOTAL 1.00", pages=[object()])

        async def fake_begin(model_id, body, **kwargs):  # noqa: ANN001, ANN202
            seen.update(kwargs)
            return Poller()

        monkeypatch.setattr(client._client, "begin_analyze_document", fake_begin)  # noqa: SLF001
        result = await client.analyze(b"\xff\xd8\xff", "image/jpeg")
        assert result.pages == 1 and seen["polling_interval"] == 3 and seen["pages"] is None
    finally:
        await client.aclose()


def test_quota_exhausted_detection() -> None:
    assert is_quota_exhausted(403, "Out of call volume quota for FormRecognizer F0 pricing tier.")
    assert is_quota_exhausted(401, "Quota exceeded")
    assert not is_quota_exhausted(401, "Access denied due to invalid subscription key")
    assert not is_quota_exhausted(429, "quota")


# ------------------------------------------------------------------------- provider ceilings
async def test_admin_cannot_exceed_provider_page_limit(ctx: Ctx) -> None:
    admin = await ctx.user("root", role="admin")
    r = await ctx.client.patch("/api/admin/settings", headers=admin.headers, json={"global_monthly_page_cap": 501})
    assert r.status_code == 422 and r.json()["code"] == "page_cap_above_provider_limit"
    assert "500" in r.json()["detail"]
    s = (await ctx.client.patch("/api/admin/settings", headers=admin.headers,
                                json={"global_monthly_page_cap": 500})).json()
    assert s["global_monthly_page_cap"] == 500
    assert s["provider"] == {"azure_di_monthly_page_limit": 500, "azure_di_calls_per_minute_limit": 20,
                             "azure_di_calls_per_minute": 15, "effective_monthly_page_cap": 500,
                             "provider_paused_month": None}
    default = (await ctx.client.patch("/api/admin/settings", headers=admin.headers,
                                      json={"global_monthly_page_cap": 450})).json()
    assert default["provider"]["effective_monthly_page_cap"] == 450


async def test_effective_cap_is_min_of_admin_cap_and_provider_limit(ctx: Ctx) -> None:
    user = await ctx.user()
    old = ctx.settings.azure_di_monthly_page_limit
    ctx.settings.azure_di_monthly_page_limit = 1  # provider ceiling below the admin's 450
    try:
        bill = (await ctx.client.post("/api/bills", headers=user.headers, json={})).json()["id"]
        r = await ctx.client.post(f"/api/bills/{bill}/scans", headers=user.headers,
                                  files=[("files", ("a.jpg", jpeg(), "image/jpeg")), ("files", ("b.jpg", jpeg(), "image/jpeg"))])
        assert r.status_code == 429 and r.json()["code"] == "quota_global_page_cap"
        assert ctx.ocr.calls == 0
    finally:
        ctx.settings.azure_di_monthly_page_limit = old


def test_calls_per_minute_never_above_provider_limit() -> None:
    from app.config import Settings

    assert Settings(azure_di_calls_per_minute=50).azure_calls_per_minute_effective == 20
    assert Settings().azure_calls_per_minute_effective == 15


async def test_guard_blocks_azure_call_at_the_hard_monthly_limit(ctx: Ctx) -> None:
    await ctx.sql("INSERT INTO usage_events (kind, provider, model, pages, ok) VALUES ('ocr', 'azure', 'x', 500, true)")
    with pytest.raises(StageFailed) as exc:
        await ctx.services.runner._guard_azure_call(1)  # noqa: SLF001
    assert exc.value.code == "quota_global_page_cap"


# ------------------------------------------------------------------------- atomic reservations
async def _two_photo_scan(ctx: Ctx, user: AppUser):  # noqa: ANN202
    bill = (await ctx.client.post("/api/bills", headers=user.headers, json={})).json()["id"]
    return await ctx.client.post(f"/api/bills/{bill}/scans", headers=user.headers,
                                 files=[("files", ("a.jpg", jpeg(), "image/jpeg")),
                                        ("files", ("b.jpg", jpeg(), "image/jpeg"))])


async def test_parallel_reservations_near_the_cap_only_one_wins(ctx: Ctx, monkeypatch: pytest.MonkeyPatch) -> None:
    admin = await ctx.user("root", role="admin")
    a, b = await ctx.user("alice"), await ctx.user("bob")
    await ctx.client.patch("/api/admin/settings", headers=admin.headers, json={"global_monthly_page_cap": 2})
    ctx.ocr.delay = 5  # keep the winner's job (and its reservation) active
    real = scans_service.quota_state

    async def slow_quota_state(*args, **kwargs):  # noqa: ANN202 - widens the race window
        state = await real(*args, **kwargs)
        await asyncio.sleep(0.3)
        return state

    monkeypatch.setattr(scans_service, "quota_state", slow_quota_state)
    r1, r2 = await asyncio.gather(_two_photo_scan(ctx, a), _two_photo_scan(ctx, b))
    codes = sorted([r1.status_code, r2.status_code])
    assert codes == [202, 429], (r1.text, r2.text)
    loser = r1 if r1.status_code == 429 else r2
    assert loser.json()["code"] == "quota_global_page_cap"
    assert await ctx.sql("SELECT pages_reserved FROM extraction_jobs") == [(2,)]  # only the winner reserved
    assert (await ctx.sql("SELECT count(*) FROM receipt_files"))[0][0] == 2  # loser's uploads cleaned up
    winner = r1 if r1.status_code == 202 else r2
    owner = a if winner is r1 else b
    await ctx.client.post(f"/api/jobs/{winner.json()['job_id']}/cancel", headers=owner.headers)
    assert await ctx.sql("SELECT pages_reserved FROM extraction_jobs") == [(0,)]  # released


async def test_reservation_released_into_billed_pages(ctx: Ctx) -> None:
    user = await ctx.user()
    r = await _two_photo_scan(ctx, user)
    assert r.status_code == 202
    await ctx.drain()
    assert await ctx.sql("SELECT status, pages_reserved, pages_billed FROM extraction_jobs") == [("succeeded", 0, 2)]
    usage = (await ctx.client.get("/api/me/usage", headers=user.headers)).json()
    assert usage["pages_used"] == 2 and usage["pages_remaining"] == 28


# ------------------------------------------------------------------------- provider quota pause
async def test_provider_quota_pauses_scans_for_the_month(ctx: Ctx) -> None:
    admin = await ctx.user("root", role="admin")
    user = await ctx.user()
    ctx.ocr.fail_with = OcrError("provider_quota", "Out of call volume quota", retryable=False)
    bill = (await ctx.client.post("/api/bills", headers=user.headers, json={})).json()["id"]
    photo = jpeg("same")
    job_id = (await ctx.client.post(f"/api/bills/{bill}/scans", headers=user.headers,
                                    files=[("files", ("a.jpg", photo, "image/jpeg"))])).json()["job_id"]
    await ctx.drain()
    job = (await ctx.client.get(f"/api/jobs/{job_id}", headers=user.headers)).json()
    assert job["status"] == "failed" and job["error_code"] == "provider_quota" and not job["retryable"]
    assert "enter the bill manually" in job["error_message"]
    assert ctx.ocr.calls == 1  # no retries against an exhausted quota
    usage = (await ctx.client.get("/api/me/usage", headers=user.headers)).json()
    assert usage["scans_paused"] and usage["pause_reason"] == "provider_quota"
    r = await ctx.client.post(f"/api/bills/{bill}/scans", headers=user.headers,
                              files=[("files", ("b.jpg", jpeg(), "image/jpeg"))])
    assert r.status_code == 429 and r.json()["code"] == "quota_provider_quota"
    manual = await ctx.client.put(f"/api/bills/{bill}/receipt", headers=user.headers, json={
        "items": [{"name": "Tea", "unit_price_cents": 250, "total_price_cents": 250}], "grand_total_cents": 250})
    assert manual.status_code == 200
    s = (await ctx.client.get("/api/admin/settings", headers=admin.headers)).json()
    assert s["provider"]["provider_paused_month"] == usage["month"]
    # Admin clears a false alarm → scanning resumes.
    ctx.ocr.fail_with = None
    await ctx.client.patch("/api/admin/settings", headers=admin.headers, json={"provider_paused": False})
    r = await ctx.client.post(f"/api/bills/{bill}/scans", headers=user.headers,
                              files=[("files", ("b.jpg", jpeg(), "image/jpeg"))])
    assert r.status_code == 202
