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

## Owner to-do

1. **Sign in** at https://even-split.pages.dev as `george` with the password in `.local/ADMIN_FIRST_LOGIN.txt`, set a new password, then **delete that file**.
2. **OpenAI:** set a project budget/limit in the OpenAI dashboard slightly above the app's `GLOBAL_MONTHLY_LLM_BUDGET_USD` ($5 default, editable in /admin). There's no API for this.
3. **Optional Google sign-in:** create a Google OAuth client (Web), put `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in `.env`, and run `python scripts/provision/supabase.py google`. It prints the origins and callback to register.
4. **Create friends' accounts** in /admin (signups stay disabled).
5. Keep the Render workspace budget in mind before adding services or widening keep-warm (DEPLOYMENT.md §7).
6. Scheduled workflows stop after 60 days without repo activity; re-enable them in the Actions tab if that happens.

## Not done / open

- A live production *scan* wasn't run. The pipeline was certified locally on 2026-10-08 (1 page, $0.000396), and production uses the same image and keys. The first real scan will cost 1 Azure F0 page.
- The `production-rebuild` branch is merged and can be deleted when convenient.
