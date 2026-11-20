# Campaign Website — V3

Live campaigns → user completes → reward lands in an in-site **wallet**: Pending → **Approved (release pending)** → admin manually releases on/after the expected credit date → Withdrawable → withdrawal to UPI / bank / gift card, approved by admin.

V2 additions: auto pricing from upstream payout (admin margin rule), multi-feed auto import with auto-hide, custom/referral-link campaigns with manual claims (fixed or random reward), manual wallet release with expected credit dates, admin Earnings summary, and MMP-style app-event postbacks (install/register/kyc) advancing the same timeline.

V3 additions: **Postgres storage for production** (Supabase) — because Render Free's filesystem is ephemeral and a SQLite file would be wiped on every restart, losing wallet/money data — plus **automatic data retention** (raw tracking data purged at 30 days; financial records only 60 days after their case fully closes, and never while an account holds a balance or an open state).

Stack: Node.js 24, server-rendered HTML, phone-first CSS. One dependency (`pg`, pure JS). Runs the same on x86 and ARM64.

## Run locally

```bash
cp .env.example .env     # set POSTBACK_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
node src/server.js       # http://localhost:3000
```

Demo data (local testing only): set `SEED_DEMO=true` in `.env` — seeds 3 fake campaigns. **Off by default; never enable in production.**

Tests: `npm test` — HTTP end-to-end suite (auth, postback flow, idempotency, leak test, withdrawals) + SQL-translator unit tests + retention tests + Postgres smoke test (skips itself when `TEST_DATABASE_URL` is unset). Results: `TEST-RESULTS.md`.

## Database — Postgres in production, SQLite locally

One async data layer (`src/db.js`), two engines, chosen at boot:

| `DATABASE_URL` | Engine | Where data lives |
|---|---|---|
| **set** | PostgreSQL via `pg` (pool, SSL) | Supabase — all app tables in a dedicated schema named **`campaign`**, created automatically on boot (idempotent). Never touches the EXN app's tables in the same project. |
| unset | SQLite via built-in `node:sqlite` | `DB_PATH` file (local dev/tests only) |

SQL is written once in the SQLite dialect; the pg facade translates it (placeholders `?`→`$n`, schema-qualification into `campaign`, `datetime('now')`, scalar `MAX`→`GREATEST`, `INSERT OR IGNORE`, `RETURNING id` for insert ids). Behaviour — routes, wallet/postback/referral logic, leak guarantees — is identical on both engines.

## Data retention (automatic)

Runs once on boot and then daily (`src/retention.js`); the admin dashboard shows the last cleanup time. Two server-side settings (Admin/DB settings): `retention_days` (default **30**) and `financial_retention_days` (default **60**).

- **Raw tracking data — purged after 30 days:** postback logs, expired sessions, clicks in a terminal state (rejected / never converted) with no conversion or claim attached. Clicks that must be kept (a conversion/claim references them) are **not** deleted — only their stored IP / user-agent is stripped after 30 days.
- **Financial records — purged only 60 days after FULL closure:** a conversion counts as closed when approved **and** released (including its referral commission), or rejected; a withdrawal when paid or rejected-and-refunded; wallet-ledger entries when their account is fully closed. **Hard guard:** if the owning account has *any* non-zero balance (pending / approved / withdrawable) or *any* open state (pending conversion, approved-but-unreleased conversion, pending withdrawal, pending claim), its financial records are **never** purged — they roll forward until the account closes, and only then does the 60-day clock run. User accounts are never deleted.

## Env vars

| Var | Purpose |
|---|---|
| `PORT` | default 3000 |
| `DATABASE_URL` | **Production:** Supabase transaction-pooler Postgres URL → enables Postgres mode (schema `campaign`). Empty → local SQLite |
| `DB_PATH` | SQLite file (only when `DATABASE_URL` is empty), default `./data/app.db` |
| `SEED_DEMO` | `true` only for local demo |
| `POSTBACK_SECRET` | shared secret networks must send with postbacks |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | admin account auto-created on first boot |
| `NETWORK_FEED_URL` / `NETWORK_FEED_TOKEN` | legacy single feed (server-side only) — first boot par Admin → Settings ki multi-feed list me migrate ho jata hai; naye feeds wahi se add hote hain |
| `COOKIE_SECURE` | `true` behind HTTPS |

## How tracking works

1. User clicks **Start Campaign** → server creates a unique `click_id` and shows a live progress timeline: Clicked → Tracking Started → Installed → Registered → KYC/Event Done → Approved → Wallet Credited (page auto-refreshes every 4s).
2. Give the network a tracking link that carries this `click_id`, and set the network's postback to:

```
POST https://YOUR-DOMAIN/api/postback
Header: x-postback-secret: <POSTBACK_SECRET>     (or pass ?secret=... — header preferred)
Body (JSON or form): click_id, event, status, txn_id
```

