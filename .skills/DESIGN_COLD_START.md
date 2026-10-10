# Design: zero cold starts for the even API — cost and options

> Research note, 2026-10-10. No code changed. Prices were checked on 2026-10-10 (see §6) and can change, so check them again before you spend money.

## 1. Answer up front

| Question | Answer |
|---|---|
| **Zero cold starts all month** | **$7/month.** Move `even-api` from Free to Render's smallest paid compute plan, `starter` / `0.5c-512mb` (0.5 CPU, 512 MB). The Hobby workspace has no fee, so the $7 is the whole bill. It isn't possible for $0 on Render Free: 24/7 is 744 h, and GoodDaysAhead already uses 240–300 of the 750 shared hours. |
| **Zero cold starts for a limited period** | **About $0.23/day, $1.61/week or $2.30 for 10 days.** Render prorates compute to the second ("create a web service on a paid compute plan and turn it off 24 hours later, you are only billed for 24 hours"). Upgrade with 1 API call plus a redeploy, and downgrade the same way. **$0 alternative:** widen the GitHub keep-warm for the period. 24/7 fits for **up to about 9 days a month** with a 50 h safety margin (worst case GoodDaysAhead = 300 h). Waking hours only (07:00–24:00 SGT) fits for a whole trip week with more than 130 h to spare. This gives *near-zero* cold starts, not zero, because GitHub's cron can be late or dropped. |
| **Recommendation** | Keep today's $0 setup for normal months. **For a trip, upgrade to Starter for those days (about $1.60/week).** It guarantees no cold starts, has 5× the CPU, takes nothing from the hours shared with GoodDaysAhead (it frees them), and is two API calls each way. If the owner insists on $0, widen the keep-warm to 07:00–24:00 SGT for the trip week, ping every 5 minutes at off-hour minutes, and check the hour count in the Render dashboard halfway through. Only pay $7/month permanently if cold starts outside peak hours become a real complaint. Migrating hosts (e.g. Fly.io Singapore at about $4.70/month) saves about $2.30/month and isn't worth the migration and an extra account. |

### What exists today (checked in the repo)
- **API:** Render Free, Docker (`backend/Dockerfile.render`, `python:3.12-slim` with FastAPI, uvicorn, SQLAlchemy/asyncpg and the OpenAI and Azure SDKs; no ML or native-heavy deps). Singapore, 1 instance. One uvicorn worker on purpose: scan jobs are in-process asyncio tasks. `render-start.sh` runs `alembic upgrade head` (up to 5 retries) before serving, which adds to every cold start.
- **Keep-warm:** `.github/workflows/cron.yml` runs `GET /api/health` every 10 minutes during 11:30–13:50 and 18:00–22:50 SGT (`30-59/10 3`, `*/10 4-5`, `*/10 10-14` UTC). The instance stays up about 15 min after the last ping, so it's awake ≈ 11:30–14:05 + 18:00–23:05 = **7.67 h/day ≈ 238 h in a 31-day month**. Daily maintenance runs at 12:23 SGT, inside the lunch window. That keeps Supabase Free from its 7-day inactivity pause.
- **Web already softens cold starts:** `web/src/main.tsx` calls `warmUpApi()` (`web/src/lib/api.ts`, a fire-and-forget `GET /api/health` on app load). Any request slower than 2.5 s shows `SlowNetworkBar` ("Waking the server — the first load after a quiet spell can take up to a minute."). The default request timeout is 60 s.
- **Payments:** the repo mentions no paid hosting. Every service is Free.

## 2. Options

Costs are in USD before tax. A "week" is 168 h and a "day" is 24 h, prorated from the monthly price (≈730 h).

