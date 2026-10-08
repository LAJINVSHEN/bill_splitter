# Frontend guide — `web/` ("even")

Binding for every agent that builds UI. Read it with `.skills/BRIEF.md`, `.skills/HANDOVER_P1_BACKEND.md` §6 (API contract, including §11 for currency and dev auth), and `user_preference.md` §1 (anti-slop rules).

The old `frontend/` directory is dead code. Never import from it, but read it for **behaviour** (its edge cases were hard-won, e.g. `frontend/src/components/BillSplitter/ReceiptValidationModal.tsx`, `ItemAssignment.tsx`, `SplitChoiceModal.tsx`, `hooks/useItemAssignment.ts`).

## 1. Design source

- Mockups (direction **C · Ledger**, product name **even**): `.skills/design/even/*.dc.html` (static HTML; open them or read their markup). The live canvas is https://claude.ai/artifact/1BTbRh9qHJtaoD9Acrtqkb.
  - Phone: `E-Login`, `E-ScanPeople`, `E-Summary`, `E-Share`, `E-Account`, `C-Home`, `C-Assign`.
  - Desktop: `E-DesktopHome`, `E-DesktopReview`, `E-DesktopAdmin`.
- The look:
  - Pure white, with a heavy 1.5 px ink rule on top of every list and 1 px hairlines between rows. **No cards.**
  - **Archivo**: wide (`display`, `hero-num` utilities) for headings and big numbers; normal width for UI text.
  - **Cobalt** marks only things you can act on, plus the `=` mark. The `=` is the one brand gesture: wordmark, settled state ("Even"), active nav, loaders (`<EqualsMark moving/>`).
  - People are identified by a pastel initial circle (`<Avatar seed={color_seed}/>`), the same colour on every screen.
- Mockups are the intent, not pixel law. When they conflict with usability, AA contrast or real data, real data wins.

## 2. Tokens and utilities (`web/src/styles/index.css`)

- Colours are the only ones that exist, because Tailwind's palette is reset:
  - `paper`, `mist`, `mist-2`, `rule`, `rule-2`, `ink`, `ink-2`
  - `cobalt`, `cobalt-ink`, `cobalt-soft`
  - `warn`, `warn-ink`, `warn-soft`, `danger`, `danger-soft`
- Utilities: `display` (page titles), `display-sm` (section titles), `hero-num` (big amounts), `num` (tabular numbers), `pb-safe`, `animate-even`.
- Radii: `rounded-[var(--radius-control)]` (6 px) for controls, `--radius-panel` (10 px) only for the share stub and the admin side panel.
- Layout vars: `--app-gutter`, `--app-bottom-gap` (clearance for the phone tab bar), `--app-rail-w` (desktop context rail; a `clamp()`, never a `max-width`).
- **Grep gate** (must find nothing in `web/src` outside `styles/index.css`): `grep -rEn "#[0-9a-fA-F]{3,6}\b|\b(gray|slate|blue|green|red)-" web/src --include=*.tsx` (the `\b` keeps `-translate-y` and `shared-` from tripping it). The only colour literals allowed outside are the `hsl(...)` in `Avatar`.

## 3. Components (`web/src/components`). Use them; don't fork them

| Component | Use |
|---|---|
| `Wordmark`, `EqualsMark` (`Brand.tsx`) | brand; loaders |
| `Icon name=…` | our 24 glyphs only (`scan type divide bill home people person sliders back next plus close check more link lock alert photo upload trash retry search share swap`). Add new glyphs in the same style (24 grid, 1.9 round stroke). **No icon libraries.** |
| `Button`, `ButtonLink` | variants `primary` (one per screen), `secondary` (ink outline), `quiet` (inline cobalt text), `danger`; `loading` shows the moving `=` |
| `TextField`, `SelectField`, `controlClass` | labelled controls; **native `<select>` is the only dropdown** |
| `Money`, `HeroAmount` | every amount. **Never format money by hand.** |
| `Avatar`, `Meter`, `Ledger` + `LedgerRow`, `SectionTitle`, `PageTitle`, `EvenBadge`, `Notice`, `EmptyState`, `FullPageLoader` | `Display.tsx` |
| `useToast()`, `Dialog`, `SlowNetworkBar` | `Feedback.tsx`. `Dialog` is a bottom sheet on phones and centred on desktop |

