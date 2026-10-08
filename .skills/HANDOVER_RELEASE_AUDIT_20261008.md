# Release audit and handoff - 2026-10-08

## Answer

**No: missing production credentials are not the only issue or blocker.** The pushed rebuild is not ready to merge/deploy. CI has a confirmed E2E failure, strict OpenAI spending enforcement needs work, and bill deletion does not yet provide consistent full receipt-data erasure.

Snapshot: `production-rebuild`, commit `b00dcd3df3869c2a19e8a872ffb0668d2fd36384`, synchronized with GitHub. Draft [PR #2](https://github.com/LAJINVSHEN/bill_splitter/pull/2). Worktree was clean before this handoff, including the two files reported as changed. Application code was not edited during this audit.

## Release blockers

### P1 - Integrated browser CI is red

[CI run 37648478891](https://github.com/LAJINVSHEN/bill_splitter/actions/runs/37648478891) completed with **failure** on the pushed commit. Backend migrations/tests/Docker build passed; frontend typecheck/build/unit tests passed. E2E: **34 passed, 2 failed, 1 skipped**.

The failures are the mobile receipt and participants "Save & exit" cases in [bill-flow.spec.ts](../web/e2e/bill-flow.spec.ts#L242). Existing logs show HTTP **429 instead of 200** for bill/people reads and temporary-bill cleanup; retries also time out waiting for the manual-entry field. The receipt test failed at its persisted-state read near [the assertion](../web/e2e/bill-flow.spec.ts#L297).

Rate-limit/request accumulation is the leading cause to confirm, not a proven save-data regression. Both the current local API and CI have rate limiting enabled; the current local/default configuration is 300 requests/minute. It is incorrect to describe this as a verified "local disabled, CI enabled" mismatch. The entire suite shares seeded users and accumulates requests. See [default limiter](../backend/app/ratelimit.py#L68), [config](../backend/app/config.py#L130), and [CI E2E setup](../.github/workflows/ci.yml#L103).

Next: inspect the failed request's `rate_limited` body/bucket and the full-suite request count; provide a test-only request budget or isolated test buckets in the throwaway E2E environment, retaining separate rate-limit coverage. Rerun the affected mobile cases, then the complete non-paid E2E job. Do not weaken production throttling to fix CI, or merely increase browser timeouts.

### P1 - OpenAI monthly budget is not a hard ceiling

Code-confirmed, not a paid overrun experiment: [pipeline budget check](../backend/app/services/pipeline.py#L337) rejects only when recorded `used >= budget`. It does not reserve the next call's maximum cost or coordinate in-flight LLM calls. [Budget state](../backend/app/services/usage.py#L143) reads recorded usage; [before_call](../backend/app/services/pipeline.py#L317) then allows the model request. One call can exceed the small amount remaining, and concurrent calls/fallbacks/retries can jointly exceed the intended cap.

Next: reserve a conservative, price-known maximum cost atomically before each provider call, including retry/fallback bounds; reconcile actual usage and release reservations on every terminal path. Add fake-provider tests for near-cap calls, concurrency, unknown prices, failures and fallback. No paid overrun test is needed. Keep provider/project budget controls as defence in depth.

### P1 - Production provisioning and verification are absent

Fresh read-only checks confirmed root/frontend `.env.production.local` absent; required production Vite values absent; owner Supabase/Render/Cloudflare provisioning credentials absent. GitHub repository secrets, variables and environments each have count **0**. No public production URL is established through the discovered configuration.

Owner must enter credentials directly into the ignored root `.env`, not chat. The next agent can then provision Cloudflare Pages -> Supabase -> Render -> GitHub deployment configuration, following [the runbook](DEPLOYMENT.md). Bootstrap the admin and verify the real Supabase password/refresh/change-password flow, optional allow-listed Google login, private Storage, CORS, SPA deep links, maintenance authentication and cold starts. No production readiness claim is justified by the successful local dev-auth build.

Check repository identity before provisioning: canonical repo is `LAJINVSHEN/bill_splitter`, but [provisioning defaults](../scripts/provision/_common.py#L35) still name `GeorgePPP/bill_splitter`. Git pushes redirect successfully; whether each hosting/GitHub-app integration accepts the old identity was not tested.

## Functional and privacy gaps

### P2 - Delete semantics differ between screens

Code-confirmed: [Summary](../web/src/routes/bill/Summary.tsx#L53) calls `useDeleteBill` with only the bill ID; [the hook](../web/src/data/queries.ts#L201) defaults `permanent=false`. Bills history explicitly requests permanent deletion. Therefore a user can choose "Delete bill" on Summary while financial rows are merely hidden, unlike the history action.

Next: align the entry points or make archive versus permanent erasure explicit. Add a shared delete-dialog/hook regression so both screens have the intended semantics. Preserve typed confirmation for bulk operations and do not wipe existing user data while validating.

### P2 - Permanent bill deletion retains receipt OCR cache

Code-confirmed: [permanent purge](../backend/app/services/bills.py#L226) clears items, charges, participants, links and extraction payloads, but does not remove `ocr_cache`. [OcrCache](../backend/app/models/scan.py#L102) stores the owner's full OCR markdown by content hash without a bill FK or expiry. [Cache lookup/write](../backend/app/repositories/scans.py#L83) remains usable after the bill is purged. This is receipt content, not just the intentionally retained quota counters.

Photos are queued, not immediately erased; [maintenance](../backend/app/services/maintenance.py#L31) removes expired Storage objects. Production maintenance cannot run until its default-branch workflow, API URL and cron secret are configured. Do not describe permanent deletion as immediate deletion of every stored receipt datum.

Next: define and implement OCR-content/cache erasure for deleted receipts, accounting for hashes shared with retained bills; verify the eventual blob purge and retention of only necessary accounting/tombstones. Add a fake OCR scan -> permanent delete -> cache/blob erasure regression without paid calls.

## Verification gaps and intended limitations

- **Live scan is not end-to-end certified.** The stale Azure endpoint/key issue was fixed by recreating the local API. DNS, authenticated Azure metadata and API health/readiness returned 200 in the previous pass. No post-fix document analysis, LLM extraction or real browser scan/cancel/retry was performed. The approved one-page/$0.01 smoke was superseded by the request to publish quickly. Respect that cap and get confirmation before resumed spending.
- **Extraction is not 100% accurate.** The existing private benchmark used 9 photos/9 Azure pages/$0.317. "Correct & reconciled" was 78-85% across configurations; matching totals can hide extra/wrong item lines. Eight anonymised adjudicated fixtures now test offline expected data, not current live provider accuracy. Human Review remains required. PDF/multi-photo/blurry coverage is not established.
- **Account deletion has an explicit partial-cleanup state.** Supabase identity removal can succeed before Storage/DB cleanup. Retry is required for `account_cleanup_pending`; disabled rows retain cleanup paths. [Deletion](../backend/app/services/admin.py#L176) also holds an exclusive bills-table lock during final blob cleanup, so concurrent writes can pause. This is code-inspected operational risk; live Supabase/Storage failure behavior and latency were not tested.
- **Browser coverage still omits destructive mutations against real services.** Bill-flow regressions use the real local API; share lifecycle uses mocked responses. Deletion has backend/component tests and prior mocked browser checks, not a live production admin/account/storage purge test. The UI audit covered desktop/phone layouts, not an exhaustive accessibility/performance certification.
- **Deletion safeguards are intentional.** Me/current admin cannot be deleted through these controls. Referenced people require an explicit associated-bill purge first. Anonymised provider usage remains counted so deleting accounts cannot reset Azure/OpenAI allowance.
- **CI does not include an ESLint step.** Local lint was run before publishing; [frontend CI](../.github/workflows/ci.yml#L90) runs typecheck/build/unit tests only. Adding lint is a cheap follow-up, not a substitute for resolving the red E2E gate.

## Recommended next pass

1. Keep PR #2 draft; fix/reproduce the CI 429 interaction and obtain green integrated E2E.
2. Add atomic LLM cost reservations and fake-provider near-cap/concurrency tests.
3. Align Summary/history deletion semantics and remove retained OCR content as specified; verify blob cleanup without touching existing data.
4. Provision production with owner-supplied credentials and verify repository identity, auth, Storage, routing, CORS and maintenance.
5. Perform one explicitly approved, tightly bounded live scan smoke; retain manual review and report its exact pages/cost/result.
6. Commit/push each completed fix with focused checks; merge/deploy only once required gates and cloud smoke tests pass.

## Audit constraints and evidence

This pass inspected current source, existing test definitions/logs, config-presence flags and GitHub metadata. It ran **no local test suites, paid scans, deployments, deletes or application-code changes**. New code-level findings were not experimentally triggered against user data. Older clean/audit handovers describe historical checkpoints; this handoff supersedes any implication that only credentials remain or that the newest CI is green.

Private receipts, `.env` files, `.local`, `.playwright-mcp` and browser auth state must remain ignored. Never print credentials or delete existing bills/people/accounts merely to test these controls.