# Design: sharing v2 (payment message, mark-paid links, claim-your-items)

> Status: **Phase 1 built (2026-10-11, branch `feat/flow-polish-oct10`); Phase 2 (tick what you had) is next sprint.** Written 2026-10-10 for the owner. Read with `.skills/BRIEF.md`, `.skills/HANDOVER_P1_BACKEND.md` §6.7, `.skills/FRONTEND_GUIDE.md` and `user_preference.md` §1–2.
>
> **Owner answers (2026-10-11):** Q1 (a) anyone on the group link after picking a name · Q2 (a) the owner confirms every claim · Q5 (a) open while anyone owes, read-only for 90 days after everyone's even, then gone · **Q6 (b) full amount only** (no "paid a different amount") · everything else on its default.
>
> **What Phase 1 shipped vs this doc:**
> - Backend: migration `0007` (`share_links.token_kind`, partial unique indexes per person / group, `payment_claims`); `SHARE_TOKEN_SECRET` (falls back to a key derived from `SUPABASE_SERVICE_ROLE_KEY`; provisioned by `scripts/provision/render.py`); `POST …/share-links/ensure`, `…/{link}/reset`, `…/claims/{id}/confirm|reject`, `…/claims/confirm-all`, `GET /me/claims`, `MeOut.open_claims_count`, `BillOut.claims`; public `POST/DELETE /public/share/{token}/claims` (10/min per IP + 20 per link per day). The 90-day rule is computed live from the last settlement, no stored expiry. Tests: `backend/tests/test_sharing_v2.py`.
> - Frontend: `features/share/message.ts` (+ golden tests), `ShareDialog` (rail primary **Share** on the bill page), Confirm / Not yet on people rows + "Confirm all", Home **To confirm** + nav badge, rebuilt `/s/:token` (fragment shell, pick-your-name, queued claim in `localStorage`, Let {host} know, Undo). E2E: `web/e2e/sharing.spec.ts`. The old per-click `useSendLink` was removed.
> - Not built yet (small follow-ups): the `/sent` tracking ("Sent · now changed · Resend"), the confirm dialog for a claim whose amount no longer matches (Confirm records the claimed amount; the row shows "· now X"), the Bills-list "1 to confirm" chip, and the overpaid display.

---

## 0. Recommendation in one screen

