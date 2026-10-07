# Production Brief — Bill Splitter (working name)

> Contract for every agent working on this repo. Read this, then `user_preference.md` (the owner's playbook), then the latest `.skills/HANDOVER_*.md`.
> Decisions here were locked with the owner on 2026-10-07. Do not re-litigate them; surface uncertainty instead of inventing requirements.

## 1. Product

Scan a receipt, say who was there, tap who had what, and share what each person owes. It's built for **10–15 friends** on a **$0/month** stack (except OpenAI usage, which is metered and capped).
It's a task-flow app used a few times a week, so it should feel **functionally obvious with elegant brand moments**, not like a dashboard.

## 2. Locked decisions

| Area | Decision |
|---|---|
| Auth | Supabase Auth. **Username + password accounts created by the single admin** in `/admin`; no self-signup and no email provider. A temp password forces a change on first login. Google sign-in is available **only** to emails the admin pre-created: Supabase signups are disabled, so a Google login can only link to an existing user. Sessions persist and refresh silently (users stay signed in for weeks). |
| LLM | Keep OpenAI and the existing prompt and schema (`backend/app/services/openai_service.py`). Rebuild it as a clean **async wrapper**. Models come from **config**: `LLM_PRIMARY_MODEL`, optional `LLM_FALLBACK_MODEL` (used when the primary errors, times out, or its output fails totals reconciliation), plus timeout, retries and a price table for cost estimates. The admin page shows the active models. |
| OCR | Keep Azure Document Intelligence `prebuilt-layout` → markdown → LLM (two-stage workflow stays). Use the async client. The **F0** tier allows 500 pages/month and **4 MB/file**, and analyses only the first 2 pages of a PDF, so compress images client-side. |
| Photos | Store compressed receipts in Supabase Storage (private bucket). They're **auto-deleted after 90 days**. Bill data is kept forever. |
| Quotas | **Per-user monthly scan quota** (unit = OCR page, default 30, admin-editable per user), a **global monthly page cap** below Azure's 500, and a **global monthly OpenAI $ cap**. At any cap, scanning pauses and manual entry keeps working. Every OCR page and LLM call is logged per user in `usage_events` (pages, tokens, model, latency, cost estimate). |
| Flow | **Scan first.** Extraction runs in the background while the user picks who's splitting, then review → assign → summary. |
| Features in this release | Bill history; resume drafts; per-account saved people; **manual entry & quick split** (equal/by shares, no scan); **multi-photo & PDF receipts**; **settle-up tracking** (who paid, who has paid back); **read-only share link** (no login; per-person view of their items and amount owed). |
| Dropped | Splitwise export (remove code and vendored SDK). |
| Name | Three name + wordmark options are proposed inside the design mockups, and the owner picks. Until then, use the working name "Bill Splitter" only through a single `<Wordmark/>` component. |
| Brand | Keep **white + blue**. Build a full token system per playbook §1.4–1.5 (AA contrast measured, no grey micro-text, colour for annotation, own icon set, no lucide). |
| Hosting | Playbook §2 unchanged: Cloudflare Pages (direct upload via Wrangler from Actions), Render Free Docker (Singapore), Supabase Free (new dedicated project, `ap-southeast-1`), GitHub Actions. |
| Repo | `GeorgePPP/bill_splitter`, **public**. `master` → `main`. Remote `master` has a README commit (`00cec4e`) that local lacks; merge it when re-linking. |
| Owner WIP | Uncommitted edits at kickoff (validation-modal rewrite etc.) are built on top of, not committed separately. |
| Checkpoints | Phases run autonomously with sub-agents. Stop **only** for (1) mockup sign-off before porting UI, and (2) keys and dashboard steps. Each phase ends with a `.skills/HANDOVER_<PHASE>.md`, green `tsc`/build/pytest/Playwright. |

## 3. Non-negotiables (from the playbook, adapted)

1. **Money is never float.** Use integer **cents** in TS and DB (`BIGINT`), and `Decimal` in Python wherever proportional maths happens, with `ROUND_HALF_UP`. Each bill has an explicit 3-letter currency.
2. **Pure functions for all split and validation maths** (`backend/app/core/`, `frontend/src/lib/split/`). There's no I/O in core. Both implementations run the same **golden test vectors** (`shared/split-vectors.json`) to prove parity.
3. **Keep the calculation behaviour** until the owner asks to change it. Each person pays `grand_total × (their item subtotal / all items subtotal)`, and the rounding remainder goes to the largest share; shares must sum *exactly* to the grand total. The tax-inclusive vs tax-exclusive detection in `receipt_validator.py` carries over unchanged in meaning.
4. **One source of truth.** Split results are *derived* from items + shares + charges by the core function, never stored. The share link, history, settle-up and summary all read the same backend computation. The TS mirror is only for an instant preview.
5. **Idempotency** on anything retryable: scan creation (`Idempotency-Key`), OCR (content-hash cache per owner, so a retry never re-bills Azure), settle actions.
6. **Expensive calls are async, cancellable, resumable.** No blocking SDK calls inside `async def`. Persist after every stage.
7. **Guardrails from day one:** RLS on every `public` table, rate limiting (`slowapi`), request size limits, CORS allowlist, quota checks *before* spending, `CRON_SECRET`-guarded internal routes, `timeout-minutes` on every workflow job, and a deploy kill switch.
8. **No over-engineering.** Monolithic FastAPI with in-process `asyncio` background tasks. No Celery, no Redis, no queues.

## 4. Architecture

```
Browser ──static──▶ Cloudflare Pages (SPA)
   │  supabase-js (session only)
   ├──────────────▶ Supabase Auth
   └─Bearer JWT──▶ Render Free · FastAPI (Docker, Python 3.12)
                      ├─ asyncpg (session pooler) ─▶ Supabase Postgres 16
                      ├─ service role ─▶ Supabase Storage (receipts, private)
                      ├─ aio client ─▶ Azure Document Intelligence (prebuilt-layout)
                      └─ AsyncOpenAI ─▶ OpenAI (primary → fallback model)
GitHub Actions: CI · deploy (Render hook, Wrangler) · cron (keep-warm, daily maintenance)
```

### 4.1 Backend layout (playbook §4.1)

```
backend/app/
  main.py · config.py (pydantic-settings, ROOT .env) · database.py
  middleware/auth.py      Supabase JWT via JWKS (+HS256 fallback), get_current_user, require_admin
  api/                    thin routers
  services/               orchestration + transactions (bills, people, scans/jobs, usage, admin, share)
  core/                   PURE: split.py, receipt_validation.py, money.py, pricing.py
  integrations/           azure_ocr.py, llm.py (OpenAI wrapper), storage.py (Supabase Storage)
  repositories/           SQLAlchemy access, always filtered by owner_id
  schemas/ · models/
backend/alembic/          async env.py, committed migrations (incl. RLS policies)
backend/tests/            pytest, real Postgres 16, Azure/OpenAI faked at the integration boundary
```

### 4.2 Data model (draft; refine in Phase 1)

- `profiles` (id = auth.users.id, username unique ci, display_name, role admin|member, must_change_password, monthly_scan_quota, default_currency, disabled_at)
- `people` (owner_id, name, colour seed, last_used_at, archived_at): the per-account address book. One row per owner is flagged `is_self` ("Me").
- `bills` (owner_id, title, merchant, bill_date, currency, status draft|scanning|review|assigning|complete, source scan|manual|quick, payer_person_id, subtotal_cents, grand_total_cents, tax_scenario, deleted_at)
- `bill_items` (bill_id, position, name, quantity NUMERIC, unit_price_cents, total_price_cents, split_mode single|equal|custom)
- `item_shares` (item_id, person_id, amount_cents | weight): mirrors the current single / multi / custom assignment model
- `bill_charges` (bill_id, name, kind tax|service|discount|rounding|other, amount_cents, percent)
- `bill_participants` (bill_id, person_id, position, settled_at, settled_amount_cents)
- `receipt_files` (bill_id, owner_id, storage_path, sha256, mime, bytes, pages, position, expires_at, deleted_at)
- `extraction_jobs` (bill_id, owner_id, status queued|ocr|llm|validating|succeeded|needs_review|failed|cancelled, attempts, error_code, retryable, ocr_text, extracted JSONB, validation JSONB, model_used, idempotency_key, heartbeat_at, timings)
- `ocr_cache` (owner_id, content_sha256, ocr_text, pages)
- `usage_events` (user_id, job_id, kind ocr|llm, provider, model, pages, input_tokens, output_tokens, cost_micros, latency_ms, ok, created_at)
- `share_links` (bill_id, person_id NULL = whole bill, token_hash, expires_at, revoked_at)
- `app_settings` (singleton: global_monthly_page_cap, global_monthly_llm_budget_micros, default_user_quota)

### 4.3 Scan pipeline

1. **Client:** compress each photo (long edge ≤ 2000px, JPEG/WebP ≈ 0.8, target < 1.5 MB). PDFs pass through (≤ 4 MB).
2. `POST /api/bills/{id}/scans` (multipart, `Idempotency-Key`) checks quotas, stores files, creates the job, and returns **202 `{job_id}`** immediately.
3. A background task runs OCR per page (bounded concurrency for F0 limits) and joins the markdown with page markers. The result goes in `ocr_cache` and `ocr_text`. Then the LLM primary model runs; on error, timeout or failed reconciliation it moves to the fallback model. Validation follows, then the items, charges and totals are persisted. The job's `status` and `heartbeat_at` are updated at each stage.
4. **Client:** polls `GET /api/jobs/{id}` (TanStack Query, ~1s → 2s backoff) and shows the real stage ("Reading receipt" → "Understanding items" → "Checking totals") while the user adds people.
5. `POST /jobs/{id}/cancel` cancels the task. `POST /jobs/{id}/retry` resumes from the last completed stage (cached OCR, so it costs LLM only). On startup, jobs with a stale heartbeat become `failed{code: interrupted, retryable: true}`.
6. **Validation failure isn't an error state.** It's `needs_review` with the extracted data, so the review screen opens with the problems highlighted (today's behaviour, made durable).

### 4.4 API surface (all `/api`, Bearer JWT unless marked)

`GET /health` (no DB) · `GET /health/ready` (DB) · `GET /me` · `POST /me/password-changed` · `GET /me/usage`
`/people` CRUD · `/bills` list (cursor-paginated, status filter) / create / get / patch / delete
`PUT /bills/{id}/receipt` (items + charges + totals → validation result) · `PUT /bills/{id}/participants` · `PUT /bills/{id}/assignments` · `GET /bills/{id}/split`
`POST|DELETE /bills/{id}/participants/{person_id}/settlement`
`POST /bills/{id}/scans` · `GET /jobs/{id}` · `POST /jobs/{id}/cancel|retry` · `GET /bills/{id}/files/{file_id}` (short-lived signed URL)
`POST|DELETE /bills/{id}/share-links` · **public** `GET /public/share/{token}`
`/admin/users` (create with temp password, reset password, quota, disable) · `GET /admin/usage?month=` · `GET|PATCH /admin/settings`
**internal** `POST /internal/maintenance` (Bearer `CRON_SECRET`): purge expired photos, fail stale jobs, touch DB (prevents Supabase's 7-day pause)

### 4.5 Frontend (to be confirmed by mockups)

React 19, Vite, TS, Tailwind v4 `@theme` tokens, TanStack Query v5, React Router v7, supabase-js v2, React Hook Form + Zod, own `<Icon/>` set, `lib/api.ts` fetch wrapper (no axios), Vitest, Playwright (desktop + Pixel 5).
Routes: `/login` · `/` home (start a bill, resume drafts, outstanding) · `/bills/:id/{scan,people,review,assign}` · `/bills/:id` summary/settle/share · `/bills` history · `/people` · `/account` · `/admin` · `/s/:token` public share.
Server autosave (debounced) at every step, so closing the tab never loses work.

## 5. Phases

| Phase | Owner | Exit criteria |
|---|---|---|
| P0 Foundation | main | branch `production-rebuild`, repo hygiene, root `.env` + `.env.example`, docker-compose Postgres 16 |
| P1 Backend core | sub-agent (background) | schema + RLS + migrations, auth, all §4.4 routes, async pipeline, quotas/usage, pytest green on Postgres 16, CI workflow |
| P2 Design | main | mobile + desktop mockups, 3 names → **OWNER GATE** |
| P3 Frontend rebuild | main + sub-agents by area | approved design ported, TS split parity with golden vectors, `tsc -b` + build green |
| P4 Quality | sub-agents | Vitest, Playwright desktop + Pixel 5, Lighthouse, contrast + layout measurement, model benchmark on owner receipts |
| P5 Deploy | main | Supabase/Render/Cloudflare/GitHub configured, workflows green, smoke tests (health, CORS preflight, login, scan) |

## 6. Needs from the owner

Tracked in `.skills/OWNER_ACTIONS.md`.
