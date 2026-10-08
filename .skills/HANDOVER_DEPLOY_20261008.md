# Production deployment handoff (2026-10-08)

**even is live:** https://even-split.pages.dev (SPA, Cloudflare Pages) → https://even-api-183n.onrender.com (FastAPI, Render Free, Singapore) → Supabase project `even` (`inkmavvduytpsitevqru`, ap-southeast-1, Free). Everything was created through the providers' developer APIs with `scripts/provision/*` and runs on free tiers. Runbook: [DEPLOYMENT.md](DEPLOYMENT.md).

## Owner decisions (2026-10-08)

| Decision | Choice | Why |
|---|---|---|
| Accounts | Shared with GoodDaysAhead: same Supabase org, Render workspace and Cloudflare account; separate project/service/Pages project | Owner's accounts |
| Keep-warm | Peak hours only: 11:30–14:00 and 18:00–23:00 SGT (~240 h/month) | Render's 750 free hours are **per workspace**, and GoodDaysAhead's hourly cron uses ~240–300 h. Over 750 suspends both apps |
| URL | `even-split.pages.dev` | `even.pages.dev` is taken |
| Deploy auth | Render API key in the GitHub `production` environment (main only) | Owner: create everything through the developer APIs |
| Merge | PR #2 merged into `main` with a merge commit (`652bc6e`); `main` is the trunk | |

## What was provisioned

| Layer | Resource | Hardening |
|---|---|---|
| Cloudflare | Pages project `even-split`, Direct Upload (no Git builds) | Token account-scoped; deploys only from Actions |
| Supabase | Project `even`, ES256 signing keys, publishable/secret API keys, session pooler (IPv4, 5432), private `receipts` bucket (4 MB, JPEG/PNG/HEIF/PDF) | Signups **disabled**, phone/anonymous off, password ≥ 8, refresh-token rotation, Site URL + 15-URL redirect allow-list; RLS deny-all on every `public` table and Data API roles without grants |
| Render | `even-api` (`srv-db3la5rncjis73aslbg0`): Docker `backend/Dockerfile.render`, Free, 1 instance, health `/api/health`, auto-deploy **off**, PR previews off | 20 env vars, production `CRON_SECRET` ≠ dev, no dev-only values; migrations at start with retries |
| GitHub | `production` environment (deployments from `main` only) with secrets `VITE_*`, `CLOUDFLARE_*`, `RENDER_API_KEY`, `RENDER_SERVICE_ID`; repo secret `CRON_SECRET` only; variables `API_BASE_URL`, `PAGES_URL`, `CLOUDFLARE_PROJECT_NAME`, `CLOUD_DEPLOY_ENABLED=true` | Deploy credentials are unreachable from other branches and fork PRs |
| Admin | `george` (admin, `george@users.even.app`), `must_change_password` | Temporary password is only in the gitignored `.local/ADMIN_FIRST_LOGIN.txt` |

## CI/CD

| Workflow | Trigger | Result on first run |
|---|---|---|
| `ci.yml` | PR + push to `main` | Green on `f208d58` and `a96d1b5` (backend + migrations up/down/up + image build; frontend typecheck/lint/build/tests; E2E desktop + Pixel 5) |
| `deploy-backend-render.yml` | push to `main` (backend/shared/render paths) + manual | Green: tests → deploy exact commit `a96d1b5` → smoke |
| `deploy-frontend-cloudflare.yml` | push to `main` (web/shared paths) + manual | Green (run 37751302832) |
| `cron.yml` | peak-hour keep-warm, maintenance 12:23 SGT | Manual maintenance green: `{"purged_files":0,"purge_failures":0,"failed_stale_jobs":0,"db":"ok"}` |

Kill switch: `python scripts/provision/github.py --disable-deploy`. Rollback: see DEPLOYMENT.md §6.

## Verification (production, 2026-10-08)

- `smoke.py --maintenance-guard`: **7/7** (health with commit, DB readiness, CORS preflight from Pages, foreign origin rejected, Pages 200, SPA deep link, maintenance 401 without secret).
- Negative security probes: dev login 404; anon key gets **401** on `profiles`, `bills`, `ocr_cache`, `usage_events`, `alembic_version`; public signup 422 `signup_disabled`; bucket not publicly readable; API 401 without a token.
- Supabase security advisor: 15 findings, all INFO `rls_enabled_no_policy`. This is the intended deny-all design, because the browser never queries Postgres.
- Real auth: password sign-in (ES256) → `GET /api/me` (admin, must change password) → refresh rotation. The probe's sessions were then revoked globally.

## Fixed while provisioning

- Render's API rejects `autoDeploy` together with `autoDeployTrigger`; `render.py` now sends only the latter.
- Deploy secrets moved from repo level into the `production` environment (`github.py`).
- Scripts accept the owner's token names; canonical repo `LAJINVSHEN/bill_splitter`.

## Follow-up the same day: long sessions, Google, full production scan, hardening

