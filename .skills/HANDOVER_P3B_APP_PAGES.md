# Handover: P3-B app pages around the bill flow (2026-10-07)

Covers Home, the bill history, People, Account, Admin and the public share page. The bill flow itself (`routes/bill/**`, `features/bill/**`) belongs to another agent and isn't covered here.

## 1. Screens

| Route | File | What it does |
|---|---|---|
| `/` | `routes/Home.tsx` + `features/home/HomeSections.tsx` | **Owed hero:** `summary.home` in the home currency. Other currencies are listed after it, never summed ("Plus JPY 3,330 without a rate · Add JPY rate" → `/account?rate=JPY`, which opens the add-rate dialog). "You owe …" appears when non-zero, and "= You're all even" when everything is settled. **Debtors:** a ledger from `summary.people`, with avatar colours joined from `usePeople`. **Start a bill:** three links to `/bills/new?mode=scan\|manual\|quick`; when `usage.scans_paused`, Scan becomes a secondary button and Type items becomes primary, with a warn line giving the reason. **In progress:** draft, scanning, review and assigning bills, with a state label and Resume/Open. **Recent:** the last 5 complete bills (a table on desktop, a ruled list on phones). Phones also get a header with the wordmark and an account link. |
| `/bills` | `routes/Bills.tsx` | A filter for All / Open / Even / Drafts: a native select on phones, a segmented control on desktop that never wraps. It's stored in `?show=`. The list is infinite with a **Load more** button, shows empty states, and every row links to `/bills/:id`. |
| `/people` | `routes/People.tsx` | Add a person inline; a new person gets the least-used hue. Edit opens a dialog with the name and 8 hue swatches (rendered with `Avatar`, so there are no colour literals). Archive asks for confirmation ("Old bills keep the name."). "Me" can't be archived. |
| `/account` | `routes/Account.tsx` + `features/account/*` | Shows the scans meter (with the pause reason when paused). Home currency is an inline select that saves on change. **How friends pay you** is `payment_note` and is hidden if the API omits the field. **Saved rates:** each saved rate is editable and is followed by its read-only inverse (computed like `services/fx.py`). The rate dialog has From/To selects (only for new rates) and validates > 0, ≤ 15 significant digits and the 1e-12…1e12 range. Also here: name, change password (`authClient.updatePassword`, at least 8 characters, typed twice), sign out, and on phones an Admin link for admins. |
| `/admin` | `routes/Admin.tsx` + `features/admin/*` | **This month:** Azure pages against `provider.effective_monthly_page_cap`, OpenAI spend against budget (micros → `$`), the models with their fallback share, and a by-model table. A provider pause shows a Notice with **Resume scans**. **Accounts:** a table on desktop and a ruled list on phones, with scan bars that go warn at the limit, tags (Disabled / Admin / Must change password / At limit / Member) and spend joined from `by_user`. **Edit** opens a dialog with name, role, quota and an enabled switch; `cannot_disable_self`/`cannot_demote_self` show inline. Reset password asks first, then shows the temporary password once with Copy. **New account** is a side panel on desktop (≥ 768 px, via `useIsDesktop`) and a Dialog on phones. The username is lower-cased and stripped of spaces as typed; login can be password or Google (with email); `username_taken`/`email_taken` show inline; the temporary password is shown once with Copy and "Share these with them". **Settings:** a scanning switch (saves on tap), plus page cap (shows "Azure limit 500", checked on the client and on a 422 `page_cap_above_provider_limit`), budget in `$` and default quota. |
| `/s/:token` | `routes/Share.tsx` + `features/share/*` | Public, with no shell and no auth. It sets `<meta name="robots" content="noindex, nofollow">` on mount and sets the title. **Person scope:** "<First>, your share of" with the title, date and merchant, a `HeroAmount` in the effective currency, a conversion line ("JPY 2,230 at 1 JPY = 0.0091 SGD"), the item lines, a Tax-and-service line, the Pay block (`payer_payment_note`, with Copy; hidden when null) and the paid state (Even / "SGD 12.97 still to pay" / not marked). **Bill scope:** the total plus a ledger of everyone, where each row expands (`<details>`) to show items with ½ / ⅓ fraction labels derived from equal shares. A 404 shows "This link has expired or was turned off". |

## 2. Components and logic added (all under `web/src/features/`)

- **home**
  - `format.ts`: `shortDate`, `longDate`, `dayOf`, `monthName`, `billName`, `peopleCount`. Calendar dates are parsed as local parts.
  - `billState.ts`: `progressState`, `owingIndex`/`owingCount`, filters (`BILL_FILTERS`, `filterStatuses`, `matchesFilter`, `parseFilter`).
  - `scanPause.ts`: `scanPauseText` (also handles `provider_quota`).
  - `people.ts`: `HUES`, `nearestHue`, `cleanName`, `nameError`.
  - `BillList.tsx`: `BillTable`, `BillRows`, `BillList`, `BillStatusLabel`, `LoadError` (Notice + Retry), `SectionLoader`.
  - `HomeSections.tsx`: `OwedHero`, `Debtors`, `StartBill`, `InProgress`, `RecentBills`.