| Option | Monthly | Per week / per day | Cold starts | Effort | Risks / notes |
|---|---|---|---|---|---|
| **0. Status quo:** peak keep-warm, wake ping on load, waking bar | $0 | $0 | ~1 min outside 11:30–14:05 and 18:00–23:05 SGT. Occasionally inside them too, when a GitHub ping is late | none | None new |
| **1. Render Starter, permanent** (`starter` = `0.5c-512mb`) | **$7.00** | $1.61 / $0.23 | **None** (always on, zero-downtime deploys) | 1 PATCH + 1 deploy | Card on file. Re-running `render.py` in provisioning mode resets the plan to `free` (`fix_drift`) |
| **2. Render Starter for N days** (recommended for trips) | prorated | **$1.61 / $0.23** | None during the window | 2 API calls to upgrade, 2 to downgrade | Forgetting to downgrade costs $7/month. Each switch is a redeploy, which interrupts any scan in progress (it becomes `interrupted` and is retryable) |
| **3. Wider GitHub keep-warm for the period** | $0 | $0 | Near zero: a ping >5 min late at a 10-min cadence lets the instance sleep. GitHub says schedules "can be delayed" at high load, especially at the top of the hour, and jobs "may be dropped" | Edit `cron.yml` via PR (main is protected), then revert | Overrunning the 750 h suspends **both** apps until the 1st. Must stay within the budget in §3. The free instance has only 0.1 CPU, so it's slower even when warm |
| **3b. Same, pinged by a Cloudflare Worker cron** | $0 | $0 | Closer to zero (1-min granularity, more punctual) | New Worker in the shared Cloudflare account | Same hour budget. The free plan allows 5 cron triggers per account (shared with GoodDaysAhead). Schedule changes take up to 15 min to propagate. Cron runs in UTC |
| Fly.io, `sin`, shared-cpu-1x 512 MB | ≈$4.68 ($3.69 × 1.27 Singapore uplift) | ≈$1.08 / $0.15 | None (if auto-stop is off) | High: new account, card, migrate deploy/CI/secrets | No free tier for new orgs. 256 MB (≈$2.78) is too tight for this image |
| Railway Hobby, Singapore (`asia-southeast1-eqsg3a`) | $5 (includes $5 of usage; this app's RAM/CPU should fit) | n/a (subscription) | None | High: migration | Billed by usage ($10/GB-RAM-month, $20/vCPU-month). The $5 is the floor |
| Northflank `nf-compute-20` (0.2 vCPU, 512 MB) | $5.40 (`nf-compute-10`, 256 MB: $2.70) | ≈$1.24 / $0.18 | None | High: migration | The free Sandbox is "always-on" (2 services), but its regions aren't stated on the pricing page. Check for Singapore before considering it |
| Google Cloud Run, Singapore, min-instances=1 | request-based ≈$5–10 (Tier 1 maths ≈$9.7 before the free tier; Singapore is Tier 2, so more); **instance-based ≈$44+** | — | None | High | **Not a fit:** request-based billing throttles CPU between requests, which starves the in-process scan jobs. Instance-based billing (needed for them) costs about 6× Render Starter |
| Oracle Cloud Always Free (Ampere A1 VM) | $0 | $0 | None | Very high: run your own VM, TLS, Docker, patching | Must be in the home region (choose Singapore at signup). Idle reclaim: if 95th-percentile CPU, network **and** memory all stay under 20 % for 7 days, the VM is reclaimed, and a tiny API looks idle. Capacity is often unavailable. Goes against the playbook's managed-PaaS approach |
| Koyeb Free | $0 | — | **Doesn't solve it:** scales to zero after 1 h idle, Frankfurt/Washington only | — | Rejected |

## 3. Hour budget for the shared Render workspace (Free)

Rules (Render docs): 750 Free instance-hours **per workspace** per calendar month, reset on the 1st. Only time awake counts. When they run out, Render "suspends all of your Free web services until the start of the next month", which would take down both even and GoodDaysAhead. **Paid instances don't use these hours**, so option 1 or 2 also gives GoodDaysAhead more headroom.

Inputs: a month has 720 h (30 days) or 744 h (31 days). GoodDaysAhead (GDA) uses 240–300 h (hourly cron). Below, **300 is used as the worst case**. Awake time per day = the ping window + about 5 min (the last ping lands on :50 and the instance sleeps 15 min later). "Organic" covers wake-ups by real use outside the windows, estimated at about 15–20 h/month. Budget for even = 750 − 300 = **450 h**, or **400 h** with a 50 h safety margin.

| Schedule (31-day month) | even h/month | Total with GDA 300 | Margin to 750 | With GDA 240 | Fits? |
|---|---|---|---|---|---|
| **Current:** 11:30–14:00 + 18:00–23:00 daily (7.67 h/day) + ~20 organic | ≈258 | 558 | **192** | 252 | ✅ |
| 11:00–23:00 daily (12.1 h/day) | 375 | 675 | 75 | 135 | ✅ |
| 10:00–23:00 daily (13.1 h/day) | 406 | 706 | 44 | 104 | ⚠️ only if GDA is measured ≤ 260 h |
| 09:00–23:00 daily (14.1 h/day) | 437 | 737 | 13 | 73 | ❌ too tight |
| 08:00–24:00 daily (16.1 h/day) | 499 | 799 | −49 | 11 | ❌ |
| Weekends 24 h (9 days) + weekday peak (22 days) + ~15 organic | ≈400 | 700 | 50 | 110 | ⚠️ borderline (some months have 10 weekend days → margin ≈34) |
| **Trip week 24/7** (7 days) + peak for the other 24 days + ~15 | ≈367 | 667 | **83** | 143 | ✅ |
| **Trip week 07:00–24:00 SGT** (17.1 h/day × 7) + peak + ~15 | ≈319 | 619 | **131** | 191 | ✅ (best $0 trip option) |
| Trip 14 days 24/7 + peak for 17 days | ≈476 | 776 | −26 | 34 | ❌ |
| Whole month 24/7 | 744 | 1,044 | −294 | −234 | ❌ (impossible on Free) |

**Most 24/7 days that fit in a month** (rest of the month at peak): 24d + 7.67(31 − d) + 15 ≤ 400 gives **d ≤ 9 days** with a 50 h margin, or **d ≤ 12** with no margin. A trip that spans a month boundary splits its hours across two budgets, which makes it easier to fit.

Before widening: check the real usage so far in the Render dashboard (Workspace → Billing → Free usage). GDA's real number decides between the 240 and 300 columns. Afterwards, revert the schedule. The `cron.yml` header comment and `.skills/DEPLOYMENT.md` §7 ask for this recompute.

## 4. How-to: zero cold starts for a limited period

### Option 2 (recommended): Render Starter for the trip, API-driven

Uses the existing Render API key (the owner's `RENDERS_DEVELOPER_TOKEN` → `RENDER_API_KEY`) and `RENDER_SERVICE_ID` (`srv-db3la5rncjis73aslbg0`). Never print the key. Send it only as `Authorization: Bearer …` to `https://api.render.com/v1`.

0. **One-time:** add a payment method to the Render workspace (dashboard → Billing). The Hobby workspace stays $0. Only the compute is billed.
1. **Pick a quiet moment.** A redeploy interrupts any scan in progress (it becomes `interrupted`, can be retried, and OCR isn't billed again).
2. **Upgrade:** `PATCH /services/{RENDER_SERVICE_ID}` with body `{"serviceDetails": {"plan": "starter"}}`. `"0.5c-512mb"` is the new spec-based ID for the same plan; per the 2026-08-26 changelog, both IDs keep working.
3. **Apply it:** the API docs say config changes are "not deployed automatically", so trigger a deploy of the **commit that is already live**, so no unreviewed code ships. `GET /services/{id}/deploys?limit=1` returns the live `commit.id`. Then `POST /services/{id}/deploys` with `{"commitId": "<that sha>"}` and poll `GET /services/{id}/deploys/{deployId}` until `status == "live"`. `python scripts/provision/render.py deploy --commit <sha> --wait` already does this poll.
4. **Verify:** `GET /services/{id}` shows `serviceDetails.plan == "starter"` (or `0.5c-512mb`). Run `python scripts/provision/smoke.py --skip-pages`. Leaving the keep-warm cron as it is costs nothing.
5. **Downgrade when the trip ends:** `PATCH /services/{id}` with `{"serviceDetails": {"plan": "free"}}`, then redeploy the live commit as in step 3. Re-running `python scripts/provision/render.py` (provisioning mode) also does the PATCH, because `fix_drift` forces `plan: free`, but it doesn't deploy. Follow it with `render.py deploy --commit <live sha> --wait`. Render's own help says a service can be switched back to `free` from the dashboard (Settings → Change instance type).
6. **Guard against forgetting:** set a calendar reminder for the last day. Optionally, a scheduled cloud agent or a dated GitHub workflow could do step 5. Forgetting costs $7/month, and nothing breaks.
7. **Caveat:** while on Starter, don't run `bootstrap.py` / `all.py` / `render.py` in provisioning mode unless you mean to downgrade. The deploy workflow only uses `render.py deploy`, so normal deploys are safe.

### Option 3 ($0): wider keep-warm for the period

- **Today, no code design change:** open a PR that changes the `schedule:` lines in `.github/workflows/cron.yml`, merge it (main needs the PR and green CI; schedules run only from the default branch), then open a revert PR after the trip. For a trip week at 07:00–24:00 SGT (23:00–16:00 UTC), use 5-minute pings that avoid :00, for example `"2-57/5 23 * * *"` plus `"2-57/5 0-15 * * *"`. For 24/7, use `"2-57/5 * * * *"`. GitHub's minimum is 5 min. The docs now also allow an IANA timezone on a schedule, so the windows could be written in SGT directly. Check the syntax before relying on it.
- **Make it API-driven in a later PR (suggested design, not built):** keep a single `*/5` (offset) schedule and add a first step that pings only when the time is inside the peak windows **or** before the repo variable `KEEP_WARM_UNTIL` (ISO timestamp, SGT). Turning on a trip is then one API call, `PATCH /repos/LAJINVSHEN/bill_splitter/actions/variables/KEEP_WARM_UNTIL` (or `gh variable set KEEP_WARM_UNTIL --body 2026-11-07T23:59+08:00`). It expires by itself, so nobody can forget to revert, and no PR is needed. The step should also refuse an end date more than 9 days out, the budget limit from §3. Minutes are free while the repo is public. In a private repo, 288 runs a day would exceed the 2,000 free minutes.
- **More punctual pinger (3b):** a tiny Cloudflare Worker with a cron trigger (UTC, 1-min granularity) that runs `GET /api/health`. It lives in the shared Cloudflare account and can be created and changed through the Cloudflare API (Workers script upload + cron-trigger schedules). It counts against the account's 5 free cron triggers.
- **Halfway through the window:** check Free usage in the Render dashboard, and narrow the window if it's tracking above the §3 numbers.

## 5. Cheaper ways to make cold starts *feel* shorter (no always-on)

| Idea | Status | Value |
|---|---|---|
| Wake ping on app load | **Already done** (`warmUpApi()` in `main.tsx`) | The API wakes while the login/home screen renders. That hides about 1 min only if the user lingers. |
| "Waking up" UI | **Already done** (`SlowNetworkBar` after 2.5 s, 60 s timeout) | Already calm wording |
| Show cached data instantly | Not done | Persisting the TanStack Query cache to `localStorage` (`@tanstack/react-query-persist-client` + sync-storage persister) would show the last-seen bills/people immediately while the API wakes. Effort is small. Keep it read-only, and exclude sensitive or admin queries. |
| Wake earlier in the flow | Partly | Also call `warmUpApi()` on `visibilitychange`/focus when the tab has been hidden for more than 15 min, so a returning user starts the wake-up before tapping anything. |
| Cloudflare caching of `/s/:token` share pages | Low value | The SPA shell is already static on Pages. The share *data* comes from the Render API (`onrender.com`, not proxied by Cloudflare), so edge caching would need a Pages Function proxy with a cache and invalidation. That's not worth it for this app. |
| Shorter cold start itself | Optional | `render-start.sh` runs `alembic upgrade head` on every boot, including wake-ups from sleep. Running migrations only in the deploy workflow (it already runs `alembic upgrade head` against prod before deploying) would cut a few seconds from each wake. That's a separate change that needs review, because the start script is the safety net. |

### Other caveats
- **Supabase Free 7-day pause:** not affected by any option. The daily maintenance cron queries the DB. But **GitHub disables scheduled workflows in a public repo after 60 days without repository activity.** That stops both the keep-warm and maintenance, and Supabase would pause 7 days later. A Cloudflare Worker cron (3b) doesn't have that 60-day rule.
- **Render Hobby workspace:** since 2026-08-01 it includes **5 GB of bandwidth**, with overage at $0.15/GB (per a third-party review; check it in the dashboard). This applies whichever plan the service is on. Receipt photos go to Supabase Storage, so API egress should be small.
- **Tax:** Render may add local tax (e.g. Singapore GST) on top of the $7.
- **The exact proration basis** (calendar month vs ≈730 h) isn't published. Per-day figures could differ by a cent or two.

## 6. Sources (all seen 2026-10-10)

- Render pricing (Hobby $0 / Pro $25 / Scale $499 workspace; compute Free $0 512 MB 0.1 CPU, `0.5c-512mb` Starter $7 512 MB 0.5 CPU, `1c-2g` $25; "billing is prorated to the second … turn it off 24 hours later, you are only billed for 24 hours") — https://render.com/pricing (page `_updatedAt` 2026-10-08)
- Render Free (15 min spin-down, ~1 min spin-up, 750 h per workspace, suspend all Free services when exhausted, monthly reset) — https://render.com/docs/free
- Render compute plans (plan IDs, changing a plan triggers a deploy in the dashboard; API needs a separate deploy) — https://render.com/docs/compute-plans
- Render changelog, new compute-plan IDs (2026-08-26; legacy IDs keep working) — https://render.com/changelog/new-compute-plans-and-new-ids-for-existing-plans
- Render API, Update service (`serviceDetails.plan` enum includes `starter`, `free`, `0.5c-512mb`; "Changes will not be deployed automatically") — https://api-docs.render.com/reference/update-service
- Render help on switching a paid instance back to Free (dashboard → Settings → Change instance type) — https://community.render.com/t/can-i-downgrade-from-a-paid-tier-if-it-doesnt-work/35107 (via search summary; the page itself didn't load)
- Render Hobby 1 Aug 2026 changes (5 GB bandwidth, paid compute allowed on Hobby), third-party — https://jwatte.com/blog/render-com-platform-review.md · https://livemy.app/blog/render-pricing
- GitHub Actions `schedule` (delays at high load / top of hour, dropped jobs, 5-min minimum, IANA timezone, default branch, 60-day disable) — https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- Cloudflare Workers limits (Free: 5 cron triggers/account, 100k requests/day) — https://developers.cloudflare.com/workers/platform/limits/ · Cron Triggers (UTC, up to 15 min propagation) — https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Fly.io pricing (no free tier for new orgs; shared-cpu-1x 256 MB $2.19, 512 MB $3.69; Singapore ×1.269; card required) — https://docs.fly.io/about/pricing
- Railway plans (Hobby $5 incl. $5 usage; $10/GB RAM, $20/vCPU per month) — https://docs.railway.com/reference/pricing/plans · regions (Singapore `asia-southeast1-eqsg3a`) — https://docs.railway.com/reference/deployment-regions
- Northflank pricing (Sandbox always-on, 2 services; `nf-compute-10` $2.70, `nf-compute-20` $5.40) — https://northflank.com/pricing
- Koyeb (free instance Frankfurt/Washington only, scale-to-zero after 1 h; card required since Feb 2026) — https://www.koyeb.com/pricing and search summary of https://www.koyeb.com/docs/faqs/pricing
- Google Cloud Run pricing (instance-based $0.000018/vCPU-s, $0.000002/GiB-s; request-based min-instance idle $0.0000025/vCPU-s; free tier; asia-southeast1 = Tier 2) — https://cloud.google.com/run/pricing
- Oracle Always Free (A1 = 2 OCPU / 12 GB for Always Free tenancies; home region only; idle reclaim < 20 % CPU/network/memory over 7 days) — https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Supabase Free project pausing (inactive after about a week without DB activity) — https://supabase.com/docs/guides/platform/free-project-pausing
