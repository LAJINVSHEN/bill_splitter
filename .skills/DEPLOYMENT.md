# Deployment runbook — even (P5)

> Stack (BRIEF §2, playbook §2): Cloudflare Pages (Direct Upload from Actions) · Render Free Docker, Singapore · Supabase Free, `ap-southeast-1` · GitHub Actions. $0/month.
> Every step is a script in `scripts/provision/` (Python 3 stdlib, no installs). All are **idempotent**: re-running one reuses what exists and only changes drift. All accept `--dry-run`. None print secret values.

## 1. Where values live

| File | Holds | Written by |
|---|---|---|
| `.env` (root, gitignored) | Owner tokens (`SUPABASE_ACCESS_TOKEN`, `RENDER_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), app keys (`OPENAI_API_KEY`, `AZURE_DI_*`), optional `GOOGLE_CLIENT_ID/SECRET`, and **local dev** values | owner |
| `.env.production.local` (root, gitignored) | All **production** values: Supabase URL/keys, `DATABASE_URL`, `CRON_SECRET`, `PAGES_URL`, `API_BASE_URL`, `VITE_*` … | the scripts |

Production output deliberately does **not** go into `.env`. If it did, `docker compose`, the Vite dev server (`envDir: '..'`) and any local `uvicorn` would silently point at the production DB and Auth. The scripts read `.env.production.local` → `.env` → process env. For production-only keys they never fall back to the dev values in `.env`. `vite build` also reads `.env.production.local`, so a local production build matches CI.

## 2. Owner sequence (once the tokens are in `.env`)

Run from the repo root in **your own terminal**. Steps 1–2 and 9 are manual. Everything else is scripted.

| # | Command | What happens |
|---|---|---|
| 1 | `gh auth login --scopes workflow` | One-time CLI login (browser). |
| 2 | Re-link and push the code (below) | `main` must exist with this code before Render can build it. |
| 3 | `python scripts/provision/cloudflare.py` | Pages project `even` (Direct Upload, production branch `main`). Writes `PAGES_URL`. |
| 4 | `python scripts/provision/supabase.py` | Project `even` in `ap-southeast-1`: DB password generated and saved **before** create. Waits until healthy, then fetches keys, JWT secret and the session-pooler `DATABASE_URL`. Auth: signups off, Site URL = Pages, redirect allow-list. Creates the private `receipts` bucket. |
| 5 | `python scripts/provision/render.py` | Free Docker service `even-api` (Singapore, auto-deploy **off**, health `/api/health`) with all env vars. Its first deploy starts on create. Writes `RENDER_SERVICE_ID`, `API_BASE_URL`, `VITE_API_URL`. If Render refuses a free create via the API, it prints 6 dashboard steps; do them, then re-run. |
| 6 | `python scripts/provision/github.py --enable-deploy` | Sets the secrets, the variables and the `production` environment (main only), and flips the kill switch on. |
| 7 | `gh workflow run deploy-backend-render.yml --ref main` then `gh workflow run deploy-frontend-cloudflare.yml --ref main` | First deploys through the real pipeline (tests → deploy → smoke). Later pushes to `main` deploy automatically. |
| 8 | `python scripts/provision/smoke.py --maintenance-guard` | Health, DB, CORS preflight from the Pages origin, Pages 200, SPA deep link 200. |
| 9 | `python scripts/provision/bootstrap.py --username <admin>` | Builds the prod image and runs `app.cli ensure-bucket` + `bootstrap-admin` against production. It prints the **temporary password once, in your terminal**. Sign in at the Pages URL and change it. |
| 10 | *(optional)* Google sign-in | Create a Google OAuth client (Web) with the origins and callback that `python scripts/provision/supabase.py google` prints. Put `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in `.env` and re-run that command. Pre-create each Google user in `/admin` (login = Google, real Gmail). Signups stay disabled, so nobody else gets in. |

Steps 3–6 in one go: `python scripts/provision/all.py --enable-deploy` (stops at the first failure; re-run after fixing).

**Step 2 — re-link and push** (the remote `master` has README commit `00cec4e` that local lacks):

```sh
git remote add origin https://github.com/GeorgePPP/bill_splitter.git
git fetch origin
git switch production-rebuild
git merge origin/master            # keep our README if it conflicts
python scripts/provision/github.py --rename-default-branch   # remote master → main (branch-only run is fine)
git push -u origin production-rebuild:main
```

With `CLOUD_DEPLOY_ENABLED` unset, this push runs only CI. The deploy workflows skip, and the cron jobs skip until `API_BASE_URL` exists.

**Why this order:** the Pages URL is an input to Supabase Auth (Site URL and redirects) and to Render CORS. Supabase values are inputs to Render. All of it feeds GitHub. If you ran them in a different order, re-run the earlier script: it only patches what changed. After any env change, `python scripts/provision/render.py deploy --wait` applies it.

## 3. Automated vs manual

| Automated (scripts / Actions) | Manual (owner) |
|---|---|
| Pages project, Supabase project + Auth + bucket, Render service + env vars + drift fixes, GitHub secrets/vars/environment, deploys, smoke tests, keep-warm, daily maintenance | Creating the 4 tokens, `gh auth login`, Render GitHub-app access to the repo, merge + first push, running `bootstrap.py`, Google OAuth client, the Render dashboard create **only if** the API refuses the free plan |

## 4. Every variable and where it lives

| Name | Local `.env` | `.env.production.local` | Render env | GitHub |
|---|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN`, `RENDER_API_KEY` | ✔ owner | | | `RENDER_API_KEY`: `production` env secret |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | ✔ owner | | | repo secrets |
| `OPENAI_API_KEY`, `AZURE_DI_ENDPOINT`, `AZURE_DI_KEY` | ✔ owner | (optional override) | ✔ | |
| `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` | | ✔ | | |
| `DATABASE_URL` (session pooler `:5432`) | dev value | ✔ | ✔ | |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` | dev value | ✔ | ✔ | |
| `SUPABASE_ANON_KEY` | | ✔ | | |
| `AUTH_EMAIL_DOMAIN`, `STORAGE_BUCKET` | | ✔ | ✔ | |
| `CRON_SECRET` (new prod value, ≠ dev) | dev value | ✔ | ✔ | repo secret (same value) |
| `PAGES_URL` | | ✔ | as `PUBLIC_APP_URL` + `CORS_ORIGINS` | repo variable |
| `API_BASE_URL` (= `VITE_API_URL`) | | ✔ | | repo variable |
| `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_AUTH_EMAIL_DOMAIN` | dev values | ✔ | | repo secrets (build-time) |
| `RENDER_SERVICE_ID` | | ✔ | | `production` env secret |
| `RENDER_DEPLOY_HOOK_URL` *(alternative)* | owner, from dashboard | | | `production` env secret (`github.py --render-auth hook`) |
| `CLOUDFLARE_PROJECT_NAME` | | ✔ (`even`) | | repo variable |
| `CLOUD_DEPLOY_ENABLED` | | | | repo variable (kill switch) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | ✔ owner (optional) | | | — (stored in Supabase Auth) |

Render also gets fixed values: `ENVIRONMENT=production`, `SUPABASE_ADMIN_BACKEND=supabase`, `STORAGE_BACKEND=supabase`, `OCR_BACKEND=azure`, `LLM_BACKEND=openai`, `RATE_LIMIT_ENABLED=true`. Tuning keys are copied when set (`APP_NAME`, `LOG_LEVEL`, `APP_TIMEZONE`, `DEFAULT_CURRENCY`, `LLM_*`, `OCR_*`, `SCAN_*`, `JOB_*`, quotas, `RATE_LIMIT_*`, `MAX_JSON_BODY_BYTES`, `DB_POOL_SIZE/MAX_OVERFLOW`). It never gets `DEV_LOGIN_PASSWORD` or `LOCAL_STORAGE_DIR`, and `render.py` warns if either is present. `render.yaml` documents the same service but **does not sync** to a dashboard- or API-created service.

**Render API key in GitHub:** the deploy job needs it to deploy the exact commit and read the deploy status. It sits in the `production` environment, which only `main` can use and which fork PRs never see. Render keys are account-wide, so if you'd rather not store one, copy the service's deploy hook into `.env` as `RENDER_DEPLOY_HOOK_URL` and run `github.py --render-auth hook`. The workflow then triggers the hook and waits on `/api/health`, but it can't confirm the deploy status.

## 5. Workflows

| File | Trigger | Does |
|---|---|---|
| `ci.yml` | PR, push to `main`, manual | backend: Alembic up/down/up + pytest on Postgres 16 + prod image build · frontend: Node 24, `npm ci`, `typecheck`, `build`, `test` in `web/` · E2E placeholder (commented) |
| `deploy-backend-render.yml` | push to `main` on `backend/**`, `shared/**`, `render.yaml`; manual | migrations + pytest on Postgres 16 → `render.py deploy --commit $GITHUB_SHA --wait` → `smoke.py --skip-pages --maintenance-guard`. Concurrency `render-backend-production` (cancel in progress). 30-min timeout |
| `deploy-frontend-cloudflare.yml` | push to `main` on `web/**`, `shared/**`; manual | fails fast on missing `VITE_*`/Cloudflare secrets → `npm ci`, tests, build → checks `dist/_redirects` → `wrangler pages deploy web/dist --branch=main` (`cloudflare/wrangler-action@v4`) → smoke. Concurrency `cloudflare-pages-production`. `VITE_AUTH_MODE` is never set |
| `cron.yml` | `*/10 23 * * *` + `*/10 0-16 * * *` (07:00–01:00 SGT), `23 2 * * *` (10:23 SGT), manual | keep-warm `GET /api/health`, which only warns on failure · daily `POST /api/internal/maintenance` (warm-up 6×20 s, 3 attempts, prints status + counts only). `cancel-in-progress: false` |

Every job has `timeout-minutes` and `permissions: contents: read`. Push deploys need `CLOUD_DEPLOY_ENABLED == 'true'`. Manual runs skip that check but only work from `main`.

## 6. Kill switch and rollback

- **Stop deploys:** `python scripts/provision/github.py --disable-deploy` (or `gh variable set CLOUD_DEPLOY_ENABLED --body false`). Pushes then skip both deploy workflows. With auto-deploy off on Render and no Git build on Pages, nothing else deploys.
- **Backend rollback:** Render dashboard → `even-api` → Events → pick the last good deploy → *Rollback*. Or revert the commit on `main`. Code rollback doesn't undo migrations, so keep migrations backward-compatible (expand, then contract).
- **Frontend rollback:** Cloudflare dashboard → Workers & Pages → `even` → Deployments → last good one → *Rollback to this deployment* (instant).
- **Pause everything:** suspend the Render service in the dashboard, then `gh workflow disable cron.yml`. Supabase will auto-pause after 7 idle days. Restore it from its dashboard.
- **Rotate a secret:** change it at the provider, update `.env` / delete the key from `.env.production.local`, re-run the script that owns it (`supabase.py --reset-db-password`, `render.py`, `github.py`), then `render.py deploy --wait`.

## 7. Free-tier guardrails (cloud side) — check once after provisioning

- [ ] **Supabase:** org on Free, so there are hard caps and no overage. If you ever upgrade, keep the Spend Cap **ON**. Only 2 active Free projects per org. Daily maintenance hits the DB, so the 7-day pause never triggers. Signups are **disabled**. Anonymous and phone providers are off. Bucket `receipts` is private (4 MB, JPEG/PNG/HEIF/PDF).
- [ ] **Render:** instance type **Free**, 1 instance, no autoscaling, no disk, no paid Postgres/Key Value, auto-deploy off, PR previews off. `render.py` checks and fixes all of this. Keep-warm uses about 558 of the 750 instance-hours a month. Don't add other free services to this workspace unless the hours allow.
- [ ] **GitHub Actions:** public repo, so minutes are free. Every job has a timeout. If the repo ever goes private, thin the keep-warm schedule (about 3,300 min/month vs 2,000 free). Scheduled workflows stop after 60 days without repo activity: re-enable them in the Actions tab.
- [ ] **Cloudflare:** Direct Upload means no build minutes. The token is scoped to one account and *Cloudflare Pages: Edit* only.
- [ ] **OpenAI / Azure:** OpenAI project budget set, and `GLOBAL_MONTHLY_LLM_BUDGET_USD` slightly below it (Render env). Azure DI on **F0**, with `GLOBAL_MONTHLY_PAGE_CAP` below 500.
- [ ] **Secrets hygiene:** both env files are gitignored. Never paste them, deploy-hook URLs or OAuth callback URLs (`#access_token=…`) into chat or logs.

## 8. Cold starts (UX)

Render Free sleeps after about 15 minutes idle, and the first request then takes about 1 minute. Three things soften this:

- The SPA fires `GET /api/health` on load (`web/src/lib/api.ts`), so the API wakes while the user is still on the first screen.
- The keep-warm cron keeps the API awake from 07:00 to 01:00 SGT.
- An in-progress scan polls `/api/jobs/{id}`, which keeps the instance awake.

Outside those hours, the first action after waking may take about a minute. The UI should show a calm "waking up" state, not an error. A deploy restarts the instance, and any scan running at that moment becomes `interrupted` (retryable, with OCR not re-billed).

## 9. Gotchas

- **Supabase Site URL** must be the Pages URL **before** the first production login. Otherwise OAuth lands on localhost (playbook §2.5). `supabase.py` sets it, and re-running after a Pages URL change fixes it.
- **Session pooler, not direct:** `DATABASE_URL` uses the Supavisor host on port **5432** (session mode, IPv4). Direct `db.<ref>.supabase.co` is IPv6-only on Free and won't work from Render.
- **Pages SPA routing:** `web/public/_redirects` contains `/* /index.html 200`. Wrangler may warn "infinite loop detected… ignored". That's harmless, because Pages serves `index.html` for unknown paths whenever the build has no top-level `404.html`. The smoke test's deep-link check proves it either way.
- **`gh secret set`** receives values over stdin. Nothing secret appears in process lists or shell history.
- **Docs used** (checked 2026-10-07): Supabase Management API OpenAPI (`api.supabase.com/api/v1-json`), Render public API OpenAPI, Cloudflare API schema (`pages_project`, "Pages Write"), Cloudflare Direct Upload CI guide (`wrangler-action@v4`), Render deploy-hook and default-env-var docs, and Supabase pooler docs.