1. **Ship one plain-text message plus one link.** The owner taps **Share** and gets a message built from the bill: who pays what, who to pay, the payment note, and a link. There's a group version (everyone's total and one group link) and a DM version (one person's items and their personal link). Use no `*bold*` or other markup, because it shows up as stray asterisks in iMessage, SMS, Line and Telegram.
2. **The link page gets a real job: "I've paid."** The friend taps it, and it shows up in the owner's app as **"Maya says she paid S$42.10 · Confirm / Not yet"**. Only the owner's **Confirm** writes the existing settlement (`bill_participants.settled_*`). A claim never moves money state by itself, so a leaked or misused link can only cause a false claim that the owner rejects. Today's trust model stays intact.
3. **Handle cold starts with a static shell and a queued claim.** The page is already static on Cloudflare. It draws instantly from a tiny non-secret fragment in the URL (`#p.4210.SGD`), wakes the API in the background, and lets the friend tap "I've paid" straight away. The claim is queued in `localStorage` with an idempotency key and retried until the API answers, including the next time the link is opened. The always-on path (Supabase RPC) is kept in reserve (§4.6).
4. **The owner learns about claims in the app, not by email.** A count badge appears on Home and a "To confirm" list sits at the top of Home and Summary, fetched on focus. After claiming, the friend also gets a **"Let George know"** button that opens their share sheet with a one-line note, so the chat itself is the notification channel.
5. **Make claim-your-items (collaboration) Phase 2 with a deliberately small scope.** Use the same group link, pick-your-name, and ticks only (tick = "I had this", split equally among tickers). Update by polling, not realtime. The owner finalises, and then the same link switches to "pay" mode. Sheets-style co-editing of items, prices and split modes is cut.
6. **Make linking a person to a friend's even account Phase 3.** The friend opens their personal link while signed in and taps "This is me", and the owner can unlink. After that the bill also appears in the friend's own app.

Effort: **Phase 1 ≈ 7 dev-days**, **Phase 2 ≈ 6**, **Phase 3 ≈ 5** (plus optional extras). Details are in §8.

---

## 1. Current state (as of `9f91d29`)

| Piece | Where | What it does today |
|---|---|---|
| Link model | `backend/app/models/scan.py` `ShareLink` | `bill_id, owner_id, person_id (NULL = whole bill), token_hash (sha256), expires_at, revoked_at, last_viewed_at, created_at`. No uniqueness per scope. |
| Service | `backend/app/services/share.py` | Random `token_urlsafe(32)` (43 chars), **shown once**, only the hash is stored. 50 non-revoked links per bill. `public_view` returns no ids; it 404s if the link is revoked, expired, deleted or the person was removed. The payment note shows only when the owner's "Me" is the payer. |
| Routes | `backend/app/api/share.py` | `POST/GET/DELETE /bills/{id}/share-links[/{link_id}]`; public `GET /public/share/{token}` (30/min per IP, `no-store`, `no-referrer`). |
| Rate limits | `backend/app/ratelimit.py`, `config.py` | slowapi in-memory: default 300/min per user/IP, public 30/min per IP. The counters reset whenever Render restarts or sleeps. |
| Settle-up | `services/bills.py` `settle/unsettle`, `services/split_view.py` | One `settled_at + settled_amount_cents` per participant (partial allowed). `outstanding = max(total − paid, 0)`, so **overpayment is hidden**. Currency is locked once anyone has settled. |
| People | `models/profile.py` `Person` | Per-owner address book. **No link to a user account** (no `user_id` column). Bill participants are persons, not users. |
| Send link | `web/src/features/bill/useSendLink.ts` | Creates a link per click (cached only while the page is mounted) and sends `navigator.share({title, url, text})`. **"Send all links" puts every person's private link in one message**, so in a group chat anyone can open anyone's link. |
| Public page | `web/src/routes/Share.tsx`, `web/src/features/share/ShareView.tsx`, `logic.ts` | Read-only stub: hero amount, items, a "Pay George" block with Copy, and "Not marked as paid yet" or "Even". Whole-bill view lists everyone. |
| Owner page | `web/src/routes/bill/Summary.tsx` | Per-person row: amount, "Send link", "Mark paid", "Undo". "Send all links" sits in the rail. A "Share links" accordion shows history and revoke, and counts 50 slots. |
| Cold start | `web/src/lib/api.ts`, `DEPLOYMENT.md` §8 | The SPA pings `/api/health` on load, has a 60 s request timeout and a `SlowNetworkBar`. Keep-warm runs only 11:30–14:00 and 18:00–23:00 SGT. |

Problems the new design must fix:
- The link only displays; payment status comes back only when the owner taps "Mark paid".
- "Send all" leaks per-person links to the whole group.
- A token can't be shown again, so every re-send burns a new link slot.
- The message is just `title: what you owe` plus URLs, with no amounts and no payment instructions.

---

## 2. The message

### 2.1 Format rules (why plain text)

| App | `*bold*` | `- ` lines | Long URL | Notes |
|---|---|---|---|---|
| WhatsApp | renders bold | renders as a list | preview from the first URL | `*`, `_`, `~`, ``` ``` are markup ([WhatsApp FAQ](https://faq.whatsapp.com/539178204879377/?cms_platform=web)) |
| Telegram | literal `*` (only `**…**` in some clients) | literal | preview | |
| iMessage / SMS | literal | literal | preview (iMessage) / plain (SMS) | Any non-GSM character (·, ½, emoji, curly quotes) makes SMS use UCS-2, which allows 70 characters per segment. That's acceptable. |
| Line | literal | literal | auto-linked | |

Rules:
- **No markup characters.** `*`, `_` and `~` never wrap words. A dash list is fine because it renders well in WhatsApp and stays readable elsewhere.
- **No column alignment.** Apps use proportional fonts, so padding with spaces looks ragged. Use one `Name  amount` line per person.
- **No emoji.** This keeps SMS cheap and follows the brand rule (*"never 'Paid ✓' with emoji"*). The `=` stays inside the app.
- **Put the URL last, on its own line**, so every app auto-links it and none of them swallows the following text.
- **Format amounts with the same `formatAmount` the app uses** (minor units, currency exponent). Converted bills show the effective currency first and the original in brackets once.
- **Use the people's display names.** The owner appears under their `display_name` and never as "Me". "You" isn't used either, because the message is read by others.
- **Share through `navigator.share({ text })` with the URL inside `text`, not a separate `url`.** iOS and some Android targets drop either `text` or `url` when both are passed. Copy falls back to the clipboard, as it does today.

### 2.2 Template: group chat (whole bill)

```
{title} · {short date}
Total {grand_total}, paid by {payer_name}

{for each non-payer, owed first}
{name}  {effective_total}{status_suffix}
{payer_name}  {payer_share} (paid the bill)

{if converted}  Amounts in {settle}. 1 {cur} = {rate} {settle}.
{if payment_note}  Pay {payer_first}: {payment_note}
Find your name to see your items and tap "I've paid":
{group_url}
```
`status_suffix` is ` (paid)`, ` ({left} left)` for a partial, or ` (says paid)` for an open claim. Nothing is added when the person owes the full amount.

**Rendered: Saturday hotpot, SGD, owner George paid**
```
Saturday hotpot · Sat 4 Oct
Total S$186.40, paid by George

Maya  S$42.10
Lena  S$51.30
Arjun  S$38.60 (S$18.60 left)
Tomas  S$31.00 (paid)
George  S$23.40 (paid the bill)

Pay George: PayNow 9123 4567
Find your name to see your items and tap "I've paid":
https://even-split.pages.dev/s/k3V9xQ2mT7bZr4Ws8YhN1a#g
```

### 2.3 Template: one person's DM

```
Hi {first_name}, your share of {title} ({short date}) is {effective_total}{" (" + original + ")" if converted}

{up to 6 lines: "- {item}{fraction} {share}"}
{"- and N more" if more}
{"- Tax and service {adj}" | "- Discounts {adj}" if adj != 0}

{if payment_note}  Pay {payer_first}: {payment_note}
When you've paid, tap here so {payer_first} knows:
{person_url}
```

**Rendered: Lena, converted bill (JPY receipt settled in SGD)**
```
Hi Lena, your share of Tokyo ramen night (Fri 3 Oct) is S$26.21 (¥2,880)

- Tonkotsu ramen ¥1,450
- Gyoza ½ ¥390
- Highball ×2 ¥780
- Tax and service ¥260

Pay George: PayNow 9123 4567
When you've paid, tap here so George knows:
https://even-split.pages.dev/s/Qm8rT2yLx9VbK1cN0pWe4u#p.2621.SGD
```

Notes:
- Item lines are in the bill currency (`share_cents`, as in `ShareView` today), and the headline is in the effective currency. The "(¥2,880)" bridges the two. The fraction labels reuse `features/share/logic.ts` (`½`, `⅓`; unequal splits get no label).
- When the payer isn't the owner and has no note, the line becomes `Pay Arjun back directly.`
- The text is built by a **pure function** `buildShareMessage(bill, me, links, scope)` in `web/src/features/share/message.ts`, with golden-text unit tests (SGD, JPY 0-dp, KWD 3-dp, converted, partial, payer ≠ owner, 1-person, 15-person, long names). The client already has the split and the formatters. The server only supplies links.

### 2.4 The fragment (instant shell)

`#g` marks a group link. `#p.{effective_total_minor}.{currency}` holds a personal link's amount *as sent*. The fragment is **not secret and not trusted**: browsers never send it to any server, and the page uses it only to draw the first frame before live data arrives, and to detect "changed since sent" (§3.3). Without a fragment (the user edited the link, or an old link), the page shows the waking state instead.

---

## 3. The link page

Route: keep **`/s/:token`** for both scopes, so old links keep working. The page reads the scope from the fragment (or from the server once the data arrives).

### 3.1 Tokens and links

- **One active link per scope per bill:** `(bill_id, person_id)`, where `NULL` is the group. Re-sharing reuses it, which ends slot burning. The 50-link cap stays as a safety limit but is never reached in normal use.
- **Derive the token instead of storing it.** `token = base64url(HMAC-SHA256(SHARE_TOKEN_SECRET, link.id))[:22]`, which is 128 bits. Only `sha256(token)` is stored, as today. The server can recompute the token for "copy message again" without persisting it. If the database leaks, the attacker still needs the Render secret. Rotating `SHARE_TOKEN_SECRET` invalidates every derived link, which works as an emergency kill switch.
- **Keep legacy 43-char random tokens working (read-only plus claims).** They just can't be shown again, so the next "Share" creates a derived link for that scope.
- **"Reset link"** revokes the current link and creates a new id, so the old URL dies and the new one is derivable.

### 3.2 Page states

| # | State | When | What the friend sees | Actions |
|---|---|---|---|---|
| 1 | **Shell** | first paint, before the API answers | From the fragment: "Your share: S$42.10" with a moving `=` and "Getting the latest from George…". After 8 s: "Waking the server, this can take up to a minute." | **I've paid** (queued, see §4.3), Copy payment note (the note isn't in the fragment, so this button appears only once live data or the message is available) |
| 2 | **Owes** | live, outstanding = total | Hero amount, item lines, "Pay George · PayNow 9123 4567 · Copy" | **I've paid S$42.10** (primary) · "Paid a different amount" (quiet) |
| 3 | **Part paid** | settled partially | "S$18.60 left of S$38.60" | **I've paid S$18.60** · different amount |
| 4 | **Sending** | claim queued, not yet acknowledged | "Telling George… (saved on this phone, safe to close)" | — |
| 5 | **Claimed** | open claim | "You told George you paid S$42.10 · today 21:14. Waiting for George to confirm." | **Let George know** (share sheet: "Paid S$42.10 for Saturday hotpot"), Undo |
| 6 | **Not yet** | owner rejected | warn: "George hasn't seen your payment yet." | **I've paid** again |
| 7 | **Even** | outstanding 0 | `=` "You're even with George" | — (read-only) |
| 8 | **Changed** | live total ≠ fragment amount, or ≠ claimed amount | Notice: "George updated the bill: now S$44.20 (was S$42.10)". If a claim was confirmed for the old amount: "S$2.10 left". | as 2/3 |
| 9 | **Payer** | the link's person is the payer | "You paid this bill." | — |
| 10 | **Pick your name** | group link, no remembered name | Ruled list of people with status chips (Owes / Says paid / Even / Paid the bill) | Tap a name → that person's states 2–9 plus "Not Maya? Switch". The choice is remembered in `localStorage` for this link (try/catch, optional). |
| 11 | **Closed** | revoked, expired, bill deleted or person removed | "This link has expired or was turned off. Ask George for a new one." | — |
| 12 | **Error** | network or 5xx after retries | "Couldn't reach even." | Try again |

There's no login and no PII beyond names, items and amounts. `noindex` and `no-referrer` stay as today. Lazy-load the `/s` route as its own chunk and keep supabase-js out of it, so the shell paints quickly on 4G.

### 3.3 Mark-paid state machine

```
                 friend: I've paid (amount A, client_key K)
   (no claim) ───────────────────────────────▶ CLAIMED ──friend: Undo──▶ WITHDRAWN
       ▲                                         │  │
       │              owner: Not yet             │  │ owner: Confirm (amount A' default A)
       └────────────── REJECTED ◀────────────────┘  ▼
                                                CONFIRMED ──owner: Undo settlement──▶ REVERTED
   any open claim ──person removed / bill deleted / owner "Mark paid" directly──▶ SUPERSEDED
```

Rules:
- **At most one open (`claimed`) claim per (bill, person).** A second "I've paid" with the same `client_key` is a no-op. A different key while one is open returns the open claim (idempotent from the user's side).
- **The claim is a request; the settlement is the ledger.** **Confirm** calls the existing settle logic with `settled_amount = previous_paid + A'`, so one source of truth stays. Balances, `/me/summary` and "Everyone's even" don't change until Confirm.
- **The amount is frozen at claim time** (`amount_cents` in the effective currency plus `expected_total_cents`, the total the friend saw). If the bill changes before Confirm, the owner sees "Says paid S$42.10 · bill now S$44.20" and the confirm dialog offers "Record S$42.10" (default) or "Record the full S$44.20".
- **Undo by the friend** is allowed only while the claim is `claimed`. After Confirm, only the owner can undo (the existing **Undo**, which also marks that claim `reverted`).
- **The owner's direct "Mark paid"** still works without a claim and supersedes any open claim.
- **Currency lock extends to open claims:** `currency_locked = any settled OR any open claim`. Changing the conversion would make the claimed amount meaningless.
- **Overpayment:** `outstanding` is still clamped to 0, but when `paid > total` the Summary row shows "Overpaid S$2.10" (warn). That's a display-only change.

### 3.4 Who may claim

| Link | Can claim for | Shown to owner as |
|---|---|---|
| Personal link (`person_id` set) | only that person | "Maya says she paid" |
| Group link | **anyone picked from the list** (default, see Q1) | "Maya says she paid · via group link" |
| Legacy link | same as its scope | same |

Why this is safe enough: a link holder can only create claims, never settlements. The worst abuse is a false "says paid" that the owner rejects, plus seeing names, items and amounts, which is already true today. The payment note (a PayNow number) is something people post in group chats anyway.

### 3.5 Bill edits, deletions and other edge cases

| Situation | Behaviour |
|---|---|
| Bill edited after sending | The page always shows live amounts. State 8 explains the change against the fragment or claim amount. Summary shows "Sent S$42.10 · now S$44.20 · **Resend**" for personal links (`last_sent_total_cents`). |
| Item reassigned so the person owes 0 | They show as Even (nothing owed). Any open claim is still shown to the owner to resolve. |
| Person removed from bill | Their personal link 404s (as today). Open claims → `superseded`. The group list drops them. |
| Bill deleted (permanent) | FK cascade deletes links and claims. The page shows state 11. |
| Bill reopened / status ≠ complete | Links stay viewable. Claims are disabled with "George is still editing this bill" (`claims_open = status == 'complete'`). |
| Payer isn't the owner | Claims still go to the **owner's** app, labelled "says they paid Arjun". The owner confirms on Arjun's behalf (Q8). No payment note is shown, as today. |
| Payer changed after a claim | Open claims are kept; the confirm dialog names the current payer. |
| Converted bill | Claim and settlement are in the effective currency; the message and page show both. Locked as in §3.3. |
| Friend is an even user | Phase 1: no difference. Phase 3: "This is me" links the person (§6). |
| Two people named "Alex" on a group link | The picker shows the avatar colour and the first item to tell them apart. Owners can rename. |

---

## 4. Backend

### 4.1 Data model (migration `0007_sharing_v2`, additive and backward-compatible)

```sql
-- share_links: one active link per scope, derivable tokens, send tracking
ALTER TABLE share_links
  ADD COLUMN token_kind text NOT NULL DEFAULT 'random'      -- 'random' (legacy) | 'derived'
      CHECK (token_kind IN ('random','derived')),
  ADD COLUMN last_sent_at timestamptz,
  ADD COLUMN last_sent_total_cents bigint,                     -- personal links: amount in the message
  ADD COLUMN claims_enabled boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX uq_share_links_active_scope
  ON share_links (bill_id, coalesce(person_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
-- (backfill: revoke all but the newest active link per scope before creating the index)

CREATE TABLE payment_claims (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id               uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  owner_id              uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  person_id             uuid NOT NULL,                         -- FK (bill_id, person_id) → bill_participants ON DELETE CASCADE
  share_link_id         uuid REFERENCES share_links(id) ON DELETE SET NULL,
  via                   text NOT NULL CHECK (via IN ('person_link','group_link','app')),  -- 'app' = Phase 3
  claimant_user_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,                  -- Phase 3
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  currency              char(3) NOT NULL,                      -- effective currency at claim time
  expected_total_cents  bigint NOT NULL,                       -- what the page showed
  status                text NOT NULL DEFAULT 'claimed'
      CHECK (status IN ('claimed','confirmed','rejected','withdrawn','superseded','reverted')),
  client_key            uuid NOT NULL,                         -- idempotency from the browser
  created_at            timestamptz NOT NULL DEFAULT now(),
  decided_at            timestamptz,
  UNIQUE (share_link_id, client_key)
);
CREATE UNIQUE INDEX uq_claims_open ON payment_claims (bill_id, person_id) WHERE status = 'claimed';
CREATE INDEX ix_claims_owner_open ON payment_claims (owner_id) WHERE status = 'claimed';
-- RLS enabled, no policies, grants revoked (same pattern as every table)
```

Phase 2 adds `bills.version int NOT NULL DEFAULT 0` and `bills.guest_items_open_at timestamptz` (§7). Phase 3 adds `people.linked_user_id uuid NULL REFERENCES profiles(id) ON DELETE SET NULL` with `UNIQUE (owner_id, linked_user_id)`.

No split results are stored. The only snapshots are the claim's own amounts, which record a fact ("Maya said she paid S$42.10"), not derived state.

### 4.2 Endpoints

Owner (Bearer JWT):

| Method & path | Body → response | Notes |
|---|---|---|
| `POST /bills/{id}/share-links/ensure` | `{scopes: [{person_id: UUID\|null}]}` → `{items: [{link_id, person_id, token, path, url}]}` | Reuses the active derived link or creates one. Replaces "create per click". |
| `POST /bills/{id}/share-links/{link_id}/sent` | `{total_cents?}` → 204 | Called after Share/Copy succeeds. Feeds "Sent · now changed". |
| `POST /bills/{id}/share-links/{link_id}/reset` | → new link `{…token}` | Revoke and recreate. |
| `GET /bills/{id}/claims?status=claimed` | → `{items: ClaimOut[]}` | Also embedded in `BillOut.claims` (open only) so Summary needs no extra request. |
| `POST /bills/{id}/claims/{claim_id}/confirm` | `{amount_cents?}` → `BillOut` | Defaults to the claim amount. Idempotent. Writes the settlement. |
| `POST /bills/{id}/claims/{claim_id}/reject` | → `BillOut` | Status `rejected`. |
| `POST /bills/{id}/claims/confirm-all` | → `BillOut` | Every open claim on the bill, each at its claimed amount. |
| `GET /me/inbox` | → `{claims: [ClaimOut & {bill_title, bill_date}]}` | Home's "To confirm". |
| `GET /me` | adds `open_claims_count` | Nav badge. |

Public (no auth):

| Method & path | Limit | Notes |
|---|---|---|
| `GET /public/share/{token}` | 30/min per IP (existing) | Adds `claims_open: bool`, `people[].key` (opaque, see below), `people[].claim: {status, amount_cents, created_at} \| null`, `payer_is_owner`. Still no UUIDs. |
| `POST /public/share/{token}/claims` | **10/min per IP**, plus a **DB cap of 20 claim events per link per day** | `{person_key, amount_cents?, client_key}` → the person's public state. `person_key` is ignored on personal links. Returns 409 `claims_closed` when the bill isn't complete or the link has claims off. |
| `DELETE /public/share/{token}/claims/{client_key}` | same | Withdraw, only while `claimed`. |

`person_key = base64url(HMAC(SHARE_TOKEN_SECRET, link_id ‖ person_id))[:10]`. It's stable for that link, means nothing outside it, and doesn't expose person ids.

### 4.3 Cold-start behaviour (Phase 1 default)

1. Cloudflare serves the static page in about 100 ms. The shell renders from the fragment, and the app's existing `GET /api/health` wake ping fires immediately.
2. `GET /public/share/{token}` uses the existing 60 s timeout. While it's pending, state 1 shows; at 8 s the "Waking the server" line appears.
3. **Tapping "I've paid" never waits on the server.** The page writes `{token, person_key, amount, client_key, at}` to `localStorage['even.pendingClaims']` and shows state 4. It then POSTs with a 75 s timeout and retries with backoff (5 s → 15 s → 30 s, up to about 5 minutes while the page is open). Once the server acknowledges, the entry is removed and state 5 shows.
4. **If the tab is closed first,** the next open of the link resends the queued claim before anything else. The server dedupes on `(share_link_id, client_key)`. If storage is unavailable (private mode), the page says "Keep this page open for a moment."
5. Most opens happen minutes after the owner hits Share, when the API is still warm from that session, or during the keep-warm windows. The 3 am case gets a fast first paint and a queued claim, which is acceptable.

### 4.4 Security model

| Concern | Decision |
|---|---|
| Token | 128-bit HMAC-derived from the link id. Only its SHA-256 is stored. Unknown, revoked or expired tokens return 404 (no oracle). Tokens over 100 chars are rejected before hashing (existing). |
| Scope | A personal link reads and claims for one person. A group link reads everyone and claims for any picked person. Neither can settle, edit or see ids. |
| Expiry | Q5 default: the link is open while anyone owes. Once **everyone is even**, claims close and the link stays read-only for 90 days, then expires (`expires_at` set by the settle service). The owner can still reset or revoke at any time. |
| Revocation | Existing "Revoke" and "Revoke all" stay. "Reset link" is new. Rotating `SHARE_TOKEN_SECRET` kills every derived link. |
| Rate limits | IP limits are in-memory (they reset on restart, which is acceptable for about 15 users). The **persistent** per-link daily claim cap keeps a leaked link from flooding the owner's inbox. One open claim per person makes repeats idempotent. |
| Shared IP | Friends at the same restaurant share a NAT IP. Viewing stays well under 30/min. The Phase 2 polling endpoint gets its own budget (§7.3). |
| Privacy | `noindex`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. The fragment carries only an amount and a currency. WhatsApp and iMessage preview crawlers fetch only the static HTML (no JS), so previews don't wake the API or count as views. |
| RLS | `payment_claims` follows the existing deny-all and revoked-grants pattern. The owner endpoints filter by `owner_id` (404 for others, never 403). Add the new routes to the 16-route owner-isolation test. |
| Input | `amount_cents` must be > 0 and ≤ 10× the person's total (rejects typos and garbage). There's no free-text note in v1, so there's nothing to spam into the owner's UI. |

### 4.5 Notifications without email

- **Badge:** `/me.open_claims_count` drives a cobalt count on the Home tab and sidebar item. TanStack refetches on focus, plus every 60 s while the app is visible.
- **Home:** when there are open claims, Home starts with a "To confirm" ledger list (row: avatar, "Maya · Saturday hotpot", amount, **Confirm**, **Not yet**). There's no separate inbox page.
- **The chat is the push channel:** after claiming, the friend's **Let George know** button shares `Paid S$42.10 for Saturday hotpot (marked in even)`, which is free and works in every app.
- **Optional Phase 3: Web Push.** VAPID keys and `pywebpush` on Render cost $0 and need no email. iOS supports it only when the PWA is installed on the home screen (iOS 16.4+). Budget about 2 days.

### 4.6 Reserve option: always-on public path (not in Phase 1)

If cold starts still annoy people, move the two public calls off Render. The approach is two `SECURITY DEFINER` Postgres functions (`public_share_view(token)`, `public_share_claim(token, person_key, amount, client_key)`) that the page calls through Supabase's Data API with the anon key. Supabase Free doesn't sleep. Costs and caveats:
- **It breaks the playbook rule** "frontend never queries Supabase directly", only for these two functions.
- **Split maths would have to live in SQL,** or a stored per-link snapshot would need refreshing on every bill mutation. That duplicates `core/split.py`, which conflicts with "one source of truth".
- **Postgres grants `EXECUTE` to `PUBLIC` by default,** so every other function needs it revoked.
- **There's no per-IP rate limit** at PostgREST, so you rely on the per-link DB cap.

It takes about 2–3 days. Don't build it unless real usage shows people giving up on the shell. A Cloudflare Pages Function proxy doesn't help, because the API still sleeps behind it. (Pages Functions share the Workers Free 100k requests/day budget; [Cloudflare docs](https://developers.cloudflare.com/pages/functions/pricing/).)

---

## 5. Owner UI touch points (`web/src/routes/bill/Summary.tsx`, Home)

| Where | Change |
|---|---|
| Rail primary | **Share** replaces "Send all links". It opens a `Dialog` with a native `<select>` (**Group chat** default, or one person) and a read-only message preview (the exact text). Buttons: **Share…** (`navigator.share({text})`) and **Copy**. On success it calls `/sent`. |
| Person row | Statuses on the second line: `Says paid S$42.10 · 21:14` (warn, with **Confirm** / **Not yet** replacing "Mark paid") · `Sent · opened 20:58` · `Sent S$42.10 · now S$44.20 · Resend`. **Send link** becomes **Message**, which opens the same dialog pre-set to that person. "Mark paid" and "Undo" stay. |
| Top of page | When ≥2 open claims: a `Notice` saying "3 people say they've paid · **Confirm all**". |
| Confirm dialog | Only when the amounts differ: "Maya says S$42.10 · bill is now S$44.20" with two radio buttons (default the claimed amount). Otherwise Confirm is one tap, with an undo toast. |
| Share links accordion | One row per scope (Group, each person) with **Opened** / **Not opened**, **Reset link** and **Revoke**. The "N of 50 slots" counter goes away. |
| Home | "To confirm" list (§4.5) and the tab badge. |
| Bills list | A row chip, "1 to confirm" (warn). |
| Account | Payment note field (exists). The Share dialog warns "Add how people pay you" when the owner is the payer and has no note. |

This follows the anti-slop rules: no new cards, ruled lists, one primary per screen, warn colour for things to act on, and no instruction paragraphs. The Share dialog shows the message itself instead of explaining it.

---

## 6. Phase 3: person ↔ even account linking

- **How a link is made (Q7 default).** A signed-in even user opens a **personal** link and sees "This is me: add to my even". The server sets `people.linked_user_id = current_user` for that person in the owner's list. It's allowed because holding Maya's personal link while signed in is good evidence. The owner sees "Maya · @maya" on People and can **Unlink**. The group link can't create links.
- **What it unlocks:**
  - `GET /me/shared-bills` lists bills where *my* linked person owes or is owed.
  - Home shows "From others' bills": "You owe George S$42.10 · Saturday hotpot · **I've paid**". Claims made here use `via='app'` with `claimant_user_id` set, through the same claim table and the same owner confirmation.
  - `/me/summary` gains a separate `shared` block. It's **not** merged into the user's own balances, which avoids double counting when Maya also logged the bill herself.
- **Authorisation:** reading another owner's bill requires an active (non-archived) person on that bill with `linked_user_id = me`. The response is the public-shape DTO (no ids), never `BillOut`.
- **Effort:** about 5 days (endpoint, 2 Home sections, People badge, unlink, tests). Not needed for the core ask.

---

## 7. Collaboration: "tick what you had"

### 7.1 What the owner wants versus what's worth building

Today the owner taps items for everyone on Assign. The ask is for everyone to get one link, tick their own items, and then get their text and link. In practice the bill is scanned at the table, the group chat already exists, and people tick within minutes or an hour. You don't need Sheets-grade simultaneous editing for that. You need **commutative ticks plus an owner who finalises**.

### 7.2 Options

| Option | Scope | Difficulty | Free-tier fit | Risks |
|---|---|---|---|---|
| **A. Status quo** (owner assigns) | none | 0 d | — | The owner does all the work. |
| **B. Claim-your-items, group link, pick-your-name, ticks only, polling, owner finalises** ★ | Guests tick "I had this" (equal split among tickers); the owner sees progress live and finalises | ~6 d | Polling every 4 s only while the page is visible and the bill is open. It keeps Render awake for that session only (minutes of a 750 h budget). | Someone ticks for someone else (the owner reviews before finalising). Quantity items are wrong under equal split (B+ fixes this). |
| **B+. B plus "how many?" for qty > 1** | Stepper on quantity items, stored as `weighted` shares by count | +1.5 d | same | Slightly more UI on the guest page |
| **C. B with Supabase Realtime instead of polling** | Server broadcasts "bill changed" through the Realtime REST broadcast; pages subscribe to a public channel named by the hashed token | +1.5 d on B | Free: 200 concurrent connections, 100 msgs/s, 2M msgs/month ([limits](https://supabase.com/docs/guides/realtime/limits), [pricing summary](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/)). That's ample. | A new moving part. Guests have no Supabase JWT, so private channels don't work and the channel name becomes the secret. Writes still go through sleeping Render, so the first tick still waits about 60 s. **Little gain over 4 s polling.** |
| **D. Personal links for ticking** (no pick-your-name) | The owner DMs each person a link | ~B −0.5 d | same | The owner sends N messages instead of one. That's friction at the table. |
| **E. Full co-editing** (guests edit items, prices, split modes; presence; conflict resolution) | Sheets-like | 15–20 d | Realtime needed | Conflicts with the validation flow (`PUT /receipt` reconciliation), split-mode rules and currency lock. It also hands money edits to unauthenticated link holders. **Cut.** |

How others do it:
- **Splitwise** runs groups as a wiki: any member can edit or delete anything, and there are no admins ([Splitwise KB](https://feedback.splitwise.com/knowledgebase/articles/89944-why-can-other-people-edit-or-delete-expenses-that), [no admin roles](https://feedback.splitwise.com/knowledgebase/articles/264547-can-i-set-a-group-admin-or-set-different-permis)).
- **Tricount** gives anyone with the link full rights, with no account needed ([Tricount blog](https://blog.tricount.com/en/share-your-tricount)).
- **Spliit** has no accounts, a group link, "tell the application who you are" when opening the group, and an activity log ([GitHub](https://github.com/spliit-app/spliit)).
- **Settle Up** adds owner / read-write / read-only permissions and an invite link that can be switched off ([API entities](https://api.settleup.io/entities), [tips](https://settleup.io/tips.html)).
- **None of them asks the payee to confirm a payment.** They rely on trust plus a history.

even's links travel in group chats with no accounts behind them, so the one-tap Confirm (Phase 1) is cheap insurance. Q2 lets the owner switch to trust mode.

**Recommendation: B now, B+ if quantity items keep biting, never E. C only if 4 s polling ever feels slow, which is unlikely.**

### 7.3 Design of B

- **Opening:** on Assign (or the People step) the owner taps **Let everyone tick their items**. This sets `bills.guest_items_open_at` and shares the **group** link with a short message: `Saturday hotpot: tick what you had\n{group_url}`. The same link later carries the payment message, so there's one link per bill lifecycle.
- **Guest page (mode "items"):** pick your name (state 10), then a ruled list of items. Each row shows the name, price and the avatars of tickers, with a checkbox for *me*. A sticky footer reads "Your share so far: S$38.20 (before tax and service)", computed by the TS split mirror.
- **Write semantics:** `PUT /public/share/{token}/items/{item_key}` with `{person_key, on}`. The server adds or removes *only that person's* share row, then normalises: 1 ticker → `single`, ≥2 → `equal`, 0 → unassigned. Toggles are commutative, so two guests on the same item can't conflict. The server holds the bill row lock (`load_bill(for_update=True)` already exists).
- **Locked items:** items the owner put in `weighted`/`custom` mode (Shares / Percent / Exact), or that the owner touched after opening, show "George set this" and are read-only for guests. Guests never set modes.
- **Owner concurrency:** the owner's Assign `PUT /assignments` replaces whole items and could wipe a guest tick that landed a second earlier. Add `bills.version`, bumped on every split-affecting write and sent as `If-Match` by Assign. A mismatch returns 409 `bill_changed`, and the page refetches and reapplies. While guest ticking is open, Assign polls every 4 s, so the owner sees ticks appear.
- **Polling:** `GET /public/share/{token}/items?since_version=N` returns `304`/`{unchanged:true}` cheaply. It runs every 4 s only while `document.visibilityState === 'visible'` and stops when the owner finalises. It has its own limit of **120/min per IP** (a table of 6 phones on one Wi-Fi uses about 90/min).
- **What the owner sees:** above the Assign list, a progress line reads "9 of 12 items ticked · Lena hasn't opened yet". Rows ticked by guests show a small "ticked by Maya" (in the item's annotation colour, not grey micro-text). Unticked items stay warn, as today.
- **Partial completion:** nothing waits forever. The owner taps **Finalise** whenever they like. Unticked items follow today's rule ("spread over everyone"), or the owner assigns them. Finalise sets status `complete`, closes ticking, and opens the Share dialog with the payment message.
- **Trust:** pick-your-name means anyone can tick as anyone. Mitigations:
  - Every guest write is recorded in a small `bill_events` log (`who=person_key, item, on/off, at`), shown on the owner's Assign as "ticked by".
  - The owner always reviews before Finalise.
  - Per-link write cap of 300 per day.
  - Ticks only add or remove the picked person's own share.
- **Split modes:** guests produce only `single`/`equal` (B) or count-`weighted` (B+). The owner can still open the existing SplitDialog on any item to switch to Shares, Percent or Exact, which then locks it for guests. Nothing about the core split maths or golden vectors changes.

### 7.4 What to cut (and keep cut)

- Guest editing of names, prices, charges or totals.
- Guest-chosen split modes.
- Presence avatars and typing indicators.
- Comments and chat.
- Realtime.
- Undo history beyond the event log.
- Guests adding new people ("I'm not on the list"); the owner adds them.
- Per-person tick links.
- Ticking before the scan finishes. Guests see "Items are still being read…" and the page polls the job state through the same endpoint.

---

## 8. Phased plan and effort (developer-days, including tests and handover)

| Phase | Contents | Backend | Frontend | Tests / E2E / docs | Total |
|---|---|---|---|---|---|
| **1. Message + mark-paid** | migration 0007, derived tokens, ensure/sent/reset, claims (public + owner), confirm/reject/confirm-all, inbox and badge count, currency lock on open claims, overpaid display; `buildShareMessage` + golden texts; Share dialog; person-row states; Home "To confirm"; public page states 1–12 with queued claim and fragment shell | 2.5 | 3 | 1.5 | **≈ 7** |
| **2. Tick what you had (B)** | `bills.version` + If-Match on Assign, `guest_items_open_at`, public items GET/PUT with `since_version`, `bill_events`, polling limits; guest items page, owner progress line, Finalise | 2 | 3 | 1 | **≈ 6** |
| 2b. Quantity stepper (B+) | weighted-by-count from guests | 0.5 | 0.75 | 0.25 | ≈ 1.5 |
| **3. Account linking** | `people.linked_user_id`, "This is me", shared-bills endpoint, Home "From others' bills", app claims, unlink | 2 | 2 | 1 | **≈ 5** |
| 3b. Web Push | VAPID, subscription table, send on claim, settings toggle | 1 | 0.75 | 0.25 | ≈ 2 |
| 3c. Always-on public path (§4.6) | SQL functions, grants, snapshot refresh | 2 | 0.5 | 0.5 | ≈ 3 (only if needed) |

Order: 1 → (use it for 2 weeks) → 2 → 3. Phase 1 alone delivers both of the owner's asks 1 and 2.

Checks per phase stay as in `FRONTEND_GUIDE.md` §6 and the CI gates:
- Playwright gains a public-page flow: open link → I've paid → owner confirms → Even.
- One more flow simulates an API timeout to prove the queued claim survives a reload.

---

## 9. Open questions for the owner

Each question lists options; **(default)** marks the recommendation.

1. **Who can mark paid from the group-chat link?**
   (a) Anyone, after picking a name; the owner confirms anyway **(default)**
   (b) Nobody; the group link is read-only and only personal DMs can claim
   (c) The group message has no link, only totals
2. **Does a claim need the owner's confirmation?**
   (a) Yes, one tap each or "Confirm all" **(default)**
   (b) No, claims settle immediately and the owner can Undo (Splitwise/Tricount-style trust)
   (c) Auto-confirm after 3 days unless rejected
3. **Message styling.**
   (a) Plain text everywhere **(default)**
   (b) A "WhatsApp style" toggle that bolds the amounts with `*…*`
   (c) Separate presets per app
4. **Item lines in the DM.**
   (a) Up to 6 items, then "and N more" **(default)**
   (b) Total only
   (c) Every item
5. **Link lifetime.**
   (a) Open while anyone owes; read-only for 90 days after everyone's even; then expires **(default)**
   (b) Never expire (today's default)
   (c) Fixed 30 days from sending
6. **Partial payments from friends.**
   (a) Allow "Paid a different amount" **(default)**
   (b) Full amount only; partials are recorded by the owner in-app
7. **Linking a person to a friend's account (Phase 3).**
   (a) The friend taps "This is me" on their personal link while signed in; the owner can unlink **(default)**
   (b) The owner picks from a directory of all users (exposes every username to every user)
   (c) Don't link accounts at all
8. **When someone other than the owner paid the bill.**
   (a) Claims still come to the owner, who confirms for the payer **(default)**
   (b) Turn claims off for those bills
   (c) Let the payer confirm, once linked (Phase 3)
9. **Collaboration scope.**
   (a) Phase 2 "tick what you had" (option B) **(default)**
   (b) Skip it; the owner keeps assigning
   (c) Go further, with realtime and guests editing items (not recommended)
10. **Cold starts.**
    (a) Static shell, fragment and queued retry, no new infrastructure **(default)**
    (b) Also build the always-on Supabase RPC path now (about 3 days, bends the "frontend never talks to Supabase" rule)
11. **Telling the owner a claim arrived.**
    (a) In-app badge, "To confirm" list and the friend's "Let George know" share button **(default)**
    (b) Same plus Web Push (Phase 3b; iOS needs the app installed to the home screen)
12. **Existing "Send all links" (several personal links in one message).**
    (a) Remove it; the group message carries one group link **(default)**
    (b) Keep it as a secondary option

---

## 10. Sources (checked 2026-10-10)

- Supabase Realtime limits (Free: 200 concurrent connections, 100 msgs/s, 100 channel joins/s, 256 KB broadcast payload): https://supabase.com/docs/guides/realtime/limits
- Supabase Free includes 2M Realtime messages/month (third-party summary of the pricing page): https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/
- Render Free (spins down after 15 min idle, about 1 min to wake, 750 h per workspace): https://render.com/docs/free
- Cloudflare Pages Functions share the Workers Free 100k requests/day: https://developers.cloudflare.com/pages/functions/pricing/
- WhatsApp formatting (`*bold*`, `_italic_`, `~strike~`, ``` ```mono``` ```, `- ` lists): https://faq.whatsapp.com/539178204879377/?cms_platform=web
- Splitwise, anyone in a group can edit or delete; no admin roles: https://feedback.splitwise.com/knowledgebase/articles/89944-why-can-other-people-edit-or-delete-expenses-that, https://feedback.splitwise.com/knowledgebase/articles/264547-can-i-set-a-group-admin-or-set-different-permis
- Tricount, link holders get full access without an account: https://blog.tricount.com/en/share-your-tricount
- Settle Up, owner / read-write / read-only permissions; invite link can be deactivated: https://api.settleup.io/entities, https://settleup.io/tips.html
- Spliit, group link, "tell the application who you are", activity log: https://github.com/spliit-app/spliit
