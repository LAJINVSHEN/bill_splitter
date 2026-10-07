# Fixes and publishing handover - 2026-10-07

## Implemented

- Home and bill-list balances use outstanding amounts, not payment timestamps. Partial payments and reopened balances remain visible; the old 500-bill summary truncation is gone.
- Bill lists include participant names and validation/unassigned-item counts. Open/Even filtering and cursor pagination run on the server.
- Bill-flow exit waits for pending saves and preserves failed drafts for retry. Assignment saving no longer gives up after six seconds.
- Individual share messages retain the URL in clipboard/manual fallback. Local links use the current app origin; Docker's public origin is pinned to 5173. Summary includes link revocation/limit recovery and 44px touch actions.
- Home's foreign-currency action opens the existing bill rather than saving an unrelated account rate.
- Owner bill/people deletion supports individual and confirmed bulk operations. Permanent person deletion requires referenced bill history to be explicitly removed first; Me is protected.
- Admin account deletion requires username confirmation, prevents self-deletion, removes sign-in/data/receipt blobs, stops jobs, and preserves anonymised provider usage. Partial cleanup failures retain disabled rows for retry.
- Eight anonymised, adjudicated receipt fixtures provide offline regression coverage without publishing private receipts. Locked model prompt/schema were not changed.
- Completed the original pending bill-flow/image and benchmark work without reverting it.

## OCR incident

The running API had stale Azure endpoint/key values from an older root `.env`. The old hostname failed DNS. Recreating only the API container reloaded current configuration, preserved the database, and restored DNS and authenticated Azure metadata access (HTTP 200). API health/readiness return 200. No paid OCR analysis or OpenAI call was made during this fix pass.

After changing Docker `env_file` values, recreate the API; restarting it does not reload them.

## Verification already performed

- Backend full gate during deletion integration: 300 passed, 8 intentional paid-provider skips. Admin deletion additionally passed 12 focused backend tests.
- Web full gate during deletion integration: 202 tests passed; typecheck, lint and dev-auth build passed.
- New real-API bill-flow browser regressions: 9 passed across setup, desktop and mobile. Share lifecycle additionally passed 8 mocked browser checks.
- Earlier UI audit passed 45 font-enabled layout observations at 320-2560px and local health/readiness/CORS checks.
- Final publishing pass only repairs the Playwright callback lint false positive and whitespace; full expensive/slow local gates are not repeated at the owner's request. GitHub PR CI remains the final integrated check.

## Remaining production blockers

The discovered configuration still lacks provider provisioning credentials, `.env.production.local`, production Vite values and GitHub deployment secrets/variables/environment. No cloud deployment or live production authentication/storage smoke test has been performed. Enter credentials directly into the ignored root `.env`, following `.skills/DEPLOYMENT.md`; never paste them into chat.

The owner's approved capped live OCR smoke was not executed because they subsequently requested immediate publishing without expensive/slow operations. Authenticated non-analysis Azure connectivity is verified; a real browser-to-provider scan remains to be smoke-tested. Existing benchmark accuracy is not 100%; manual receipt review remains necessary.

Keep the PR draft until CI and the production setup/smoke checks are reviewed. Private `.local`/`.playwright-mcp` data, env files and browser authentication state must remain ignored.