# Campaign Website — V2

Live campaigns → user completes → reward lands in an in-site **wallet**: Pending → **Approved (release pending)** → admin manually releases on/after the expected credit date → Withdrawable → withdrawal to UPI / bank / gift card, approved by admin.

V2 additions: auto pricing from upstream payout (admin margin rule), multi-feed auto import with auto-hide, custom/referral-link campaigns with manual claims (fixed or random reward), manual wallet release with expected credit dates, admin Earnings summary, and MMP-style app-event postbacks (install/register/kyc) advancing the same timeline.

Stack: Node.js 24 (built-in `node:sqlite`, **zero external dependencies**), server-rendered HTML, phone-first CSS. Runs the same on x86 and ARM64.

## Run locally

```bash
cp .env.example .env     # set POSTBACK_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
node src/server.js       # http://localhost:3000
```

Demo data (local testing only): set `SEED_DEMO=true` in `.env` — seeds 3 fake campaigns. **Off by default; never enable in production.**

Tests: `npm test` — end-to-end suite (auth, postback flow, idempotency, leak test, withdrawals). Results: `TEST-RESULTS.md`.

## Env vars

| Var | Purpose |
|---|---|
| `PORT` | default 3000 |
| `DB_PATH` | SQLite file, default `./data/app.db` |
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

## Deploy — Docker (Oracle Cloud A1 / any VPS / Render)

```bash
cp .env.example .env   # fill real values, SEED_DEMO=false
docker compose up -d --build
# app on :3000, SQLite persisted in the campaign-data volume
```

The Dockerfile is architecture-neutral (`node:24-bookworm-slim`) — the same build runs on Oracle A1 (linux/arm64) and on x86/Render. On Render instead: New Web Service → Docker → set the same env vars, attach a persistent disk mounted at `/app/data`.

Note: a real Oracle Cloud account signup needs a card for verification — if that's blocked, any Docker VPS or Render works identically with the files above.

## Admin

`/admin` (login with the admin account): Campaigns CRUD + live on/off (type Network/Custom, fixed/random reward, credit-days override, reward lock), **Releases** (single + bulk-due), **Claims** (approve/reject with reason), **Earnings**, Users, Conversions & Postback Log, Withdrawals approve (marks paid) / reject (auto-refunds wallet), Settings — referral %, minimum withdrawal, **user share %**, **credit days**, multi-feed list, postback secret (all shown masked, server-side only).