- `event`: `tracking` | `install`/`installed` | `register`/`registered` | `kyc`/`event` (advances the timeline only). App campaigns work the same way — the MMP/network fires these events from inside the app, so the user's progress page moves without the user visiting the website.
- `status`: `pending` → credits the user's **Pending** wallet (once — duplicates are idempotent); `approved` → moves it to **Approved (release pending)** and holds the referrer's commission the same way, and shows the user an **expected wallet credit date** (approval + *credit days*, default 7, per-campaign override possible); `rejected` → removes the pending credit.
- **Release is manual:** Admin → Releases lists every approved conversion (due ones highlighted). Single release or "Release ALL due" moves the money to **Withdrawable** (and pays the held referral commission) — only then does the timeline reach "Wallet Credited".
- Every postback call (accepted or rejected) is logged in Admin → Conversions & Postbacks. Unsigned/wrong-secret calls get `401` and credit nothing.

Per network: in that network's panel, paste the same postback URL and map their macros to `click_id` / `status` / `txn_id` (e.g. Trackier, Everflow, Affise all support a global postback URL with macros — put your `click_id` in their sub-id field when generating the tracking link).

## Campaign sources (hybrid)

- **Auto (multi-feed):** Admin → Settings me jitne chaaho utne feeds add karo (name + URL + token, server-side only, enable/disable/delete). Admin → **Import campaigns from ALL feeds now** har enabled feed ke saare offers import karta hai. Feed format: JSON array or `{campaigns:[...]}` with `external_id, title, upstream_payout_paise, steps[], rules`. Re-import upserts, no duplicates. **Jo offer feed se gayab ho jata hai, woh site par auto-hide ho jata hai.**
- **Auto pricing / margin:** Feed item me `upstream_payout_paise` ho to user reward khud ban jata hai = `floor(upstream × user share %)` — Settings me **User share %** (default 87.5%, matlab ₹400 wale offer par user ko ₹350, baaki admin margin — margin server par hi rehta hai, frontend par kabhi nahi). Kisi campaign ka reward haath se fix karna ho to uski Edit screen me reward daal kar **Manual reward lock** on kar do — phir auto pricing use nahi badlegi.
- **Manual (network):** Admin → Campaigns → New Campaign, type = Network (premium/manager-given offers).
- **Custom (apna referral link):** Type = Custom. Apna referral link Link URL me daalo, reward **Fixed** ya **Random range** (jaise ₹100–₹150) chuno. Isme koi postback nahi ata — user link se task karke apni progress page se **Claim** submit karta hai (note + optional proof link). Admin → Claims me Approve (random amount approval ke time roll hokar fix ho jata hai) ya Reject with reason (reason user ko dikhta hai). Approved claim bhi usi release flow se wallet me jata hai.

## Admin Earnings

Admin → **Earnings** (sirf admin login par): total upstream payout approved, user rewards released / release-pending, referral paid / pending, aur **admin margin** (payout − user reward − referral), approved aur released dono basis par. Yeh numbers public pages/API me kahin nahi jate.

## Security — no frontend leak

Upstream payout, margins, feed URL/token and the postback secret live **only** on the server (DB / env). Public pages and `/api/campaigns` return only: id, title, description, category, geo, icon, user reward, steps, rules, live status. Admin forms never echo saved secret/payout values back into HTML. The test suite greps every public page + API for seeded secret/payout/sentinel strings and fails if any appear.

Passwords: Node `scrypt` hashes. Sessions: random token, SHA-256 hash stored server-side, `HttpOnly; SameSite=Lax` cookie; "Remember me" = 30-day cookie.

## Deploy — Render (production) + Supabase Postgres

Render Free's filesystem is **ephemeral** — never store the wallet database in a file there. Production runs on Postgres:

1. In the owner's existing Supabase project: Dashboard → Project Settings → Database → **Connection string → Transaction pooler** (port **6543**). Copy that URI.
2. Render → New Web Service → this repo (Docker, or Node with `npm install` + `node src/server.js`) → set env vars:
   - `DATABASE_URL` = the pooler URI from step 1 (SSL is handled by the app)
   - `POSTBACK_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` — real values
   - `SEED_DEMO=false`, `COOKIE_SECURE=true`
3. Deploy. On first boot the app creates the **`campaign`** schema and all tables inside the Supabase project (nothing collides with the EXN app's tables) and seeds the admin from env. No persistent disk is needed on Render in this mode.
4. Verify: open `/health`, log in as admin, and (optionally) run the Postgres smoke test against the same database: `TEST_DATABASE_URL=<pooler URI> node tests/pg-smoke.mjs`.

## Deploy — Docker (Oracle Cloud A1 / any VPS)

```bash
cp .env.example .env   # fill real values, SEED_DEMO=false; set DATABASE_URL for Postgres, or leave empty for SQLite-on-volume
docker compose up -d --build
# app on :3000; SQLite (only when DATABASE_URL is empty) persisted in the campaign-data volume
```

The Dockerfile is architecture-neutral (`node:24-bookworm-slim`) — the same build runs on Oracle A1 (linux/arm64) and on x86/Render.

Note: a real Oracle Cloud account signup needs a card for verification — if that's blocked, any Docker VPS or Render works identically with the files above.

## Admin

`/admin` (login with the admin account): Campaigns CRUD + live on/off (type Network/Custom, fixed/random reward, credit-days override, reward lock), **Releases** (single + bulk-due), **Claims** (approve/reject with reason), **Earnings**, Users, Conversions & Postback Log, Withdrawals approve (marks paid) / reject (auto-refunds wallet), Settings — referral %, minimum withdrawal, **user share %**, **credit days**, multi-feed list, postback secret (all shown masked, server-side only).
