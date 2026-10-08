# Release pass and handoff (2026-10-08)

This follows [HANDOVER_RELEASE_AUDIT_20261008.md](HANDOVER_RELEASE_AUDIT_20261008.md) and replaces its "Recommended next pass". Branch `production-rebuild`, draft [PR #2](https://github.com/LAJINVSHEN/bill_splitter/pull/2).

## Done in this pass

| Item | Commit | Evidence |
|---|---|---|
| **$0 receipt lines folded into their priced item** (owner report: bundle components showed as separate 1× items) | `53aec5e` | Prompt, schema and OCR are verbatim the same as `8a24902` (the owner's reference); only the model changed. The fold runs after the LLM in `core/item_folding.py`. Folded lines are stored as `bill_items.details` and shown as "with …" on Review, Assign and Summary. Totals and validation are unchanged. Private benchmark replay: the item count matches the adjudicated count on 27/27 runs for `luna@low → sol` (22/27 before). |
| **Bill deletion permanent on both Summary and Bills**, and erases OCR cache | `b530cac` | `useDeleteBill` is permanent-only, and both screens use `DeleteBillNote`. A permanent purge deletes the owner's `ocr_cache` rows for the bill's photos unless another live bill of theirs uses the same photo. Regression: `test_permanent_delete_erases_ocr_cache_unless_a_live_bill_shares_the_photo`. |
| **LLM monthly budget is a hard ceiling** | `2260f0e` | Before every call (primary or fallback), the pipeline reserves the worst-case cost: prompt bytes + schema as input tokens, the full `max_completion_tokens`, uncached price, × SDK attempts. This happens under an advisory lock, stored in `extraction_jobs.llm_reserved_micros`, and is released on usage record, cancel and every terminal path. Unknown model → most expensive price; empty price table → `llm_price_unknown` (fail closed). Fake-provider tests cover near-cap, fallback, concurrency, release on failure/cancel and unknown price. |
| **CI E2E 429s fixed** | `657bb93` | Root cause confirmed from the run log: all specs share the seeded users' 300/min default bucket. The throwaway CI `.env` now sets `RATE_LIMIT_DEFAULT=6000/minute`. Limiting stays on, and production is unchanged. ESLint was added to the frontend job. CI run 37743658840 is **green** (backend, frontend, full E2E). |
| **Desktop layout pass + Home leads with scan/upload** (owner requests) | `a79e9ac` + follow-up | Rules are recorded in FRONTEND_GUIDE (Desktop layout). Home has no "Owed to you" widget. Balances are on People. |
| **Live scan smoke** (owner-approved ≤1 page / ≤$0.01) | n/a | Throwaway API with the fallback disabled (worst case < $0.01), seeded user `maya`, the Popeyes bundle receipt. Result: `succeeded`, `gpt-6-luna`, **1 Azure page, $0.000396** (989 in / 594 out tokens). It returned **2 items** (bundle $21.90 "with 2pc Chicken Tenders, Mardi Gras Mustard Dip, Mashed Potatoes (Reg) ×2"; drink $0.60 "with Reg Mountain Dew"), reconciled `tax_exclusive`, OCR 6.7 s, LLM 8.8 s. A permanent delete then left 0 cache rows, 0 job OCR text and 0 items; the photo is queued for the maintenance purge; LLM reservations are back at 0. |

Local checks this pass: full backend pytest (incl. migration drift), `alembic downgrade base && upgrade head`, web typecheck, lint, 200 unit tests and build. I did not run the E2E suite locally because it would mutate the owner's live local data; CI covers it.

## Still open

1. **Production provisioning (blocked on the owner).** Root `.env` still has empty `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, there are no Render/Cloudflare tokens, and GitHub secrets/vars/environments are 0. Follow [DEPLOYMENT.md](DEPLOYMENT.md) once credentials are in the ignored `.env`.
2. **Repository identity in provisioning defaults.** [`scripts/provision/_common.py`](../scripts/provision/_common.py) still defaults to `GeorgePPP/bill_splitter`. `gh` is authenticated as `LAJINVSHEN`, and pushes go through the redirect. This needs the owner's confirmation before it's changed (an earlier session's auto mode refused it).
3. **Desktop E2E/visual coverage**: the new layout was verified by screenshots at 1024/1440/1920 and 390 px. Specs assert behaviour, not layout.
4. Not changed by this pass and still true: extraction isn't 100% (Human Review stays), account deletion has a retryable partial-cleanup state, and production maintenance needs its cron secret/API URL once deployed.
