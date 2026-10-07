# Handover — P1 Backend core + P1b multi-currency & dev login (2026-10-07)

> Product name is now **even** (`APP_NAME`, API title "even API", auth email domain `users.even.app`).
> P1b additions are summarised in §11 and folded into the contract below.

> Read `.skills/BRIEF.md` first. This file is the contract the frontend (P3) builds against.
> Branch `production-rebuild`, commits `4ef9a78` (core) and `574da2f` (tests, ops, CI). Nothing pushed.

## 1. Status

| Exit criterion (BRIEF §5 P0-backend + P1) | State |
|---|---|
| Splitwise feature + vendored SDK + legacy stateless services removed | ✅ |
| Root `.env` (copied from `backend/.env`, keys renamed, Splitwise keys dropped) + complete `.env.example` | ✅ |
| docker-compose: Postgres 16 + API (hot reload) + test runner | ✅ `docker compose up -d db api` → `GET /api/health` 200 |
| Schema + RLS (deny-all) + committed Alembic migration, `upgrade head` from empty DB | ✅ (also `downgrade base` → `upgrade head` in CI) |
| Auth: Supabase JWT via JWKS + HS256 fallback, profiles, disabled, admin | ✅ |
| All §4.4 routes (+ a few additions, §6) | ✅ 40 public/authenticated operations + `/internal/maintenance` |
| Async scan pipeline (quotas, idempotency, cache, heartbeat, cancel, retry, recovery) | ✅ |
| Usage + quotas (per user pages, global pages, global LLM $) | ✅ |
| Golden vectors `shared/split-vectors.json` (34 split + 14 validation cases) | ✅ |
| pytest green on Postgres 16 | ✅ **224 passed** after P1b (`docker compose run --rm test`, ~35 s; the 3 skips are the benchmark agent's live-LLM tests) |
| CI workflow (backend job) | ✅ `.github/workflows/ci.yml` (not yet run on GitHub — repo not pushed) |
| Render image + start script | ✅ built and booted locally (non-root, migrations on start, docs hidden) |

Real provider calls made: **3 OpenAI calls** (synthetic receipt, see §4), **0 Azure calls**.

## 2. How to run / test

```sh
docker compose up -d db api            # Postgres 16 on :5433, API on http://localhost:8000 (reads root .env)
docker compose run --rm test           # alembic upgrade head + full pytest on a separate test DB
docker compose logs -f api
```

Local dev auth without Supabase (root `.env` has `SUPABASE_ADMIN_BACKEND=fake`, a random `SUPABASE_JWT_SECRET`, `STORAGE_BACKEND=local`):

```sh
docker compose exec api python -m app.cli bootstrap-admin --username george   # prints a temp password once
docker compose exec api python -m app.cli dev-token --username george         # HS256 access token (not in production)
# then: POST /api/me/password-changed with that token (temp-password gate), and use it as Bearer
```

OpenAPI: `GET http://localhost:8000/openapi.json`, Swagger at `/docs` (both disabled when `ENVIRONMENT=production`).
`start-windows.cmd` now starts db+api via docker compose (it used the deleted `run.py`) and the Vite dev server as before.

Production (Render, P5): Docker, context `backend`, Dockerfile `backend/Dockerfile.render`, start = image CMD (`sh scripts/render-start.sh`: `alembic upgrade head` ×5 with 10 s backoff, then **one** uvicorn worker with `--proxy-headers`). One-off setup commands (run once with production env): `python -m app.cli ensure-bucket`, `python -m app.cli bootstrap-admin --username <admin>`.

## 3. File map

| Path | What |
|---|---|
| `backend/app/main.py` | `create_app()`: lifespan (DB, services, job recovery, graceful shutdown), middleware order, routers |
| `backend/app/config.py` | pydantic-settings, reads **repo-root `.env`**, model price table, derived DB URL/SSL/pooler args |
| `backend/app/database.py` | async engine/sessionmaker on `app.state.db`, `get_db` |
| `backend/app/errors.py` | error envelope, exception handlers, `CatchAllMiddleware` (JSON 500 inside CORS) |
| `backend/app/ratelimit.py` | slowapi limiter (strict routes) + `default_limit` router dependency |
| `backend/app/middleware/auth.py` | JWT verification (JWKS cache + HS256), `CurrentUser`, `get_current_user`, `require_admin` |
| `backend/app/middleware/body_limit.py` | request body size limit (Content-Length + streamed) → 413 JSON |
| `backend/app/core/` (PURE) | `money.py` (cents, `allocate`), `split.py`, `receipt_validation.py`, `pricing.py`, `periods.py`, `ocr_text.py` |
| `backend/app/integrations/` | `llm.py` (async OpenAI), `azure_ocr.py` (DI `.aio`), `storage.py` (Supabase/local), `supabase_admin.py` (+ fakes) |
| `backend/app/repositories/` | SQLAlchemy queries, always owner-filtered (`bills`, `people`, `scans`, `usage`) |
| `backend/app/services/` | `bills`, `people`, `me`, `scans`, `pipeline` (JobRunner), `extraction` (escalation), `usage` (quotas), `share`, `admin`, `maintenance`, `split_view` (the ONE place a split is derived) |
| `backend/app/schemas/` | Pydantic DTOs (requests reject unknown fields); `extraction.py` = the original LLM schema, verbatim |
| `backend/app/models/` | ORM (`profile.py`, `bill.py`, `scan.py`) — never returned directly |
| `backend/app/api/` | thin routers; `dev.py` serves local signed files (non-production only) |
| `backend/app/cli.py` | `bootstrap-admin`, `dev-token`, `ensure-bucket` |
| `backend/alembic/versions/0001_initial_schema.py` | all tables + RLS lockdown |
| `backend/tests/` | 164 tests (see §9) |
| `backend/Dockerfile` / `Dockerfile.render` / `scripts/render-start.sh` | dev image / prod image / prod start |
| `shared/split-vectors.json` | golden vectors for backend + TS mirror |
| `docker-compose.yml`, `.env.example`, `.github/workflows/ci.yml` | ops |

## 4. Decisions (and why)

- **Models.** Listed the account's models (`GET /v1/models`) and checked OpenAI's model pages. Primary **`gpt-6-luna`** ("most efficient model for focused, high-volume tasks", $0.10/$0.50 per 1M in/out, structured outputs, reasoning `none…max`), fallback **`gpt-6.1-sol`** ("near-Astra performance at lower cost", $2/$10, reasoning `low…max`). Smoke test on a synthetic tax-exclusive receipt (service + GST + discount): both extracted every field correctly and reconciled. luna@low 4.7 s / 237 µ$, luna@none 3.4 s / 204 µ$, sol@low 5.7 s / 4,074 µ$. Default efforts: primary `low`, fallback `low` (env-overridable; benchmark `none` vs `low` on real receipts in P4). Admin settings show the active models.
- **LLM call path:** `chat.completions.parse(response_format=ReceiptExtraction, reasoning_effort, max_completion_tokens)` with the original system/user prompts verbatim. `AsyncOpenAI(timeout, max_retries)` + an overall deadline. Every call returns tokens (incl. cached), latency, API model name, `cost_micros` (price table, unknown models priced at the most expensive entry so caps stay conservative).
- **Escalation:** primary → fallback when the primary errors/times out/refuses **or** its output fails reconciliation. If nothing reconciles, the last parsed extraction is applied and the job is `needs_review`. The LLM budget is re-checked before each model call.
- **Split maths (`core/split.py`)** reproduces the frontend: person pays `grand × items_subtotal / Σ items_subtotal`, remainder to the largest share (first on ties), always summing exactly. One `allocate()` rule is used for the bill level **and** equal/weighted item splits. All divergences from the old float code are cases where the old code was 1 ¢ off the total (its fix-up only ran for differences > 0.01, and `Math.round(5.005*100)` = 500); those vectors carry a `legacy_frontend` block. Rounding is Decimal `ROUND_HALF_UP` (halves away from zero) — **the TS mirror must not use `Math.round` on floats**; do integer/BigInt or decimal maths.
- **Validation (`core/receipt_validation.py`)** keeps the meaning of `receipt_validator.py` exactly (5 ¢ tolerance, subtotal handling, inclusive/exclusive detection, display percentages, item-math mismatches are warnings only) and the user-friendly messages of `_format_user_friendly_error`. Cross-checked against the original float validator on all 14 validation vectors: no differences.
- **Split intent is stored, results derived:** `item_shares` holds weights/amounts; per-person totals are computed on every read by `services/split_view.py` (bill page, split, settle-up, summary and share link all call it).
- **Quick split** = one synthetic item ("Total" or the title) with `equal` / `weighted` shares (`PUT /bills/{id}/quick`), so the same core function handles it.
- **Jobs are in-process asyncio tasks** (`JobRunner`). State changes are conditional on the job still being active, so cancel always wins. Recovery is three-fold: at startup (stale heartbeat), lazily when a stale job is polled, and in `/internal/maintenance`; graceful shutdown (Render deploy SIGTERM) marks running jobs `failed{interrupted, retryable}`. Requires a single worker.
- **Usage accounting:** one `usage_events` row per Azure call (pages actually analysed, from the result) and per LLM call, successful or failed; a cancelled in-flight call is recorded too (pages estimated, since Azure may bill it). OCR cache hits cost nothing and record nothing.
- **Quota checks happen before spending**, with a page estimate (photo = 1, PDF = `OCR_MAX_PDF_PAGES`) minus files already in the owner's OCR cache. Month boundaries use `APP_TIMEZONE`.
- **Auth:** no `profiles` row → 403 `not_provisioned`; disabled → 403; **temp password is enforced server-side**: every route except `GET/POST /me…password-changed` returns 403 `password_change_required` until `POST /me/password-changed`.
- **Rate limits:** slowapi decorators on scans/retry (per user), public share view (per IP), admin create/reset; the **default limit (300/min per user/IP) is a router dependency** — slowapi's middleware can't see endpoints inside FastAPI 0.142's nested `_IncludedRouter`, so it silently applied nothing (found by test).
- **RLS:** every `public` table (incl. `alembic_version`) has RLS enabled with **no policies**; `anon`/`authenticated` lose all table/sequence grants and default privileges (guarded by role existence). The API connects as the owner. Tests simulate Supabase's default grants and assert they're gone.
- **DB connection:** use the Supabase **session pooler** (5432). `DATABASE_SSL=auto` requires TLS for `*.supabase.com/co`; port 6543 (transaction pooler) automatically disables asyncpg prepared statements.
- **Integrations degrade instead of crashing:** missing Azure/OpenAI/Supabase keys → app still starts, manual entry works, scans/admin calls fail with clear codes.

## 5. Schema (Postgres 16, migration `0001`)

Money is `BIGINT` cents, quantities `NUMERIC(12,3)`, weights `NUMERIC(12,4)`. Enums are `TEXT` + `CHECK`.

| Table | Columns (beyond id/created_at/updated_at) | Notes |
|---|---|---|
| `profiles` | id = auth user id, `username` (unique, lower-case CHECK), `email`, `display_name`, `role` admin\|member, `must_change_password`, `monthly_scan_quota`, `default_currency`, `disabled_at` | no FK to `auth.users` (absent locally) |
| `people` | `owner_id`, `name` (1–60), `color_seed` 0–359 (hue), `is_self` (unique per owner), `last_used_at`, `archived_at` | archived, never hard-deleted |
| `bills` | `owner_id`, `title`, `merchant`, `bill_date`, `currency`, `status` draft\|scanning\|review\|assigning\|complete, `source` scan\|manual\|quick, `payer_person_id`, `subtotal_cents` (**as printed**; null = not shown), `grand_total_cents`, `tax_scenario` (derived at write), `receipt_meta` JSONB, `deleted_at` | soft delete |
| `bill_items` | `bill_id`, `position`, `name`, `quantity`, `unit_price_cents`, `total_price_cents`, `split_mode` single\|equal\|weighted\|custom\|NULL | NULL = unassigned |
| `item_shares` | PK (`item_id`,`person_id`), `bill_id`, `position`, `weight`, `amount_cents` | FK (`bill_id`,`person_id`) → participants ON DELETE CASCADE |
| `bill_charges` | `bill_id`, `position`, `name`, `kind` tax\|service\|discount\|rounding\|other, `amount_cents` (discount < 0), `percent` | |
| `bill_participants` | PK (`bill_id`,`person_id`), `position`, `settled_at`, `settled_amount_cents` | person FK deferred (profile delete cascades) |
| `receipt_files` | `bill_id`, `owner_id`, `job_id`, `storage_path`, `sha256`, `mime`, `bytes`, `pages` (billed), `position`, `expires_at` (+90 d), `deleted_at` | |
| `extraction_jobs` | `bill_id`, `owner_id`, `status`, `attempts`, `error_code`, `error_message`, `retryable`, `ocr_text`, `extracted`, `validation`, `model_used`, `idempotency_key` (unique per owner), `pages_billed`, `cost_micros`, `timings`, `heartbeat_at`, `started_at`, `finished_at` | |
| `ocr_cache` | PK (`owner_id`,`content_sha256`), `ocr_text`, `pages` | |
| `usage_events` | identity id, `user_id`, `job_id`, `kind` ocr\|llm, `provider`, `model`, `pages`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `cost_micros`, `latency_ms`, `ok`, `error_code` | |
| `share_links` | `bill_id`, `owner_id`, `person_id` (NULL = whole bill), `token_hash` (sha256 hex, unique), `expires_at`, `revoked_at`, `last_viewed_at` | |
| `app_settings` | singleton id=1: `global_monthly_page_cap`, `global_monthly_llm_budget_micros`, `default_user_quota`, `scans_enabled` | created lazily from env defaults |

## 6. API contract (all under `/api`; Bearer Supabase access token unless marked)

### 6.1 Conventions

- JSON, `snake_case`. IDs are UUID strings. Money is an **integer in MINOR UNITS of its currency** (`*_cents`: cents for SGD, whole yen for JPY, fils for KWD; exponents in `shared/currencies.json`). Never assume 2 decimals. `quantity`, `weight`, `percent` are **decimal strings** (`"2"`, `"0.5"`, `"9.92"`); requests accept numbers or strings. Dates `YYYY-MM-DD`, timestamps ISO-8601 UTC.
- **Errors** always: `{"detail": "<human message>", "code": "<machine_code>", ...extra}`; 422 adds `errors: [{loc, msg, type}]`. Show `detail`; branch on `code`.
- Request bodies reject unknown fields (422). Every bill mutation returns the full **`BillOut`** (with the derived `split`), so one response re-renders the page.
- Lists: `?limit=&cursor=` → `{items, next_cursor}` (pass `next_cursor` back; `null` = last page).
- Status codes: 401 `missing_token|invalid_token|token_expired`; 403 `invalid_audience|not_provisioned|account_disabled|password_change_required|admin_only`; 404 `not_found` (also for other users' resources — never 403); 409 conflicts; 413 `payload_too_large|file_too_large`; 415 `unsupported_file_type`; 429 `rate_limited` (with `Retry-After`) **or** `quota_*` (scan quota, see 6.6); 500 `internal_error`; 502 `auth_provider_error`; 503 `storage_unavailable`.

### 6.2 Types (TypeScript notation)

```ts
type UUID = string; type Cents = number; type Dec = string;
type BillStatus = 'draft' | 'scanning' | 'review' | 'assigning' | 'complete';
type SplitMode = 'single' | 'equal' | 'weighted' | 'custom';
type ChargeKind = 'tax' | 'service' | 'discount' | 'rounding' | 'other';
type TaxScenario = 'tax_exclusive' | 'tax_inclusive' | 'no_taxes';
type JobStatus = 'queued' | 'ocr' | 'llm' | 'validating' | 'succeeded' | 'needs_review' | 'failed' | 'cancelled';

interface MeOut { id: UUID; username: string; display_name: string; email: string | null; role: 'admin' | 'member';
  must_change_password: boolean; monthly_scan_quota: number; default_currency: string; self_person_id: UUID; created_at: string }
interface PersonOut { id: UUID; name: string; color_seed: number /*0-359 hue*/; is_self: boolean;
  last_used_at: string | null; archived_at: string | null; created_at: string }

interface ShareOut { person_id: UUID; weight: Dec | null; amount_cents: Cents | null }   // equal → weight "1"
interface ItemOut { id: UUID; position: number; name: string; quantity: Dec; unit_price_cents: Cents;
  total_price_cents: Cents; split_mode: SplitMode | null; shares: ShareOut[] }
interface ChargeOut { id: UUID; position: number; name: string; kind: ChargeKind; amount_cents: Cents; percent: Dec | null }
interface ParticipantOut { person_id: UUID; name: string; color_seed: number; is_self: boolean; position: number;
  settled_at: string | null; settled_amount_cents: Cents | null }
interface ValidationOut { ok: boolean; tax_scenario: TaxScenario | null; items_total_cents: Cents; charges_total_cents: Cents;
  grand_total_cents: Cents; provided_subtotal_cents: Cents | null; final_subtotal_cents: Cents | null;
  message: string | null;                                   // friendly text of the first error
  errors: { code: 'no_items' | 'grand_total_missing' | 'items_subtotal_mismatch' | 'grand_total_mismatch'
            | 'items_grand_mismatch' | 'no_scenario_matches'; message: string; technical: string }[];
  warnings: { code: 'item_math_mismatch'; item_index: number; item_id: UUID | null; message: string;
              expected_cents: Cents; actual_cents: Cents }[] }
interface SplitPersonOut { person_id: UUID; name: string; color_seed: number; is_self: boolean; is_payer: boolean;
  items_cents: Cents; adjustment_cents: Cents /* tax/service/discount/rounding share = total - items */; total_cents: Cents;
  settle_total_cents: Cents | null /* settle currency; null without conversion */;
  effective_total_cents: Cents /* what they owe, in effective_currency */;
  items: { item_id: UUID; name: string; share_cents: Cents }[];
  settled_at: string | null; settled_amount_cents: Cents | null /* effective currency */;
  outstanding_cents: Cents /* still owed to payer, effective currency */ }
interface SplitOut { currency: string /* bill currency */; settle_currency: string | null; fx_rate: Dec | null;
  effective_currency: string /* settle_currency ?? currency: settlements + outstanding */;
  grand_total_cents: Cents; settle_grand_total_cents: Cents | null; all_items_cents: Cents; assigned_items_cents: Cents;
  payer_person_id: UUID | null; people: SplitPersonOut[]; unassigned_item_ids: UUID[];
  issues: { code: 'unassigned_item' | 'custom_amounts_mismatch' | 'zero_weights' | 'zero_items_subtotal'
            | 'no_participants' | 'share_not_participant' | 'single_has_many_shares'; message: string;
            item_id?: UUID | null; person_id?: UUID | null; expected_cents?: Cents | null; actual_cents?: Cents | null }[];
  is_complete: boolean; outstanding_total_cents: Cents }
interface FileOut { id: UUID; job_id: UUID | null; mime: string; bytes: number; pages: number | null; position: number;
  created_at: string; expires_at: string; available: boolean /* false after the 90-day purge */ }
interface BillOut { id: UUID; title: string | null; merchant: string | null; bill_date: string | null; currency: string;
  status: BillStatus; source: 'scan' | 'manual' | 'quick'; payer_person_id: UUID | null /* effective payer */;
  subtotal_cents: Cents | null /* as printed */; grand_total_cents: Cents | null; tax_scenario: TaxScenario | null;
  settle_currency: string | null; fx_rate: Dec | null /* snapshot: 1 currency = fx_rate settle_currency */;
  effective_currency: string; currency_locked: boolean /* true once anyone settled */;
  receipt_meta: { receipt_number?: string; time?: string; store_address?: string; store_phone?: string;
                  payment_method?: string; transaction_id?: string; notes?: string };
  created_at: string; updated_at: string; items: ItemOut[]; charges: ChargeOut[]; participants: ParticipantOut[];
  validation: ValidationOut | null /* null until a receipt exists */; split: SplitOut;
  latest_job: { id: UUID; status: JobStatus; error_code: string | null; retryable: boolean;
                detected_currency: string | null } | null; files: FileOut[] }
interface BillSummaryOut { id: UUID; title: string | null; merchant: string | null; bill_date: string | null; currency: string;
  status: BillStatus; source: 'scan' | 'manual' | 'quick'; grand_total_cents: Cents | null;
  settle_currency: string | null; participant_count: number; unsettled_count: number /* non-payer participants not settled */; created_at: string; updated_at: string }
interface JobOut { id: UUID; bill_id: UUID; status: JobStatus; attempts: number; error_code: string | null;
  error_message: string | null; retryable: boolean; model_used: string | null; pages_billed: number;
  detected_currency: string | null /* receipt currency ≠ bill currency → offer a one-tap switch */;
  validation: ValidationOut | null; timings: { ocr_ms?: number; llm_ms?: number; total_ms?: number };
  heartbeat_at: string | null; started_at: string | null; finished_at: string | null; created_at: string; updated_at: string }
```

### 6.3 Health & me

| Method & path | Request | Response |
|---|---|---|
| `GET /health` (public, no DB) | — | `{status:"ok", version}` |
| `GET /health/ready` (public) | — | `{status, db}` 200 / 503 |
| `GET /me` | works before the password change | `MeOut` (creates the "Me" person if missing) |
| `PATCH /me` | `{display_name?, default_currency?}` | `MeOut` (also renames the "Me" person) |
| `POST /me/password-changed` | call after `supabase.auth.updateUser({password})` | `MeOut` with `must_change_password:false` |
| `GET /me/usage` | — | `{month:"YYYY-MM", timezone, pages_used, pages_quota, pages_remaining, llm_calls, cost_micros, scans_paused, pause_reason: null\|"scans_disabled"\|"user_quota"\|"global_page_cap"\|"llm_budget"}` |
| `GET /me/summary` | — | `{home:{currency, owed_to_me_cents, i_owe_cents} /* only bills whose effective currency = the user's default */, currencies:[{currency, owed_to_me_cents, i_owe_cents}] /* every effective currency, never converted */, people:[{person_id, name, currency, they_owe_me_cents, i_owe_them_cents, bill_count}], bills:[{bill_id, title, bill_date, currency, owed_to_me_cents, i_owe_cents, unsettled_people}]}` — **complete** bills only, grouped by **effective** currency (settle currency when the bill has a conversion) |

### 6.4 People

| | Request | Response |
|---|---|---|
| `GET /people?include_archived=false` | — | `{items: PersonOut[]}` — self first, then recently used; bounded (≤ 300 active), not paginated |
| `POST /people` | `{name (1–60, whitespace collapsed), color_seed?}` | 201 `PersonOut` (409 `people_limit`) |
| `PATCH /people/{id}` | `{name?, color_seed?, archived?}` | `PersonOut` (409 `cannot_archive_self`) |
| `DELETE /people/{id}` | — | 204 (archives; old bills keep the name) |

### 6.5 Bills

| | Request | Response |
|---|---|---|
| `GET /bills?status=draft,review&limit=20&cursor=` | statuses comma-separated; limit 1–100 | `{items: BillSummaryOut[], next_cursor}` newest first |
| `POST /bills` | `{title?, merchant?, bill_date?, currency? (default user's), source?: 'manual'\|'scan'\|'quick'}` | 201 `BillOut` — owner's "Me" is participant #0 and payer |
| `GET /bills/{id}` | — | `BillOut` |
| `PATCH /bills/{id}` | `{title?, merchant?, bill_date?, currency?, status?: 'draft'\|'review'\|'assigning'\|'complete', payer_person_id?: UUID\|null, settle_currency?: string\|null, fx_rate?: Dec, save_rate?: boolean}`; currency/conversion rules in §11 (payer must be a participant → 400 `payer_not_participant`; 409 `scan_in_progress` for status/currency while scanning; 409 `currency_locked`; 400 `fx_rate_required\|settle_same_currency\|settle_currency_required`) | `BillOut` |
| `DELETE /bills/{id}` | — | 204 soft delete; share links revoked, photos queued for purge, active scan cancelled |
| `PUT /bills/{id}/receipt` | `{items:[{id?, name (1–200), quantity? = 1 (>0, ≤3 dp), unit_price_cents, total_price_cents}] (≤200), charges?:[{name, amount_cents, kind?}] (≤30), subtotal_cents?: number\|null, grand_total_cents (≥0), merchant?, bill_date?}` — items with an existing `id` keep their assignment; omitted items are deleted; charge `kind` inferred from the name when omitted | `BillOut` — **always saves**; read `validation.ok`. 409 `scan_in_progress`, 400 `unknown_item` |
| `PUT /bills/{id}/participants` | `{person_ids: UUID[]}` (ordered, unique, ≤50) — removing someone drops their shares/settlement and unassigns items left with nobody | `BillOut` (400 `unknown_person`, `person_archived`) |
| `PUT /bills/{id}/assignments` | `{assignments:[{item_id, mode: SplitMode\|null, shares:[{person_id, weight?, amount_cents?}]}]}` — replaces only the listed items. Rules: `null` → no shares; `single` → exactly 1; `equal` → ≥1; `weighted` → weight on every share, Σ>0 (percentages or "by shares"); `custom` → `amount_cents` on every share (mismatch is saved and reported as an issue) | `BillOut` (400 `not_a_participant`, `unknown_item`; 422 for rule breaks) |
| `PUT /bills/{id}/quick` | `{total_cents (>0), mode?: 'equal'\|'shares', participants:[{person_id, weight?}] (1–50), title?}` — replaces items/charges/participants with one "Total" item | `BillOut` (`source:"quick"`) |
| `GET /bills/{id}/split` | — | `SplitOut` (same object as `BillOut.split`) |
| `POST /bills/{id}/participants/{person_id}/settlement` | optional `{amount_cents}`; default = their current total | `BillOut`; idempotent; 409 `is_payer`. Partial amounts leave `outstanding_cents > 0` |
| `DELETE /bills/{id}/participants/{person_id}/settlement` | — | `BillOut` |

Split semantics for the UI: `is_complete` is false while any `issues` exist (unassigned items, custom mismatch, no participants, zero subtotal…). `adjustment_cents` is that person's share of tax/service/discount/rounding. The payer's `outstanding_cents` is 0.

### 6.6 Scans, jobs, files

| | Request | Response |
|---|---|---|
| `POST /bills/{id}/scans` | `multipart/form-data`, one or more `files` parts (JPEG, PNG, HEIF or PDF; **not WebP**), ≤ 5 files, ≤ 4 MB each; header `Idempotency-Key` (8–128 chars `[A-Za-z0-9_.:-]`, optional but recommended — use one per user action and reuse it on network retry) | **202** `{job_id, status:"queued", replayed:false}`; replay of the same key → **200** `{…, replayed:true}` (no new files/charges). Errors: 409 `scan_in_progress` (+`job_id`), 409 `idempotency_key_reused`, 400 `no_files\|too_many_files\|empty_file\|invalid_idempotency_key`, 413 `file_too_large`, 415 `unsupported_file_type`, **429 `quota_user_quota\|quota_global_page_cap\|quota_llm_budget\|quota_scans_disabled`** (+`month, pages_used, pages_quota`) — show "enter manually" |
| `GET /jobs/{id}` | poll ~1 s → 2 s | `JobOut`. Stage labels: `queued/ocr` → "Reading receipt", `llm` → "Understanding items", `validating` → "Checking totals". Terminal: `succeeded` / `needs_review` (items are on the bill, open review with `validation` problems highlighted) / `failed` (`error_code`, `retryable`) / `cancelled` |
| `POST /jobs/{id}/cancel` | — | `JobOut` (no-op if already finished); bill goes back to `draft` |
| `POST /jobs/{id}/retry` | — | 202 `JobOut` — only `failed`/`cancelled` with `retryable`; resumes from the last completed stage (saved OCR ⇒ no second Azure bill). 409 `not_retryable`, 429 `quota_*` |
| `GET /bills/{id}/files/{file_id}` | — | `{url, expires_in: 300, mime}` short-lived signed URL (Supabase in prod; `/api/dev/files/...` locally). 410 `file_expired` after 90 days |

While a job is active the bill is `scanning` and `PUT /receipt`, `PUT /quick` and status changes return 409; participants can be edited meanwhile (scan-first flow). On success/needs_review the bill becomes `review` with items, charges, totals, merchant, date and `receipt_meta` filled; a user-entered title is kept. Failure codes include `ocr_empty` (not retryable), `ocr_rate_limited`, `ocr_timeout`, `ocr_failed`, `llm_timeout`, `llm_http_5xx`, `llm_refused`, `quota_llm_budget`, `interrupted`, `internal_error`.

### 6.7 Share links

| | Request | Response |
|---|---|---|
| `POST /bills/{id}/share-links` | optional `{person_id?: UUID\|null (null = whole bill), expires_in_days?: 1–365}` | 201 `{id, person_id, created_at, expires_at, revoked_at, last_viewed_at, token, path:"/s/<token>", url}` — **token shown once** |
| `GET /bills/{id}/share-links` | — | `{items:[{id, person_id, created_at, expires_at, revoked_at, last_viewed_at}]}` |
| `DELETE /bills/{id}/share-links` / `…/share-links/{link_id}` | — | 204 (revoke all / one) |
| `GET /public/share/{token}` (**public**, 30/min per IP, `Cache-Control: no-store`) | — | `{title, merchant, bill_date, currency, settle_currency, fx_rate, effective_currency, grand_total_cents, settle_grand_total_cents, payer_name, scope:"person"\|"bill", person: PublicPerson\|null, people: PublicPerson[]}` with `PublicPerson = {name, is_payer, items:[{name, share_cents}], items_cents, adjustment_cents, total_cents, settle_total_cents, settled, outstanding_cents /* effective currency */}`; no ids. 404 for unknown/revoked/expired/deleted |

### 6.8 Admin (role admin)

| | Request | Response |
|---|---|---|
| `GET /admin/users?limit=50&cursor=` | — | `{items:[{id, username, email, display_name, role, must_change_password, monthly_scan_quota, disabled_at, created_at, pages_used_this_month}], next_cursor}` |
| `POST /admin/users` | `{username (3–32, [a-z0-9][a-z0-9_.-]*, lower-cased), display_name?, email?, login?: 'password'\|'google', role?: 'member'\|'admin', monthly_scan_quota?}` | 201 `{user, temp_password}` — password login: synthetic email `{username}@{AUTH_EMAIL_DOMAIN}`, temp password shown once, `must_change_password:true`. Google: give the real Gmail in `email` + `login:"google"` → `temp_password:null`, no forced change (this pre-creation is the Google allow-list). 409 `username_taken\|email_taken`, 502 `auth_provider_error` |
| `PATCH /admin/users/{id}` | `{display_name?, role?, monthly_scan_quota?, disabled?}` | user object; disable bans in Supabase too. 409 `cannot_disable_self\|cannot_demote_self` |
| `POST /admin/users/{id}/reset-password` | — | `{temp_password}` and forces a change at next login |
| `GET /admin/usage?month=YYYY-MM` | default current month (APP_TIMEZONE) | `{month, timezone, totals:{ocr_pages, ocr_calls, llm_calls, input_tokens, output_tokens, cost_micros, failed_calls}, global_monthly_page_cap, global_monthly_llm_budget_micros, by_user:[{user_id, username, ocr_pages, llm_calls, cost_micros, quota}], by_model:[{model, calls, failed_calls, input_tokens, output_tokens, cost_micros, avg_latency_ms}]}` |
| `GET /admin/settings` | — | `{global_monthly_page_cap, global_monthly_llm_budget_micros, default_user_quota, scans_enabled, llm:{primary_model, primary_reasoning_effort, fallback_model, fallback_reasoning_effort, timeout_seconds, max_retries, backend}, ocr_backend, ocr_max_pdf_pages, scan_max_files, scan_max_file_bytes, receipt_retention_days, app_timezone, updated_at}` |
| `PATCH /admin/settings` | `{global_monthly_page_cap?, global_monthly_llm_budget_micros?, default_user_quota?, scans_enabled?}` | same as GET |

### 6.9 Internal

`POST /internal/maintenance` — header `Authorization: Bearer <CRON_SECRET>` → `{purged_files, purge_failures, failed_stale_jobs, db:"ok"}`. Purges photos past `expires_at` (≤ 2,000/run), fails stale jobs, touches the DB (prevents the Supabase 7-day pause). 401 wrong secret, 503 if `CRON_SECRET` unset. Schedule daily from GitHub Actions in P5.

### 6.10 Frontend notes

- Login form: a username without `@` maps to `${username}@${VITE_AUTH_EMAIL_DOMAIN}` for `signInWithPassword`; `VITE_AUTH_EMAIL_DOMAIN` must equal `AUTH_EMAIL_DOMAIN` (default `users.even.app`). Local/CI without Supabase: use the dev login (§11.5).
- After login call `GET /me`; if `must_change_password`, show the change-password screen → `supabase.auth.updateUser({password})` → `POST /me/password-changed`.
- Compress photos client-side to **JPEG** (Azure DI does not accept WebP), long edge ≤ 2000 px, < 1.5 MB.
- The TS split mirror must pass `shared/split-vectors.json` (`split_cases`, `validation_cases`, `conversion_cases`, `minor_unit_cases`, `tolerance_cases`); `rules` in that file spells out the algorithm. Read exponents from `shared/currencies.json`.

## 7. Environment variables

All documented with comments in the root **`.env.example`**. App: `ENVIRONMENT, LOG_LEVEL, APP_TIMEZONE, DEFAULT_CURRENCY, PUBLIC_APP_URL, CORS_ORIGINS`. DB: `DATABASE_URL, DATABASE_SSL, DB_DISABLE_PREPARED_STATEMENTS, DB_POOL_SIZE, DB_MAX_OVERFLOW`. Auth: `SUPABASE_URL, SUPABASE_ANON_KEY (frontend), SUPABASE_JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ADMIN_BACKEND, AUTH_EMAIL_DOMAIN, JWT_AUDIENCE, JWT_LEEWAY_SECONDS, JWKS_CACHE_SECONDS`. OCR: `OCR_BACKEND, AZURE_DI_ENDPOINT, AZURE_DI_KEY, OCR_MAX_CONCURRENCY, OCR_MAX_PDF_PAGES, OCR_TIMEOUT_SECONDS`. LLM: `LLM_BACKEND, OPENAI_API_KEY, LLM_PRIMARY_MODEL, LLM_PRIMARY_REASONING_EFFORT, LLM_FALLBACK_MODEL, LLM_FALLBACK_REASONING_EFFORT, LLM_TIMEOUT_SECONDS, LLM_MAX_RETRIES, LLM_MAX_OUTPUT_TOKENS, LLM_PRICES`. Storage: `STORAGE_BACKEND, STORAGE_BUCKET, LOCAL_STORAGE_DIR, SIGNED_URL_TTL_SECONDS, RECEIPT_RETENTION_DAYS`. Scans: `SCAN_MAX_FILES, SCAN_MAX_FILE_BYTES, JOB_HEARTBEAT_SECONDS, JOB_STALE_SECONDS`. Quotas: `DEFAULT_USER_MONTHLY_QUOTA, GLOBAL_MONTHLY_PAGE_CAP, GLOBAL_MONTHLY_LLM_BUDGET_USD`. Guardrails: `RATE_LIMIT_ENABLED, RATE_LIMIT_DEFAULT, RATE_LIMIT_SCANS, RATE_LIMIT_PUBLIC, RATE_LIMIT_ADMIN_CREATE, MAX_JSON_BODY_BYTES, CRON_SECRET`. Frontend: `VITE_API_URL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_AUTH_EMAIL_DOMAIN`. Tooling: `SUPABASE_ACCESS_TOKEN, RENDER_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID`.

Render (P5) must set at least: `ENVIRONMENT=production, DATABASE_URL (session pooler), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET (if the project still signs HS256), STORAGE_BACKEND=supabase, AZURE_DI_*, OPENAI_API_KEY, CRON_SECRET, CORS_ORIGINS, PUBLIC_APP_URL, AUTH_EMAIL_DOMAIN`, plus the quota numbers once the owner answers.

The root `.env` I created holds the real OpenAI/Azure keys (renamed `OCR_*` → `AZURE_DI_*`) plus local-dev values (compose DB, fake Supabase admin, local storage, generated dev JWT secret and CRON secret).

## 8. Deviations from the BRIEF (with reasons)

1. **Split modes** are `single | equal | weighted | custom` (+ `NULL` = unassigned). `weighted` covers "multi percentage", "by shares" and quick split; the BRIEF's §4.2 listed three modes.
2. **Rounding** follows one exact rule (`allocate`, §4); where the old float UI was 1 ¢ off the grand total, the contract fixes it (vectors mark these). Zero assigned subtotal with a non-zero total gives everything to the first participant (old behaviour) **and** raises `zero_items_subtotal`, so the UI blocks instead of showing it.
3. **WebP is rejected**: Azure DI `prebuilt-layout` accepts JPEG/PNG/BMP/TIFF/HEIF/PDF only (Microsoft docs). BRIEF §4.3 said "JPEG/WebP" — the client must produce JPEG.
4. **Extra routes**: `PATCH /me`, `GET /me/summary`, `PUT /bills/{id}/quick`, `GET /bills/{id}/share-links`, `DELETE /bills/{id}/share-links/{link_id}`, `PATCH /admin/users/{id}`, `POST /admin/users/{id}/reset-password`.
5. **Schema refinements**: `item_shares.bill_id/position`; `receipt_files.job_id`; job `error_message/pages_billed/cost_micros/started_at/finished_at`; usage `cached_input_tokens/error_code`; share `owner_id/last_viewed_at`; `app_settings.scans_enabled` (admin kill switch for scanning); `bills.receipt_meta`; `profiles.email`; usernames stored lower-case (CHECK) instead of a case-insensitive index; `bills.subtotal_cents` is the subtotal *as printed* (the derived subtotal lives in `validation.final_subtotal_cents`) because re-validating a derived subtotal would flip tax-inclusive receipts to failures.
6. **People list isn't paginated** (bounded at 300 active per account); bills and admin users are cursor-paginated.
7. **Quota exhaustion is 429 with `code: quota_*`** (distinct from `rate_limited`).
8. **Temp-password gate is enforced by the API** (403 `password_change_required`), not only the UI.
9. **Default rate limit is a dependency**, not slowapi middleware (incompatible with FastAPI 0.142 nested routers).
10. **Stale-job recovery** uses heartbeat age (not "every active job at startup"), plus lazy recovery on poll and interrupted-marking on graceful shutdown — safe during Render's overlapping deploys.
11. **No FK `profiles.id → auth.users`** (the `auth` schema doesn't exist in local/CI Postgres).

## 9. Tests (164, all green)

`test_core_split.py` (money/allocate worked examples, property tests, all 34 split vectors) · `test_core_validation.py` (validation worked examples + 14 vectors, charge kinds, pricing, SG month bounds, OCR page joining) · `test_auth.py` (HS256, ES256/JWKS, alg none, expired, wrong aud/iss, not provisioned, disabled, temp-password gate, admin gate) · `test_bills.py` (people CRUD/caps, receipt/validation, item-id preservation, all assignment modes + rules, participant removal, quick split, payer/status, cursor pagination, soft delete, input caps, settle/unsettle/partial, summary by currency, **owner isolation on 16 routes**, profile-delete cascade) · `test_scans.py` (success + usage rows, needs_review, escalation on reconcile failure and on error, LLM failure → retry without OCR re-billing, OCR failure → retry, cancel mid-OCR → retry, stale/poll/shutdown recovery, interrupted retry from saved OCR, idempotent replay + key reuse, one active scan per bill, user/global/LLM/kill-switch quotas, per-call LLM budget, file rules, multi-file + PDF pages, signed URLs + expiry, job/file isolation, scan rate limit) · `test_share_admin_ops.py` (share links per-person/whole/revoke/expire/minimal data/rate limit, admin create/Google/failure compensation/patch/disable/reset/pagination/usage/settings/rate limit, maintenance auth + purge + stale jobs, CORS allow/deny, error envelopes keep CORS incl. 500, body limit incl. streamed, default rate limit, RLS + revoked grants, models == migrations).

## 10. Open items / risks

- **Owner keys & answers** (see `OWNER_ACTIONS.md`): Supabase project (URL, service key, JWT secret or JWKS), project-scoped OpenAI key + monthly budget (then set `GLOBAL_MONTHLY_LLM_BUDGET_USD` slightly below it), admin username, default currency (SGD assumed), Azure tier/region confirmation. Rotate the OpenAI/Azure keys that were in `backend/.env` if they were ever shared.
- **Never exercised against real services:** Azure DI `.aio` (0 calls by design), Supabase Auth admin API, Supabase Storage, JWKS from a real project. P5 smoke: create admin, Google allow-list linking (signups off; Supabase must auto-link the Google identity to the pre-created user with the same verified email), `ensure-bucket`, one real scan. Verify Supabase accepts the synthetic `AUTH_EMAIL_DOMAIN` (`users.billsplitter.app` by default) — change it if GoTrue rejects it.
- **Benchmark (P4):** primary reasoning effort `low` vs `none`; overlapping multi-photo receipts may produce duplicate items (prompt kept verbatim per owner); confirm F0 concurrency (`OCR_MAX_CONCURRENCY=2`) doesn't hit 429s; re-check model prices.
- **In-process jobs need exactly one uvicorn worker** (render-start.sh does this). Render free sleeps after ~15 min idle; active polling keeps it awake, and a deploy marks running jobs interrupted/retryable.
- **Root `.gitignore` (not mine to edit) ignores `lib/`, `public`, `build/`, `dist`, … globally** — `frontend/src/lib/` and `frontend/public/` would be silently untracked. Fix before P3 commits (e.g. anchor those patterns or add `!frontend/src/lib/`).
- **Leftovers outside my scope** (candidates for cleanup by the coordinator): `splitwise.ipynb`, `splitwise_package_for_ref/`, `DATABASE_MIGRATION.sql`, `setup_env.py`, outdated `README.md`/`SETUP.md`/`SESSION_SETUP.md`, `set-up-windows.cmd` (conda flow; backend now runs in Docker). In `backend/`: the stale secrets copy `backend/.env` and **`backend/uploads/` (62 real receipt photos, gitignored)** — useful for the P4 benchmark if moved to `.local/receipts/`; I deleted neither.
- CI hasn't run on GitHub yet (nothing pushed). The workflow uses `actions/checkout@v7`, `actions/setup-python@v7` (latest at time of writing).

## 11. P1b — multi-currency, user FX rates, dev login

### 11.1 Minor units
- `shared/currencies.json` — 154 circulating ISO 4217 currencies `{code, exponent, symbol, name}`: JPY/KRW/VND/IDR/CLP/ISK/XAF/XOF… 0 dp, BHD/KWD/OMR/JOD/TND/LYD/IQD 3 dp, the rest 2 dp. **IDR is 0 dp by owner decision (ISO 4217 says 2).** `backend/app/core/data/currencies.json` is a byte-identical copy because the Render image builds from `backend/` only; a test enforces parity, so edit `shared/` and copy.
- Every `*_cents` field = minor units of its currency (names kept to avoid churn; documented in `core/money.py`). Helpers: `to_cents(amount, exponent)`, `format_cents(cents, exponent)`, strict `parse_major(text, exponent)` (rejects extra decimals).
- Validator tolerance = `max(1, ROUND_HALF_UP(0.05 × 10^exp))` → 5 (SGD), 1 (JPY), 50 (KWD); messages use the currency's decimals. SGD behaviour and all pre-existing vectors are unchanged.
- Unknown currency codes are rejected (422) everywhere a currency is accepted.
- Changing a bill's `currency` **relabels** its amounts: same major-unit values, minor units rescaled when exponents differ (×10^k going up; ROUND_HALF_UP going down, e.g. S$46.68 → ¥47). Any conversion is cleared unless given in the same request.

### 11.2 Saved rates — `/api/me/fx-rates` (typed by the user; no FX API, ever)
| | Request | Response |
|---|---|---|
| `GET /me/fx-rates` | — | `{items:[{base, quote, rate: Dec, derived:false, updated_at}]}` |
| `GET /me/fx-rates/{base}/{quote}` | — | `{base, quote, rate, derived, updated_at}`; `derived:true` = `1 / stored inverse` (12 significant digits). 404 if neither direction is saved |
| `PUT /me/fx-rates/{base}/{quote}` | `{rate}`: 1 base = rate quote; > 0, ≤ 15 significant digits, 1e-12…1e12 | the saved rate; replaces the pair in **either** direction (one row per pair) |
| `DELETE /me/fx-rates/{base}/{quote}` | — | 204 (either direction); 404 if none |

Codes are case-insensitive; 400 `unknown_currency`, 400 `same_currency`. Table `fx_rates(owner_id, base, quote, rate NUMERIC (arbitrary precision), updated_at, unique(owner, base, quote))`, RLS deny-all.

### 11.3 Per-bill conversion (snapshot)
- `PATCH /bills/{id}` with `settle_currency` (+ optional `fx_rate`): the rate is **copied** onto the bill (`bills.fx_rate`) from the typed value or the saved rate (direct or derived inverse); 400 `fx_rate_required` if neither. Later edits to saved rates never change old bills. `save_rate:true` also stores the rate in `/me/fx-rates`. `settle_currency:null` clears the conversion; `fx_rate` alone re-types the snapshot.
- **Locked** once any participant has settled (`currency_locked:true`; 409 `currency_locked` for `currency`, `settle_currency` and `fx_rate`). Undo the settlements to change it.
- Maths: `settle_grand_total = ROUND_HALF_UP(grand_minor × fx_rate × 10^(settle_exp − bill_exp))`, then `allocate(settle_grand_total, per-person bill-currency totals)`, so converted shares sum exactly (`conversion_cases` vectors). Split, bill and share link return both currencies; `effective_currency = settle_currency ?? currency`. Settlements (`settled_amount_cents`, default `effective_total_cents`) and `outstanding_cents` are in the effective currency.
- `/me/summary` groups by effective currency and adds `home` (the profile's default currency), which sums **only** bills whose effective currency is home. Other currencies stay separate and are never converted implicitly.

### 11.4 Extraction
- The LLM schema gained `currency: string | null` (ISO code only if printed or clearly implied by symbols or the address) with one added prompt line (rule 6); the rest of the prompt is unchanged.
- Extracted major-unit amounts use the **bill currency's** exponent. A different, valid detected code is stored on the job as `detected_currency` (in `JobOut` and `BillOut.latest_job`) and **not applied**; the UI offers a one-tap `PATCH {currency}`, which relabels amounts per 11.1.

### 11.5 Dev-only login (local + CI E2E without Supabase)
Mounted only when `ENVIRONMENT != production` **and** `SUPABASE_ADMIN_BACKEND=fake` (tests assert it's absent otherwise, including in a production app).

| | Request | Response |
|---|---|---|
| `POST /api/dev/auth/login` | `{username (or email), password}` | `{access_token, token_type:"bearer", expires_in: 43200}`: HS256 with the same claims as `dev-token` / a Supabase access token. Password = the one the in-memory fake admin holds for that user (users created via `/admin/users` in the running process), else `DEV_LOGIN_PASSWORD`; unset means reject. 401 `invalid_credentials`, 403 `account_disabled` |
| `POST /api/dev/auth/password` (Bearer; allowed before the temp-password change) | `{password (≥ 6)}` | 204; stores it in the fake admin (mirror of `supabase.auth.updateUser`). Then call `POST /me/password-changed` |

`python -m app.cli dev-seed` (same guards) creates or restores deterministic data:
- admin **george** + members **maya, arjun, lena, tomas** (no forced password change; log in with `DEV_LOGIN_PASSWORD`);
- george's saved people (the four members + "Priya Raman") and a saved rate JPY→SGD 0.0091;
- **Saturday hotpot** (SGD, complete; Maya settled in full, Arjun partially with S$20.00);
- **Kyoto ramen night** (JPY, tax-inclusive, converted to SGD at the 0.0091 snapshot, complete);
- **Team lunch** (SGD, `review`, items 39.10 vs printed subtotal 41.10 → `items_subtotal_mismatch`, unassigned).

It is idempotent: re-running restores the same IDs and state. The root `.env` now holds a random local `DEV_LOGIN_PASSWORD`; CI E2E should set its own.

### 11.6 Env
New: `APP_NAME` (default `even`), `DEV_LOGIN_PASSWORD` (dev only, default empty). Changed default: `AUTH_EMAIL_DOMAIN=users.even.app` (and `VITE_AUTH_EMAIL_DOMAIN`). `DEFAULT_CURRENCY` must be a code from `shared/currencies.json`.

### 11.7 Schema (migration `0002`, additive)
`fx_rates` (above); `bills.settle_currency` + `bills.fx_rate` (both or neither, settle ≠ currency, rate > 0); `extraction_jobs.detected_currency`.

### 11.8 Open
- Switching currency after a scan rounds when the exponent shrinks (2 → 0). That's fine for "the receipt was in yen all along" (whole numbers) and lossy otherwise; the review screen shows any resulting mismatch.
- Settlements are single amounts in the effective currency; there is no per-payment currency (by design: currencies are never mixed).
