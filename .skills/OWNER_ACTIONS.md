# Owner actions

Things only the owner can do: dashboards, interactive logins, or choices. Put every secret in the **repo-root `.env`** (gitignored). Never paste secrets into chat.
Tick items off as you go. Agents check this file at the start of each phase.

## Needed now (unblocks P4 benchmark and P5 deploy; work can continue without them)

- [ ] **GitHub CLI login**: run `gh auth login --scopes workflow` in your own terminal and pick GitHub.com → HTTPS → browser. The `workflow` scope is required to push `.github/workflows/*`.
- [ ] **Supabase personal access token**: supabase.com → Account → Access Tokens → generate. Add `SUPABASE_ACCESS_TOKEN=` to `.env`. With it, the agent creates the new project in `ap-southeast-1` and configures Auth (signups off, URLs) through the Management API. **Check that you have a free project slot**: Free allows 2 active projects.
- [ ] **Render**: (1) Dashboard → Account → connect GitHub and give the Render GitHub App access to `GeorgePPP/bill_splitter`. (2) Account Settings → API Keys → create one, then add `RENDER_API_KEY=` to `.env`. The agent will try to create the free Docker service through the API; if Render refuses a free-plan create via API, it becomes a 2-minute dashboard step.
- [ ] **Cloudflare**: My Profile → API Tokens → Create → Custom: *Account → Cloudflare Pages → Edit*, scoped to your account. Add `CLOUDFLARE_API_TOKEN=` and `CLOUDFLARE_ACCOUNT_ID=` to `.env`.
- [ ] **Azure Document Intelligence**: confirm the resource's pricing tier is **F0 (free)** and tell the agent its region. Portal → the resource → Overview.
- [ ] **OpenAI**: (1) create a **project-scoped key** for this app and replace `OPENAI_API_KEY`. (2) Settings → Limits → set a **monthly budget**. Tell the agent the number; the in-app cap is set slightly below it.
- [ ] **Sample receipts**: put 10–20 real receipts (photos and a few PDFs) in `.local/receipts/` (gitignored, never committed). Include tax-inclusive, service charge + SST/GST, discounts, a long multi-photo receipt and a blurry one. They're used to benchmark models and to build *anonymised* OCR-text test fixtures.
- [ ] **Answers**: admin username; default currency (MYR? SGD?); OpenAI monthly $ budget.

## Later (the agent will prompt with exact values)

- [ ] **Google OAuth client** (only for Google sign-in): Google Cloud → OAuth client (Web), with JS origins and the Supabase callback URI the agent gives you.
- [ ] **Render env vars** if service creation via API isn't possible.
- [ ] **Rotate keys** that were ever shared outside `.env`.
