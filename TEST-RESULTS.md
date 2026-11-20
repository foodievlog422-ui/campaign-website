# Test Results — Campaign Website V3

Run: 2026-11-20 (IST), in this VM. Command: `npm test` — now a chain of four suites:
`tests/run-tests.mjs` (HTTP end-to-end, SQLite) + `tests/test-translate.mjs` (Postgres SQL translator units) + `tests/test-retention.mjs` (retention, facade-level) + `tests/pg-smoke.mjs` (live Postgres smoke — self-skips without `TEST_DATABASE_URL`).

## Headline results

| Suite | Result |
|---|---|
| HTTP end-to-end (SQLite, real server over HTTP) | **46/46 PASS** (unchanged from V2.1 — same behaviour on the new async data layer) |
| SQL translator unit tests (`translatePgSql`) | **12/12 PASS** |
| Retention tests (both tiers) | **15/15 PASS** |
| Postgres smoke (`TEST_DATABASE_URL`) | **SKIPPED in this VM** — no live Postgres available here; the live run is part of deploy verification (see below) |
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
