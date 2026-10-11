# Settle up, balances and the paid toggle (2026-10-11)

Follows [PR #5](https://github.com/LAJINVSHEN/bill_splitter/pull/5) (sharing v2). Branch `feat/settle-up-oct11`. No database migration.

## What the owner asked for, and what was built

| Ask | Built | Where |
|---|---|---|
| Simplify debts across bills (A→B→C becomes A→C), with **Original vs Simplified** options | Pure greedy that follows debt chains, so every payment maps to real bill debts and is recorded as ordinary partial settlements (no transfers table). ~2% of random ledgers need one payment more than the unconstrained textbook greedy; that's the price of recordability. Loops that cancel out ride along with a payment in their group, or get a standalone "Clear". | `backend/app/core/settle.py` (pure), `services/settle_up.py`, `GET /me/settle-up`, `POST /me/settle-up/payments`, `POST /me/settle-up/undo` |
| Multiple currencies | Each currency is simplified on its own by default. "All in SGD" merges using the user's saved hand-typed rates, and each bill is still settled in its own currency (proportional, no rate inversion). Missing rate → says which and links to Account. | same |
| Balances in the People **Balance column**, not a separate section; elegant, no truncation, aligned | Read-only ledger lines: code (left) · amount (right, tabular) · to/from · avatar + first name. Phones get a full-width line under the name. Alignment was measured at 0 px drift (codes, numbers, avatars, cell edge vs header/name). | `web/src/features/settle/SettleBalance.tsx`, `routes/People.tsx` |
| Tap a balance → **breakdown**, consistent with the share link | Dialog: net hero per currency, "To settle" (every payment both ways, each with the toggle), "From the bills" (title · date · who owes whom, Net row, links to the bill). | `SettleBreakdown` |
| **Paid in the breakdown**, not on the row | Done. | |
| **Paid must be revertible**: simple on/off | Shared `PaidToggle` (outlined off, filled with a tick when on, always a 44 px target). Bill page rows use it instead of "Mark paid" + "Undo". Settle-up undo subtracts exactly the pieces that were recorded (keeps earlier partial payments; refuses a second undo). | `web/src/components/PaidToggle.tsx` |
| Money **to me says "Received"**, everywhere | Bill rows when you paid, the breakdown, the person sheet ("Received (SGD)", "Mark received in full"). | `paidByMe()` in `features/bill/flow.ts` |
| **No Edit** on People | Removed (rename/colour dialog). Archive stays via Delete → "Archive instead". | |
| **Never delete people who are on bills** | The "delete associated bills" path is gone from the UI *and* the API (`DELETE /bills` only accepts `DELETE ALL BILLS`; `person_id` is gone). Deleting someone on a bill shows "X is on bills" with Archive as the primary action. | `api/bills.py`, `services/bills.py`, `services/people.py` |
| Home: banner above In progress with what I owe/am owed, one line per currency | Soft yellow "Your balance" band from `/me/summary` currencies (net per currency, never converted), "Settle up ›" to People. | `features/settle/YourBalance.tsx` |
| Bill page: title and total too big; add one line about me | `PageTitle compact` (28/32 px), meta line (date · people · who paid), compact total, and one line: "You're owed · 2 of 3 still owe SGD 32.00" / "You owe Ben SGD 30.00" / even states. | `routes/bill/Summary.tsx`, `billPosition()` |

Superseded statements: `DESIGN_SHARING.md` still describes "Mark paid" / "Undo" on person rows; the toggle replaces both. `FRONTEND_GUIDE.md` is updated (Home balance band, toggle, Received, ledger, no Edit, never delete people on bills).

## Verification

- Backend: full pytest on Postgres 16 is green, including `test_core_settle.py` (12, with a 400-ledger property check: every debt cleared exactly once, nets preserved, recording any one payment moves nets by exactly that payment) and `test_settle_up.py` (6: chain, stale 409, original pair, loops, merged currencies, toggle-back).
- Web: typecheck, lint, 201 unit tests, build.
- E2E (local, desktop + Pixel 5): app-pages, summary, sharing, bill-flow paid/received flow pass. Two "Save & exit" mobile specs hit **429** locally because the local `.env` uses the production rate limit; CI sets `RATE_LIMIT_DEFAULT=6000/minute`. They don't touch this change.

## Notes for the next pass

- The local dev DB gets mutated by E2E runs; `docker compose exec -T api python -m app.cli dev-seed` restores the seed (app-pages assumes the fresh seed, as in CI).
- Simplified balances depend on every bill in the account, so a person's simplified line can surprise (e.g. a few cents routed through a chain). The Original view is the stable reference; E2E asserts on it.
- Paid toggles in the breakdown stay "on" only for the current visit (closing the sheet forgets them). After that, reverting goes through the bill page toggle or person sheet.
