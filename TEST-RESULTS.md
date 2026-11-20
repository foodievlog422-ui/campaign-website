# Test Results — Campaign Website V4

Run: 2026-11-20 (IST), in this VM. Command: `npm test` — a chain of four suites:
`tests/run-tests.mjs` (HTTP end-to-end, SQLite) + `tests/test-translate.mjs` (Postgres SQL translator units) + `tests/test-retention.mjs` (retention, facade-level) + `tests/pg-smoke.mjs` (live Postgres smoke — self-skips without `TEST_DATABASE_URL`).

## Headline results

| Suite | Result |
|---|---|
| HTTP end-to-end (SQLite, real server over HTTP) | **65/65 PASS** (46 carried over from V3 + 19 new V4 checks) |
| SQL translator unit tests (`translatePgSql`) | **12/12 PASS** |
| Retention tests (both tiers) | **15/15 PASS** |
| Postgres smoke (`TEST_DATABASE_URL`) | **SKIPPED in this VM** — no live Postgres available here; the live run is part of deploy verification (see below) |

## V4 changes — UI redesign, inline form errors, admin password

**UI redesign (`public/style.css` rewritten + server templates):** warm off-white paper background (`#FAF7F1`), deep-green header (`#0A3524`) and primary buttons (`#0E6B3F`), single amber accent (`#E9A13B`/`#B45309`) for the logo mark, category chips and DUE badges. No gradients, no neon, system font stack only (no external font/CDN that can fail). Home now has a hero ("Campaigns complete karo, paisa kamao"), a 3-step "kaise kaam karta hai" strip, trust chips, and campaign cards with a "You get ₹…" reward block; campaign detail has a green reward panel, numbered steps and a rules box; empty states are designed cards ("Campaigns jald aa rahe hain") instead of bare text; dashboard/admin use stat tiles; admin lists stay stacked cards on phone. All routes, copy (Hinglish) and the leak rules are unchanged — the full leak suite (test 6, 8b2, 8e3) still passes on the new templates.

**Inline form errors (no separate error page):** login, signup and admin login (same `/login` form) now re-render the SAME form with HTTP 200 on failure — the message appears in red (`.ferr`) directly under the field at fault, the field gets a red border (`.invalid`), entered values (name/email/phone/destination/amount) are preserved, and the password is never echoed. Wrong credentials show the generic "Email ya password galat hai" under BOTH the email and password fields. The same pattern was applied to the withdraw form (below-minimum / over-balance / missing destination re-render the wallet page) and to claim submit (empty note redirects back to the same progress page, which shows the red error under the note field).

**Admin password:** `ensureAdmin` now syncs on every boot — if `ADMIN_EMAIL`/`ADMIN_PASSWORD` are set, the admin is created when missing and its hash is updated whenever the env password differs (verified by test 9f: boot with password A → A works; restart with password B → B works, A fails). New **Admin → Change Password** page: current + new + confirm, inline errors for wrong current / short new / mismatched confirm, success notice on the same page, and the existing session stays logged in. Documented caveat: a later restart re-syncs the password from env, so the env must be updated after a panel change.

**New HTTP tests (19, all PASS — section 9 of `tests/run-tests.mjs`):**
- 9a1–9a4 wrong-password login returns the login page itself (200, form present), red errors under both fields + red borders, email preserved, wrong password absent from the HTML, unknown email gets the same generic error.
- 9b1–9b2 signup: short password and duplicate email produce inline errors on the signup form with values preserved.
- 9c1–9c3 withdraw: over-balance and below-minimum re-render the wallet page with the red error and preserved amount/destination.
- 9d1 claim with an empty note returns to the progress page showing the red error under the note field.
- 9e1–9e7 change-password page exists; wrong current and mismatched confirm fail inline; success keeps the session valid; old password then fails login (inline), new password logs in.
- 9f1–9f2 admin env-sync across a real server restart with a changed `ADMIN_PASSWORD`.

## V3 results (carried, still valid)
| Postgres engine verification via pg-mem (throwaway, not committed) | **9/9 PASS** (1 partial, documented below) |

## V3 change 1 — Postgres when `DATABASE_URL` is set

Why: Render Free's filesystem is ephemeral — the SQLite file would be wiped on every restart/redeploy, losing wallet/money data. Now: `DATABASE_URL` set → PostgreSQL via the `pg` package (the only dependency; pure JS, ARM-safe), with **all app tables in a dedicated schema `campaign`** inside the owner's existing Supabase project, so nothing collides with the EXN app's tables. No `DATABASE_URL` → local SQLite, unchanged. Schema + tables are created idempotently on boot; the admin is seeded from env exactly as before.

How: one async facade (`src/db.js`) — `await db.prepare(sql).get/all/run(...)`. SQL is written once in the SQLite dialect and translated for Postgres: `?`→`$1..$n`, tables schema-qualified (`campaign.<table>`), `datetime('now')`→ UTC `to_char(...)` (same text format), scalar `MAX(a,b)`→`GREATEST(a,b)`, `INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`, serial inserts get `RETURNING id` so `lastInsertRowid` behaves like SQLite, and pg int8/numeric are parsed to JS numbers so COUNT/SUM/money math is identical. Money/id columns are `BIGINT` in Postgres (SQLite INTEGER is 64-bit; pg INTEGER would overflow epoch-ms session expiries).