**Sessions (owner decision: 7-day tokens).** Supabase `jwt_exp` = 604800 (the max). Sessions have no timebox or inactivity limit and refresh silently, so people sign in once. To keep revocation, the API also requires the token's `session_id` to exist in `auth.sessions` (`AUTH_REQUIRE_LIVE_SESSION=true`, forced by `render.py`). Signing out, or deleting/disabling an account, takes effect immediately. Verified in production: the token lifetime was 168 h; the old token returned 200 before sign-out and **401 `session_ended`** right after. Caveat: iPhone Safari wipes website storage after 7 days without a visit unless the app is added to the Home Screen.

**Full production scan (owner-approved; temporary member created and deleted from the prod image).** Real Chromium against https://even-split.pages.dev, run twice:
temporary password → forced change → "Scan or upload" → upload → people step while reading (~17–18 s) → Review: **2 items** matching the adjudicated truth, with the bundle components folded in ("with …"), and the receipt photo loads from Supabase Storage (1500 px) → assign everyone → Summary SGD 22.50, 11.25 each → permanent delete → sign-out revokes the token. No page errors. Then the account was deleted through the admin service: 0 rows left in profiles/bills/people/receipt_files/ocr_cache/auth.users, and the anonymised usage was kept. **Cost: 2 Azure F0 pages, $0.000842 OpenAI.** A Storage probe also confirmed the signed URLs: 200 `image/jpeg`, CORS `*`.

**Hardening.** Secret scanning + push protection are on. A full-history scan for key patterns found nothing. `main` is protected: PR + green `Backend`, `Frontend` and `E2E` checks, strict, admins included, no force-push or deletion. The legacy `frontend/` app was removed from the repo.

**Google sign-in.** The app and Supabase sides are ready (PKCE, `openid email profile`; only Gmail addresses the admin pre-creates can get in, because signups stay disabled). The Google OAuth client itself must be created by the owner (no public API), see below. `supabase.py google` then enables the provider and **verifies** that Supabase redirects to Google with that client and the callback.

## Owner to-do

1. **Google sign-in** (about 5 min, https://console.cloud.google.com):
   1. Create project **even**.
   2. *Google Auth Platform → Branding*: app name **even**, your support email, developer contact email.
   3. *Audience*: **External**, then **Publish app** (basic scopes need no Google review; Supabase signups stay off, so publishing doesn't open the app to strangers).
   4. *Data access*: keep only `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`.
   5. *Clients → Create client → Web application* "even web": **Authorized JavaScript origins** `https://even-split.pages.dev`, `http://localhost:5173`, `http://127.0.0.1:5173`; **Authorized redirect URI** `https://inkmavvduytpsitevqru.supabase.co/auth/v1/callback`.
   6. Put `GOOGLE_CLIENT_ID=` and `GOOGLE_CLIENT_SECRET=` in the root `.env` (never in chat), then run `python scripts/provision/supabase.py google` (or ask the agent to). It must print `[PASS]`.
   7. In /admin, create each Google user with **Signs in with: Google** and their real Gmail.
2. **Sign in** as `george` with the password in `.local/ADMIN_FIRST_LOGIN.txt`, set your own password, then delete the file.
3. **OpenAI:** set a project spend limit slightly above the app's monthly AI budget ($5 default, /admin). There's no API for this.
4. Create friends' accounts in /admin, and suggest **Add to Home Screen** on iPhones.

## What's left (dev + prod + CI/CD), as of 2026-10-08

| Area | Item | Status / suggestion |
|---|---|---|
| Prod | Google OAuth client | Owner step 1 above |
| Prod | Backups | **None** (Supabase Free; owner declined weekly encrypted dumps for now). Bills would be lost if the project were lost. Revisit before friends rely on history |
| Prod | Monitoring | Only GitHub's workflow-failure emails (daily maintenance, deploy smoke) and keep-warm warnings. Optional free extras: an uptime monitor on `/api/health/ready`, Sentry free tier for errors |
| Prod | Cold starts | ~1 min outside 11:30–14:00 / 18:00–23:00 SGT (shared Render hours) |
| Prod | Extraction | Not 100% accurate; Review stays mandatory. Multi-photo/PDF/blurry receipts aren't benchmarked |
| CI/CD | Dependencies | Dependabot declined for now: dependency updates are manual |
| CI/CD | Scheduled workflows | GitHub disables them after 60 days without repo activity; re-enable in the Actions tab |
| CI/CD | Prod E2E | The production run was an ad-hoc script (temporary account via the prod image). It isn't a workflow; CI E2E runs against a throwaway local stack |
| Dev | Workflow | `main` is protected: branch → PR → green CI → merge (deploys on merge) |
| Dev | Leftovers on disk (untracked/ignored) | `frontend/{dist,node_modules,public}`, `splitwise_package_for_ref/`, `backend/.env`. Safe to delete locally. The merged `production-rebuild` branch can be deleted |
| Ops | Account deletion | Live success verified; the retry path for a partial cleanup failure (`account_cleanup_pending`) was only tested offline |

## Not done / open

- The `production-rebuild` branch is merged and can be deleted when convenient.
