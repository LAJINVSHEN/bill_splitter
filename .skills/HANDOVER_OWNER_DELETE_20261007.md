# Owner deletion controls - 2026-10-07

Implemented owner bill-history and saved-person deletion. Admin account deletion belongs to the other agent; this work did not edit admin services/routes, Accounts, or admin query hooks. Pending money/list changes were preserved. No existing user data was deleted, no credentials were read or changed, no paid provider was called, and no install, commit, push or deployment was performed.

## Endpoints

All routes below require an authenticated owner. `permanent` defaults to `false` for backward compatibility. Confirmation query values are exact, case-sensitive strings; URL-encode their spaces.

| DELETE endpoint | Behavior |
| --- | --- |
| `/api/bills/{bill_id}` | Soft deletion by default. With `permanent=true`, also erase items, shares, charges, participants, payer, title/merchant/date, totals, conversion, receipt metadata, share links and extracted job payloads. |
| `/api/bills?confirmation=DELETE ALL BILLS` | Delete every current owner's bill across all pages/statuses, including already soft-deleted history. `permanent=true` purges financial history as above. No list limit/filter is applied. |
| `/api/bills?person_id={person_id}&confirmation=DELETE ASSOCIATED BILLS` | Same operation limited to the owner's bills referencing that owned person as payer, participant, item share or share-link target, including soft-deleted bills. The UI uses `permanent=true`. Wrong confirmation scope is 400; missing/unknown confirmation is 422. Unknown/foreign person is 404. |
| `/api/people/{person_id}` | Archive by default. `permanent=true` deletes only an unreferenced, non-self person. References include soft-deleted bills; conflict is 409 `person_referenced` with `bill_count`. Me returns 409 `cannot_delete_self`; default archive retains `cannot_archive_self`. |
| `/api/people?confirmation=DELETE ALL PEOPLE` | Archive all non-self people by default. With `permanent=true`, delete all non-self people, including archived people, without a pagination limit. Any reference conflicts atomically: no person is removed. Me is retained. |

Successful deletes return 204. Repeated bill deletes succeed because tombstones remain; missing/foreign bill IDs return 404. Repeated permanent person deletes (including missing/foreign IDs) return a non-disclosing 204 no-op. Repeated clear operations return 204. Default individual archive remains repeat-safe while the row exists, and returns 404 for unknown/foreign IDs.

Bill deletion first hides bills, revokes share links and expires photos, then marks active jobs cancelled/non-retryable and releases unspent reservations. It waits for in-process workers to stop before financial-history purging. If a worker is still running after cancellation, 409 `scan_stopping` leaves the bills hidden and photos queued; retry deletion to finish. Financial-reference removal is transactional. Bill-history removal followed by person removal is deliberately two operations: if the second fails, erased history is not restored, and the dialog allows retry.

Permanent bill deletion is a destructive history purge, not physical deletion of every database row. Minimal deleted bill and job rows retain photo-purge tracking and accounting. `usage_events` and the existing owner OCR cache remain, so deletion does not refund spent quota/cost or make cached retries re-bill OCR. Photos are purged asynchronously by existing maintenance; a storage outage leaves their durable expired-file queue for retry. No person reference remains on a permanently purged bill. There is no restore API.

## UI

- Bills: individual trash actions in both ledger layouts; clear history is available even with an empty/filtered list. Single deletion is explicitly confirmed; clear-all requires typing `DELETE ALL BILLS` and is server-side, not limited to loaded rows.
- People: non-self rows have permanent deletion controls; clear-all requires `DELETE ALL PEOPLE` and includes archived records. Archived records are not added to the existing active-person list.
- Referenced-person conflicts offer archive to preserve history, or a second explicit confirmation before erasing associated bills for every participant. Bulk conflict recovery clearly warns that it erases all bill history, then deletes saved people. Me remains.
- Destructive controls have names/tooltips and 44px targets. Pending confirmation cannot dismiss the dialog; errors remain visible for retry. Queries for bill details, lists, summary, jobs and usage are cancelled/removed/refreshed as appropriate.

## Files Changed By This Work

- `backend/app/api/bills.py`, `backend/app/services/bills.py`
- `backend/app/api/people.py`, `backend/app/services/people.py`, `backend/app/repositories/people.py`
- `backend/tests/test_bills.py`
- `web/src/routes/Bills.tsx`, `web/src/routes/People.tsx`
- `web/src/data/queries.ts`: only owner delete/clear hooks, no useBills/admin edits
- `web/src/features/home/BillList.tsx`: optional row deletion controls
- `web/src/features/home/home.test.ts`: reused existing route/query test harness
- This handover. No schema/type changes were needed.

## Verification

- Immediate focused backend checks passed after each edit: compatibility/clear (2), purge/people (5), worker/queue/quota (4).
- Backend full suite: **300 passed, 8 skipped** in a dedicated temporary `bill_splitter_owner_delete_tests_339c81d3` database with fake providers. The eight skips are explicit paid LLM tests. An earlier full run was invalidated by another agent concurrently resetting the shared test DB; the dedicated run supersedes it.
- Frontend focused ledger/deletion suite: **26 passed**, including 10 new cases. All frontend unit tests: **202 passed**.
- Typecheck/build and ESLint passed. Initial test typing issues and duplicate alert roles were corrected and revalidated.
- Playwright: four fully mocked browser scenarios at 320/390/1440/2560px. Cancellation, typed confirmations, failure feedback, person conflict, associated-bill purge/retry and self protection passed. No API traffic was forwarded to real data, no page errors, no page overflow, all measured destructive targets >=44px.
- Eight screenshots under `.playwright-mcp/owner-deletion/`; inspected phone associated-history confirmation and desktop bills. Raw-color gate and touched-file editor diagnostics passed.

## Remaining Boundaries

- Admin account deletion is separate work, not implemented by this owner-deletion slice.
- Paid providers, production auth/storage and deployed routes were not exercised.
- Repo-wide `git diff --check` reports a pre-existing trailing blank line in `web/src/routes/bill/Summary.tsx`, outside this slice. It was not changed here.