Translator units (12/12): placeholders + qualification; user INSERT → `RETURNING id`; sessions INSERT → no RETURNING (no serial id); `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`; settings upsert `excluded.*` preserved; `datetime('now')` conversion; `MAX(stage,1)` → `GREATEST(stage,1)`; importer upsert (`ON CONFLICT(source,external_id) DO UPDATE … excluded.*`) preserved with `RETURNING id` appended; 3-table JOIN qualification with aliases intact; aggregate `SUM(...)` untouched; correlated `NOT EXISTS` delete qualification; no `?` survives in any sample.

pg-mem verification (throwaway harness in /tmp, not committed): the repo's real `PG_DDL`, `translatePgSql` and `runRetention` were executed against pg-mem (in-process Postgres semantics). Passed: DDL creates schema + all 10 tables; INSERT OR IGNORE keeps first value; settings upsert updates; user insert returns numeric id; session insert + BIGINT expiry roundtrip; GREATEST stage update + timestamp format; SUM returns a JS number; importer upsert updates in place. **Partial:** retention's correlated `NOT EXISTS` deletes hit a pg-mem limitation (it cannot resolve bare correlation names like `clicks.click_id` against schema-qualified DELETE targets — valid standard SQL in real Postgres, where the correlation name is the base table name; the identical statements pass on SQLite in the retention suite, and the non-correlated retention deletes were verified in pg form). pg-mem also needed shims for `AT TIME ZONE`/`to_char`, both native in real Postgres. **The live Postgres run (`tests/pg-smoke.mjs` with `TEST_DATABASE_URL` set to the Supabase pooler URI) remains a deploy-verification step.**

## V3 change 2 — Data retention (two tiers)

`src/retention.js`, runs on boot + daily; windows are server-side settings: `retention_days` (default **30**) and `financial_retention_days` (default **60**). Admin dashboard shows the last cleanup time.

**Tier 1 — raw tracking data, purged after 30 days:** postback logs; expired sessions; clicks in a terminal state (rejected / claim-rejected / never converted) with **no** conversion and **no** claim attached. Clicks that carry a conversion/claim are kept — only their stored IP/user-agent is stripped after 30 days.

**Tier 2 — financial records, purged only 60 days AFTER FULL CLOSURE.** This distinction is deliberate and tested explicitly:
- A conversion is closed when **approved AND released** (referral commission released too, if any), clock from `released_at` — or **rejected**, clock from `updated_at`.
- A withdrawal is closed when **paid**, or **rejected-and-refunded**, clock from `processed_at`.
- Wallet-ledger entries purge only when **their account is fully closed**.
- **HARD GUARD:** if the owning account has **any non-zero balance** (pending / approved / withdrawable) or **any open state** (pending conversion, approved-but-unreleased conversion, pending withdrawal, pending claim), its financial records are **never purged** — they roll forward until closure, and only then does the 60-day clock run. User accounts are never deleted.

Retention tests (15/15, `tests/test-retention.mjs`) — the required distinction, side by side:
- **Closed 61-day-old financial record → PURGED:** conversion (approved + released 61 days ago), paid withdrawal (61 days), and both wallet-ledger entries of a zero-balance, fully-closed account are all deleted (report counts: 1 conversion / 1 withdrawal / 2 ledger).
- **Equally old record with a non-zero balance → SURVIVES:** the same trio aged 61 days on an account holding ₹50 withdrawable — conversion, withdrawal and ledger all kept, balance untouched.
- **Open states survive regardless of age:** a 61-day-old *pending* conversion and a 61-day-old *approved-but-unreleased* conversion are kept, and their account's ledger is kept.
- **Clock starts at closure, not creation:** a conversion released only 31 days ago is kept (31 < 60).
- Tier 1 alongside: 31-day terminal click deleted, 1-day terminal click kept, 31-day click *with* a conversion kept with IP/UA stripped, 31-day postback log deleted / fresh kept, expired session deleted / valid kept, user accounts + balances never touched.

## Carried-over V2.1 results (HTTP suite, still 46/46 on the V3 data layer)

The full V1+V2+V2.1 table from the previous run stands — auth + remember-me, click → postback pending → duplicate idempotent → install event → approval to **Approved (release pending)** → admin manual release → withdrawable + referral paid, wrong-secret 401, **leak tests clean** (no secret / upstream payout / margin / sentinel in any public page or API), withdrawals + admin approve, app-event sequence (install→register→kyc via postbacks only), multi-feed import + auto pricing (₹400 × 87.5% = ₹350) + auto-hide, custom/referral campaigns with claims (fixed/random roll, reject reason), admin Earnings, and the admin campaign-list payout/reward/margin chips (admin-only, values absent publicly). Raw HTTP log: `tests/last-run.txt`.

## Notes

- **Docker:** `docker` is not installed in this VM, so the image was not built here. The Dockerfile now runs `npm ci --omit=dev` (for `pg`) before copying sources; build on the target host with `docker compose up -d --build`.
- **SEED_DEMO** remains off by default and demo seeding is unchanged.