Shells: `AppShell` (sidebar on desktop, bottom tabs on phones) wraps Home, Bills, Summary, People, Account and Admin. Bill-flow screens render their own `<FlowShell billId steps current footer>` (focus mode with "Save & exit" and a Saved/Saving indicator driven by mutations keyed `['bill', id]`).

Desktop layout (owner pass 2026-10-08):
- No left-aligned `max-w-[...]` page columns and no centred `mx-auto` column (playbook §1.6). Fill the width with grid tracks: main `minmax(0,1fr)` + `var(--app-rail-w)` rail with a hairline `border-l` (Assign, Summary, the flow People step). Narrow *forms* may keep a width cap.
- Page-level controls go in `PageTitle actions` (same row as the title on desktop). Bulk destructive actions ("Clear …") sit after the list, never in the toolbar.
- Row actions (Edit/Delete) reveal on row hover/focus in reserved width (`opacity`, nothing shifts) and stay visible on touch (`pointer-coarse:opacity-100`).
- Flow steps: `footer` is a sticky action bar on desktop (summary left, actions right; `FooterBar`). Don't float primary buttons inside the content.
- Home opens with Start a bill (scan/upload is the wide primary tile). Balances live on People (per person, per currency), not on Home.

## 4. Data (`web/src/data/queries.ts`, `web/src/lib/*`)

- Use the hooks in `queries.ts`; add new ones there if needed. Every bill mutation returns `BillOut`, and `applyBill` writes it into the cache. **Render from the server response.** Don't keep a second copy of bill state in React state beyond a form's draft.
- Money is integer **minor units** in the bill's currency. Use `exponentOf`, `formatAmount`, `parseToMinor` and `minorToInput` from `lib/money.ts`. **Never assume 2 decimals** (JPY 0, KWD 3).
- `lib/split.ts` (`computeSplit`, `allocate`, `convertAllocation`) mirrors the backend exactly, as proven by the shared vectors. Use it for **instant previews** while a mutation is in flight (e.g. tapping items on Assign), then let the server response replace the preview.
- Errors: `ApiError` has `.code` and `.message`. Show `message`; branch on `code`. Notable codes:
  - `quota_*` (429): scanning is paused; offer manual entry.
  - `scan_in_progress`, `currency_locked`, `password_change_required`.
- Never `toISOString()` for a calendar date. Build `YYYY-MM-DD` from local parts.
- Autosave: forms save on blur or with a short debounce (~600 ms) through the bill mutations. "Save & exit" is always safe, and `/` lists drafts for resuming.

## 5. UX rules (from the owner's playbook, enforced in review)

1. **No grey micro-text, no instruction paragraphs, no capability boasts.** If a label or chip already says it, don't repeat it in a subtitle.
2. Colour annotates: warn (amber) = needs attention (a mismatch, unassigned items, a quota limit); cobalt = actionable or settled `=`; danger = destructive or failed.
3. One rhythm per page: ruled lists, single-line rows where possible, a second line only when it adds information.
4. Touch targets ≥ 44 px. Real `<button>`/`<a>`/`<input>`+`<label>`; icon-only buttons get `aria-label`. Text contrast ≥ 4.5:1 (the tokens already pass).
5. Hover, tap and keyboard focus drive one state.
6. Mobile first, fluid, with no horizontal page overflow at any width from 320 to 2560 px. Wide tables scroll inside an `overflow-x-auto` box.
7. Every async action gives immediate feedback (a loading state on the button that started it), and every failure leaves the user with a next step (retry, enter manually, go back).
8. Copy is short, plain and friendly. Use "Even" for settled; never "Paid ✓" with emoji.

## 6. Dev loop

```sh
docker compose up -d db api                      # API on :8000 (dev auth routes enabled)
docker compose exec api python -m app.cli dev-seed   # george (admin) + maya, arjun, lena, tomas; 3 bills
cd web && npm run dev                            # http://localhost:5173 (proxies /api)
```

- Log in as any seeded username with `DEV_LOGIN_PASSWORD` from the root `.env` (never print it; read it in scripts).
- In local dev there's no `VITE_SUPABASE_URL`, so `env.authMode` is `dev` automatically.
- Checks before you finish:
  - `cd web && npm run typecheck && npm run lint && npm test && npm run build`. The build needs `VITE_SUPABASE_URL=https://x.supabase.co VITE_SUPABASE_ANON_KEY=x` or `VITE_AUTH_MODE=dev`.
  - The grep gate above.
  - A screenshot pass at 390×844 and 1440×900 with Playwright MCP. Save shots under `.playwright-mcp/` (gitignored).
