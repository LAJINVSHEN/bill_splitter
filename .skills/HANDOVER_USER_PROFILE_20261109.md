# Handover: user profiles, friends, Mailbox, shared co-editing, groups (2026-11-09)

Implements `PRD/user_profile.md`, all seven phases. Branch `feat/user-profile` (local, not committed or deployed; built for the owner's review). Owner's answers: memory `user-profile-decisions-20261109`.

## 1. Model in one paragraph

A **Person** stays a per-owner address-book entry. `people.linked_profile_id` makes an entry *be* an account (a friend, or a placeholder whose owner accepted the link). The owner's own "Me" stays unlinked and counts as the owner (`Person.account_id`). A bill is **shared with every account on it**: access is derived (owner, or one of its participants is linked to you) and never stored, so linking a placeholder shares its past bills at once and nothing can drift. Friendship only gates *adding* someone to your own bills and tagging placeholders. People on the same bill don't need to be friends; anyone you share a bill with is a one-tap "Ask" in Add friend.

## 2. Schema (migration `0008`)

| Table / column | Purpose |
|---|---|
| `profiles.discoverable`, unique `lower(email)` | search by exact email / user id; opt-out |
| `people.linked_profile_id` (+ unique active per owner/account) | entry = account |
| `bills.version`, `bills.updated_by` | optimistic concurrency, "who saved last" |
| `bill_edits` | every write: actor, version, kind, item ids (the conflict check reads it) |
| `friendships` | one row per request. `addressee_id` NULL = matched nothing (same "sent" answer, never delivered) |
| `person_links` | "my placeholder is you" invites |
| `mailbox_items` | updates (accepted / declined / edited / added / confirmed / plan sent); coalesced per bill |
| `access_requests` | Google sign-ins without an account |
| `groups`, `group_members` | personal saved sets |
| `payment_claims.claimed_by`, `via='app'` | in-app "I've paid" |

**Before deploying**, check that prod has no two profiles with the same email ignoring case, or the unique index fails: `SELECT lower(email), count(*) FROM profiles GROUP BY 1 HAVING count(*) > 1`.

## 3. Rules worth knowing

- **Co-editing** (`services/collab.py`): members edit the receipt and who had what, and may scan (charged to the scanner). People, payer, currency, title, finishing, deleting and share links stay with the owner (403 `owner_only`). Clients send `X-Bill-Version`. A stale save is refused (409 `bill_changed`, `by`) only when **someone else** touched the same thing since: receipt vs receipt/quick/currency/scan; shares vs shares on the same items, quick or scan. Two people ticking different items both land.
- **Live**: `GET /bills/{id}/live?version=` every 4 s while a shared bill is open and the tab is visible. It returns who's here (in-memory presence, one instance) and the bill only when it moved. The web applies it only when the screen has nothing unsaved (`useDraftGuard`, wired in `FlowShell`), so a draft keeps its base version. Review resyncs a clean draft when someone else's save lands; a refused save resets to the latest with the server's message.
- **Mailbox**: requests are read live from their tables (friend requests, link invites, claims on bills you own); updates are rows. Badge = requests + unread. "Ben edited Dinner" only for *finished* bills, and repeat edits fold into one unread line.
- **Money across owners** (`settle_up.py`): people are matched by account (`u:<id>`) across bills; placeholders stay per owner (`p:<id>`). On your own bills every debt counts; on shared bills only yours do. A group plan covers its members' debts on any bill you can see, simplifying accounts only (placeholders sit in `separate`). Recording a piece writes the settlement when you own the bill or receive the money; otherwise it becomes an "I've paid" claim for the bill's owner (`SettlePiece.pending`, which undo withdraws).
- **Share links**: a person with an account must be signed in as themselves to claim (403 `sign_in_required`). The share page sends them to `/login?next=/s/<token>`, and Google returns there (`NEXT_KEY` in sessionStorage).
- **Friend privacy**: `POST /friends/requests` always answers `sent` (202). It answers differently only for yourself, "already friends", and a decline less than 30 days old (all things the sender already knows). Rate limited to 10/min and 40/day per account (`RATE_LIMIT_FRIEND_REQUESTS`).
- **Accounts**: Google-only requests (`google_required` for any other sign-in in production). Approval creates the profile for the same auth user (`must_change_password=false`), and there is no password to hand over. This needs Supabase sign-ups on (`disable_signup: false`, owner's decision 2026-11-09). An auth user without a profile can only ask.

## 4. Web

- Mailbox: sidebar item with a count (desktop). On phones, an envelope with its count in the top bar of every tab page (`PhoneBar` in `AppShell`), so the bottom tabs stay at four. Home's old "To confirm" became one line into the Mailbox (`WaitingOnYou`).
- People: friends (`@id`) and placeholders in one ledger. Add friend (exact email/id plus "On your bills" suggestions), a person sheet (link a placeholder to a friend, unfriend, block), Groups in the desktop rail (editor + plan sheet with Paid toggles and Send plan), and a Blocked list.
- Bill pages: `Together` (who's here / "Maya just made a change") in FlowShell and Summary. Members get "I've paid" on their own row, "Received" toggles when they're the payer, and a read-only People step. Assign starts on your own row; for a member, "Done" leaves the finishing to the owner.
- PeoplePicker: friends show `@id`; group chips tick everyone in a group.
- Account: user id, email, "Friends can find me". Admin: "Asking to join".

## 5. Local review

`docker compose up -d db api`, `docker compose exec api python -m app.cli dev-seed`, then `cd web && npm run dev`. The seed adds:
- George ↔ Maya friends; the hotpot is shared with Maya.
- George ↔ Arjun friends, with a pending link invite for "Arjun Nair".
- A friend request from Lena.
- Maya's "Tiong Bahru brunch", where George owes her.
- George's group "Hotpot crew".
- Priya's access request.

Dev login with an unknown email + `DEV_LOGIN_PASSWORD` stands in for a new Google user.

## 6. Checks run

- Backend: 354 passed (13 new in `tests/test_user_profiles.py`); migration down/up round trip.
- Web: typecheck, lint, 206 unit tests, build, grep gate.
- Playwright: 34 passed. The sharing spec now also covers the sign-in gate.

## 7. Not done / follow-ups

- Presence is in-memory, which only works because the API runs as a single instance. Move it to the DB if that changes.
- `plan_sent` is informational: members can't record "their row" from the Mailbox. The owner records it from the group.
- A placeholder linked while its owner also had a friend entry with history archives that entry. Both stay linked, so balances merge. A bill holding both rows shows the person twice.
