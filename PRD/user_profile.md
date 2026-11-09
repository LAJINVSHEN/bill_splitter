# Background
- The current app assumes no user profile or connection associated with any members splitting the same bill. The advantage is it's light, fast and easy to use. The downside is that the user cannot sync their bill, owe or lend whatsoever across different users/device. If there's users ABC, they have to rely on 1 user to record the bill and hold the single source of truth which is heavy and no sync across.
- Inspired by Splitwise, users are allowed to create group, record billing within a group, chat in a group, and every bill is synced at group level as well as individual level. They also have a simplify debt feature to simplify the payment  (minimizes number of payments to be made to each and everyone).

# Objective
- To create a user profile feature that allows user to add other users by searching email in the server, and hence conduct a series of bill splitting related actions

# Scope
## What in scope:
- Allow adding by user id or user email (therefore each one has to be unique keys)
  - User id = the existing unique `username`; email becomes unique (case-insensitive) and is required for a user to be searchable
  - Accounts remain admin-controlled (no open self-signup): a person either requests an account and the admin approves it, or the admin creates it directly. A lightweight admin portion handles this (request queue, approve/reject, create account)
  - Search finds existing accounts only, by exact email or exact user id (no partial match / autocomplete). Searching an unknown email does not send an invite
- Features involving adding users to split bill, all the splitting logic remain
- Group expenses by people (select multiple people and make them a group and hence calculation logic applies to everyone including simplifying bills)
  - A group is a personal saved set of people owned by the creator (not a shared object); others do not see it
- Mailbox: Inter-user approval request and acceptance, e.g. invite to inherit bills (moving from a dummy placeholder to bills under "friend")
  - Also carries: friend requests, "declined" results, and edits made by others to a shared bill
  - In-app only: no push, no email. Items show as "unread" when the user comes into the app
- Shared bills between registered friends are co-editable (see Feature details)
## What not in scope:
- Splitwise type "Create expenses under a group", in this phase only can create bills at as-is entry point.
- Shared groups (members joining/leaving, everyone seeing the same group), group chat
- Push / email notifications
- Inviting people who have no account by email

# Feature details
- Add friends to my account: simple add friend feature by searching user_id or user_email - only effect is to be able to see owe how much/see lend how much/add this user to split bill as a "friend"
  - Flow: send request → the other side accepts or declines (sender may cancel; either side may block). A declined sender cannot re-send for 30 days
  - Privacy: search is rate-limited and returns the same response whether or not the account exists; a user can set themselves "not discoverable"
  - Unfriending archives the link and keeps all history on past bills (people on bills are never deleted)
- Add friends to bill: When splitting bills, user is able to add friends or as-is dummy placeholder bill (user with no intention to register an account should also be allowed to split bill)
  - Bills with a registered friend are shared and **co-editable**: any participant can edit items and shares, and the bill is live for everyone
  - Edits are not pushed. Others see "Ben edited Dinner" as an unread Mailbox item the next time they open the app
  - Conflicts: if two people save from the same version, the later save is rejected with "Ben changed this, review" and the user re-applies on the latest version. Every edit is logged
  - Only the bill owner can delete the bill. "Paid" stays a claim that the owner confirms (as today)
  - Currency per bill and the manual FX rate are unchanged; different currencies are never silently summed. Scan quota is charged to whoever scans
- Link a dummy placeholder person to one account and invite the people to inherit past bills - let's say I have been using Jeff several times, and I can tag this person with live-friends - Jeff@gmail.com, hence the bill will be merged to Jeff (if any)
  - Invite & accept: tagging sends Jeff a Mailbox request. Only on accept are the past bills linked to his account (they then appear under him as a "friend")
  - On decline: nothing changes, Jeff stays a placeholder, and the inviter gets a "declined" item in their Mailbox
  - Existing people stay placeholders until merged, so there is no migration break
- Simplify debt: runs across confirmed friends in a group; placeholders are listed separately and not simplified into real accounts. Simplified payments still map back to real bills

# Design
- Mailbox, friends and admin screens must be elegant and on-theme with the existing "even" Ledger direction (see `.skills/FRONTEND_GUIDE.md`): white, hairline rules, Archivo, cobalt only on interactive things. No generic icon-library look

# Risks / to watch
- Co-editing is the largest cost: it touches every bill write path and must be reconciled with the existing share-link and payment-claim flow
- No email provider: after approval the admin hands over the temporary password, as today
- Email search can expose who has an account, hence the exact-match, rate-limit and not-discoverable rules above

# Suggested phasing
1. Schema (email uniqueness, friendships, mailbox items, link placeholder→account, bill members, bill version + edit log, groups)
2. Admin signup requests / approval
3. Friends: search, request, accept, block
4. Mailbox UI and unread badge
5. Placeholder merge
6. Shared co-edit and conflict handling
7. Groups and simplify