- **account**
  - `rates.ts`: `rateError`, `normaliseRate`, `invertRate`, `rateRows`.
  - `AccountDialogs.tsx`: `TextDialog`, `RateDialog`, `PasswordDialog`.
- **admin**
  - `logic.ts`: username normalisation and validation, `parseCount`, `formatUsd`, `parseUsdToMicros`, `microsToUsdInput`, `userTags`, `atLimit`.
  - `bits.tsx`: `useMediaQuery`/`useIsDesktop`, `Switch` (role="switch"), `CopyField`.
  - `ThisMonth.tsx`, `Accounts.tsx` (`AccountsList`, `EditUserDialog`), `NewAccount.tsx`, `SettingsForm.tsx`.
- **share**
  - `logic.ts`: `fractionLabel`, `billFractions`, `effectiveTotal`, `isConverted`, `firstName`.
  - `ShareView.tsx`: `PersonShare`, `BillShare`.

`lib/types.ts` (additive):
- optional `MeOut.payment_note`
- `BillSummaryOut.settle_currency`
- optional `PublicShareOut.payer_payment_note`
- optional `AdminSettingsOut.provider`
- nullable `by_user.user_id/username/quota`

`data/queries.ts`: `useUpdateMe` accepts `payment_note`; `useUpdateSettings` accepts `provider_paused`.

## 3. Tests and checks

- **Vitest:** 27 new tests across 4 files (`features/{home,account,admin,share}/*.test.ts`), covering dates, state labels, filters, rate validation and inversion (which matches the API's 12 significant digits), username normalisation, the USD/micros round trip, user tags, fraction labels and conversion totals.
- **Playwright:** `web/e2e/app-pages.spec.ts` has 6 read-only tests (desktop + Pixel 5 = 12 runs, plus the setup), all passing.
- **Gates:**
  - HEAD (`d4ff40c`), checked in a clean worktree: `tsc`, `vite build` (`VITE_AUTH_MODE=dev`), `vitest` (83) and `eslint` are all green.
  - My files pass the colour grep gate. Note that the gate's `slate-` alternative also matches `translate-`, so the bill-flow files trip it on `-translate-y-1/2`.
- **Visual checks:** Playwright MCP at 390×844 and 1440×900 for every screen. That includes the paused-scans Home, the multi-currency hero, the member Home ("You're all even", no Admin, `/admin` → `/`), dialogs, admin create/edit errors, and person, bill and 404 share links. An overflow sweep at 320 / 768 / 900 / 1024 / 2560 px finds none. Shots are in `.playwright-mcp/p3b-*.png`.

## 4. Backend gaps (the contract limits what the UI can say)

1. **`BillSummaryOut` has no progress detail.** "2 prices to check" and "3 items unassigned" need something like `price_issue_count` and `unassigned_item_count` (or `validation_ok`). Today the labels come from status and source only: "Prices to check", "Items to assign", "Reading receipt…", "Add items/a receipt/the total".
2. **`BillSummaryOut.unsettled_count` counts `settled_at IS NULL`**, so a partial payer counts as settled. `/me/summary.bills[].unsettled_people` counts money outstanding. The UI prefers the summary figure when it has the bill (`owingIndex`), and the Open/Even filters use the same figure. Ideally the backend aligns them.
3. **`/bills` can only filter by status.** Open and Even are filtered on the client over `status=complete` pages, so a page can come back with no matches ("None in the latest N bills" + Load more). A `settled=true|false` filter would fix this.
4. **`/me/summary.people` has no bill titles** (only `bill_count`), so debtor rows say "2 bills" instead of the bill names. It also has no `color_seed`, which is joined from `/people` instead.
5. **`BillSummaryOut` has no participant names** (the mockup shows "You, Aina, Wei Jie +2"), so the People column shows "4 people".
6. **The public share has no people count** for person-scoped links (the mockup's "· 5 people"), and **no item totals or split modes**, so person-scoped links can't show "½ of 2". Bill-scoped links derive fractions from equal shares.
7. **There's no "last active" per account** for the admin table, so that column was dropped.

## 5. Open issues and notes

- **`UsageOut.pause_reason` in `lib/types.ts` doesn't include `'provider_quota'` yet.** Widening it breaks `features/bill/ScanStart.tsx`, which defines its own `PauseReason`. `scanPauseText` handles the value through a string cast. Widen the type once the bill flow handles it.
- **"Add JPY rate" on Home saves a rate**, but existing bills keep their per-bill snapshot, so the hero doesn't change until the bill itself is converted (on its summary page). Should the link go to the bill instead when exactly one bill is in that currency? That's for the owner to decide.
- **Dev data:**
  - I created one throwaway account, `p3b.check` (must change password), while testing admin create. The API can't delete it; disable it in `/admin` if it's in the way.
  - Test share links on Saturday hotpot and Kyoto ramen night still exist; revoke them from the bill summary if needed.
  - `george.payment_note` was set and then cleared.
- **The dev DB needed `alembic upgrade head` for `0003_payment_note`** early in this phase (the API container only migrates on start).
- **The main working tree doesn't typecheck right now**, because of the bill agent's uncommitted `routes/bill/Summary.tsx` (an unused `SectionTitle` import). HEAD builds clean.
