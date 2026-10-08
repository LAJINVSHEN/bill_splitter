# Audit handover - 2026-10-07

## Verdict

The current UI is visually coherent and the main local happy paths work, but this is **not 100% functional or production-ready**. Keep PR #2 draft. Fix the three reproduced P1 bugs below before committing the remaining bill flow and running CI again. Production provisioning is separately blocked by missing owner credentials/configuration.

Scope: `production-rebuild` at `ad69594`, including the existing uncommitted bill-flow, query/type and image changes. This was an audit, not an application-code fix. No merge, push, deployment or new paid-provider calls were performed.

## Confirmed findings

| Priority | Gap | Evidence and controlling code |
|---|---|---|
| P1 | Partial payments can remove outstanding money from Home, as well as mark the bill list settled. | A SGD 30 weighted split owed SGD 20. Recording SGD 5 left SGD 15 outstanding in bill detail, but list `unsettled_count` became 0 and the bill disappeared from `/me/summary`; Home decreased by SGD 20 instead of SGD 5. Both repository queries filter on `settled_at IS NULL`, not outstanding money: [list](../backend/app/repositories/bills.py#L42), [Home eligibility](../backend/app/repositories/bills.py#L60). The earlier handover's claim that Home always has the right figure is incomplete: another never-paid participant can mask this bug. |
| P1 | Failed "Save & exit" silently loses pending edits. | On a temporary People step, selected a friend, forced the participant PUT to return 503, then immediately exited. Home opened with no failure message; reloading the bill retained only the original participant. [FlowShell](../web/src/app/FlowShell.tsx#L31) navigates immediately, while [useAutosave](../web/src/features/bill/useAutosave.ts#L93) sends the pending value on dispose and ignores errors. Review uses the same saver; its corresponding failure path was code-inspected, not separately reproduced. |
| P1 | Copying one person's share omits the URL. | With native sharing unavailable and clipboard writes captured, "Send link" displayed "Link copied" but copied only `<bill title>: your share`. [useSendLink](../web/src/features/bill/useSendLink.ts#L30) chooses `payload.text` over `payload.url`, although individual sends supply both. The manual-copy fallback receives the same incomplete text. |
| P2 | Generated local share URLs target the wrong server. | The running API's `public_app_url` is `http://localhost:3000`; the new web app is on `http://localhost:5173`. Newly created links confirmed origin 3000. [useSendLink](../web/src/features/bill/useSendLink.ts#L7) prefers that absolute URL. The public share worked unauthenticated when its path was opened on 5173. Align local `PUBLIC_APP_URL` and verify production's actual Pages origin when provisioned. |
| P2 | Home's missing-rate action does not convert the existing bill. | A new unconverted JPY bill showed "Add JPY rate" targeting `/account?rate=JPY`: [HomeSections](../web/src/features/home/HomeSections.tsx#L52). Account saves a reusable rate; existing bills retain their own conversion snapshots. Route to the relevant bill(s) or offer a bill conversion action. No existing saved rates were changed during this audit. |
| P2 | Summary touch actions are too small. | Real coarse-pointer context at 390 x 844 measured person-detail buttons at 28 px high and "Send link"/"Mark paid" at 32 px. The guide requires >=44 px. The local utility classes override the global coarse-pointer minimum: [person row](../web/src/routes/bill/Summary.tsx#L298), [Send link](../web/src/routes/bill/Summary.tsx#L331), [Mark paid](../web/src/routes/bill/Summary.tsx#L336). |

## Production blockers

- `.env.production.local` is absent. Vite production configuration has no `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` or `VITE_API_URL`.
- Owner provisioning values `SUPABASE_ACCESS_TOKEN`, `RENDER_API_KEY`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are absent. Only presence flags were inspected; no secret values were printed.
- GitHub has no repository secrets/variables, no environment and no recorded deployments. The rebuild remains on the draft PR, not `main`.
- Therefore Supabase production login/refresh/password change, Google OAuth, Render health/cold starts, production Storage, real Pages SPA routing and cross-origin production API calls could not be verified. An unrelated existing deployment, if any, is outside the discovered configuration.
- The temporary local preview used a **dev-auth build**, not production Supabase auth. It is not evidence of cloud production readiness.

## Passing verification

| Check | Actual result |
|---|---|
| Current web working tree | Typecheck, ESLint, 142 unit tests, and `VITE_AUTH_MODE=dev` build passed. |
| Current backend against isolated Postgres test DB | 241 passed, 3 skipped. Every external provider was faked; the development database was not reset. |
| Existing Playwright suite | 20 passed, 1 intentionally skipped: desktop-sidebar assertion in the mobile project. |
| Responsive read-only sweep | 9 routes x 5 widths = 45 observations, 320/390/768/1440/2560 px. Archivo loaded. No horizontal page overflow, out-of-viewport controls, short touch targets on those nine routes, or page exceptions. Bill summary was checked separately and has the touch-target issue above. |
| Visual inspection | Reviewed real-font phone/desktop screenshots plus manual Review/Assign/Summary, quick split, conversion and a valid share. The ledger layout, typography, colour roles and navigation are consistent. |
| Local API and Vite proxy | `/api/health` and `/api/health/ready` returned 200 directly and through Vite. CORS accepted origin 5173 (200) and rejected an untrusted origin (400, no allow-origin). |
| Additional real local workflows | Manual create -> people -> review -> assignment -> summary; receipt edits retained assignments; weighted quick split; partial/full payment and undo; unauthenticated person share with noindex; JPY 1,000 at 0.01 -> SGD 10.00, with SGD 5.00 outstanding. The initial conversion discrepancy was audit timing and disappeared under request/persistence verification. |
| Built bundle preview | Dev-auth login screen, authenticated Home/Account, API readiness and Account deep-link reload passed with no page exceptions. Temporary preview on 4173 was stopped; existing Vite/API/DB were left running. |
| Other gates | Raw-colour grep found no violations. Editor diagnostics reported no errors in `web/src` or `backend/app`. |

Temporary `AUDIT 20261007` bills were soft-deleted, which also revokes their links. No pre-existing bill, payment, account or saved FX rate was edited. Ordinary create/participant operations can update people's last-used metadata. No source fixes, commits or branch changes were made.

## Remaining gaps and risks

- Bill-list summaries still omit participant names and validation/unassigned-item counts: [BillSummaryOut](../backend/app/schemas/bills.py#L305). Open/Even filtering is client-side over status pages, not a server balance filter. These are the previously planned backend contract gaps.
- Link management hooks exist but no screen calls them: [queries](../web/src/data/queries.ts#L352). Creating another link on every send eventually meets the backend's 50-unrevoked-links cap; users have no UI to revoke old links. Code-inspected limit, not a 50-send runtime test.
- Home's repository silently limits balance candidates to 500 bills: [repository](../backend/app/repositories/bills.py#L69). Older outstanding money would be omitted beyond that threshold. Code-inspected growth risk, not threshold-tested with 501 bills.
- The passing existing browser suite does **not** cover bill creation/mutations, successful account/admin writes, settlement, valid shares or bill conversion. This audit exercised several missing paths with a private script, but they still need durable regression tests, especially the three P1 repros.
- Real-receipt test fixtures are currently empty, causing two backend skips; live LLM testing is opt-in and skipped. The private benchmark reports 9 unique photos, 9 Azure pages and $0.317 spent, below the stated 25-page/$1 cap. "Correct & reconciled" is only 78-85% across configurations, despite several 100% total-reconciliation rates. Extra/bundle item lines can be wrong without triggering totals-based fallback. Keep mandatory human review; add adjudicated anonymised fixtures and PDF/multi-photo/blurry coverage before stronger accuracy claims.
- The running local API uses **real Azure/OpenAI**, fake auth and local storage. No live scan was submitted here. Existing benchmark results do not certify the entire browser upload/job/cancel/retry/receipt-preview path or its cloud production equivalent.

## Evidence and next actions

Gitignored reproduction script: `.local/audit-20261007.mjs`; modes include `--payment-only`, `--conversion-only`, `--summary-touch-only`, `--layout-only` and `--preview-only`. Requires the E2E-generated local dev session; the preview mode additionally requires the dev-auth preview server. It blocks paid scan/job API paths and cleans up its temporary bills.

Screenshots and layout measurements: `.playwright-mcp/audit-20261007/`. These remain local; do not publish private benchmark receipt content or authentication state.

Recommended order: fix outstanding-money eligibility/counts, make exit await a successful save, fix single-link delivery; add regression tests; correct link origin/FX action/touch targets; then provision production with the owner, run real cloud smoke tests, and commit/push the finished bill flow for fresh CI. Do not merge or deploy based only on the older green `ad69594` CI run.