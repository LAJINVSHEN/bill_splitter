# even

Photograph a receipt, tick who was there, tap who had what. **even** works out what everyone owes, down to the cent and in any currency, and gives each friend a link to their own share.

Built for a small circle of friends (10–15 accounts) on a $0/month hosting stack.

- **Scan first:** the receipt is read in the background (Azure Document Intelligence → OpenAI) while you pick who's splitting. A failed or cancelled scan can be retried without paying for OCR twice.
- **Fair, exact maths:** each person pays their share of the items plus the same proportion of tax, service and discounts. Shares always add up exactly to the bill.
- **Any currency:** per-bill currency with the right minor units (SGD 2 dp, JPY 0, KWD 3), plus conversion at a rate you type in. Different currencies are never summed silently.
- **Settle up:** mark who has paid you back, send per-person share links (no login needed to view), and keep the full history.
- **Accounts by invitation:** the admin creates username/password accounts (Google sign-in optional), with per-account monthly scan quotas and a usage log for every paid API call.

## Stack

| Layer | Tech | Hosting |
|---|---|---|
| Web | React 19, Vite, Tailwind 4, TanStack Query, React Router (`web/`) | Cloudflare Pages |
| API | FastAPI, SQLAlchemy 2 async, Alembic, Python 3.12 (`backend/`) | Render (Docker, Singapore) |
| Data & auth | Postgres 16, Supabase Auth, Supabase Storage | Supabase |
| Receipts | Azure Document Intelligence `prebuilt-layout` → OpenAI structured output | — |
| CI/CD | GitHub Actions: tests, E2E, deploys, keep-warm and daily maintenance crons | GitHub |

## Run it locally (Windows)

Needs Docker Desktop and Node 22+. Copy `.env.example` to `.env` and fill in the keys you have (the app runs without Azure/OpenAI keys; only scanning is disabled).

```bat
start-windows.cmd
```

This starts Postgres and the API in Docker, loads sample data and opens the web app at <http://localhost:5173>. Sign in as `george` (admin), or `maya`, `arjun`, `lena` or `tomas`, with the `DEV_LOGIN_PASSWORD` from `.env`.

Without the script:

```sh
docker compose up -d db api
docker compose exec api python -m app.cli dev-seed
cd web && npm install && npm run dev
```

## Tests

```sh
docker compose run --rm test        # backend: pytest on real Postgres 16
cd web && npm test                  # unit tests, incl. split-maths parity with the backend
cd web && npm run e2e               # Playwright, desktop + Pixel 5 (needs the API running and seeded)
```

The split and validation maths have one set of golden test vectors (`shared/split-vectors.json`) that both the Python core and the TypeScript mirror must reproduce exactly.

## Deploy

Scripted end to end; see [`.skills/DEPLOYMENT.md`](.skills/DEPLOYMENT.md). Provisioning scripts are in `scripts/provision/`.

## Layout

```
backend/   FastAPI app: api → services → core (pure maths) / repositories / integrations
web/       the web app ("even")
shared/    currencies + golden test vectors used by both sides
scripts/   provisioning and smoke tests
.skills/   briefs, handovers, design references
```
