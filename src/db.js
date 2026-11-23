import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { hashPassword, verifyPassword, randomCode } from './lib.js';

// ---------------------------------------------------------------------------
// V3 data layer: ONE async facade, two engines.
//  - DATABASE_URL set   -> PostgreSQL (Supabase pooler on Render). The app's
//    tables live in a dedicated schema `campaign`, so they never collide
//    with the EXN app's tables in the same Supabase project. SQLite's file
//    storage on Render Free is ephemeral — Postgres is the money-safe store.
//  - DATABASE_URL unset -> local SQLite (node:sqlite), unchanged for dev/tests.
//
// Call sites use:  await db.prepare(sql).get(...)/.all(...)/.run(...)
// (or the db.get/db.all/db.run shortcuts). SQL is written ONCE in the SQLite
// dialect; the pg facade translates it (see translatePgSql).
// ---------------------------------------------------------------------------

// Postgres returns int8 (COUNT, SUM, BIGSERIAL ids) and numeric as strings by
// default. The whole app expects JS numbers (exactly like SQLite), so parse
// them to Number globally. All values here (paise amounts, ids) are far
// below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

export const PG_SCHEMA = 'campaign';
const TABLES = ['settings', 'users', 'sessions', 'campaigns', 'clicks', 'conversions',
  'wallet_ledger', 'postback_log', 'withdrawals', 'claims'];
// Tables whose primary key is not a serial `id` — pg run() must not append
// RETURNING id for them.
const NO_ID_TABLES = new Set(['settings', 'sessions']);
// Same text shape as SQLite datetime('now'): UTC 'YYYY-MM-DD HH:MM:SS'.
const NOW_PG = `to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')`;

// Translate one SQLite-dialect statement into Postgres dialect, qualified
// into the `campaign` schema. Handles exactly the constructs this codebase
// uses (verified by tests/test-translate.mjs):
//   ? placeholders            -> $1..$n   (no '?' appears inside SQL literals)
//   datetime('now')           -> NOW_PG expression
//   MAX(col, n) scalar        -> GREATEST(col, n)   (aggregate MAX is unused)
//   INSERT OR IGNORE INTO t   -> INSERT INTO t ... ON CONFLICT DO NOTHING
//   FROM/JOIN/INTO/UPDATE t   -> ... campaign.t
//   INSERT INTO t (serial id) -> appends RETURNING id so run() can report
//                                lastInsertRowid like SQLite does.
// Postgres natively accepts the codebase's ON CONFLICT(...) DO UPDATE SET
// col=excluded.col upserts, so those pass through unchanged.
export function translatePgSql(sql) {
  let text = String(sql).trim().replace(/;\s*$/, '');
  let onConflictDoNothing = false;
  if (/^INSERT\s+OR\s+IGNORE\s+INTO/i.test(text)) {
    text = text.replace(/^INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    onConflictDoNothing = true;
  }
  text = text.replace(/datetime\('now'\)/gi, NOW_PG);
  text = text.replace(/\bMAX\((\s*[A-Za-z_][\w.]*\s*),(\s*\d+\s*)\)/g, 'GREATEST($1,$2)');
  for (const t of TABLES) {
    text = text.replace(new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${t}\\b`, 'gi'), `$1 ${PG_SCHEMA}.${t}`);
  }
  let n = 0;
  text = text.replace(/\?/g, () => `$${++n}`);
  let returningId = false;
  const ins = text.match(/^INSERT\s+INTO\s+campaign\.(\w+)/i);
  if (ins && !NO_ID_TABLES.has(ins[1].toLowerCase()) && !/RETURNING/i.test(text)) {
    if (onConflictDoNothing) text += ' ON CONFLICT DO NOTHING';
    text += ' RETURNING id';
    returningId = true;
  } else if (onConflictDoNothing) {
    text += ' ON CONFLICT DO NOTHING';
  }
  return { text, returningId };
}

function sqliteFacade(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const prepare = (sql) => {
    const stmt = raw.prepare(sql);
    return {
      get: async (...p) => stmt.get(...p),
      all: async (...p) => stmt.all(...p),
      run: async (...p) => {
        const r = stmt.run(...p);
        return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes };
      },
    };
  };
  return {
    mode: 'sqlite',
    prepare,
    get: (sql, ...p) => prepare(sql).get(...p),
    all: (sql, ...p) => prepare(sql).all(...p),
    run: (sql, ...p) => prepare(sql).run(...p),
    exec: async (sql) => { raw.exec(sql); },
    close: async () => { raw.close(); },
  };
}

function pgFacade(connectionString) {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString) || connectionString.includes('sslmode=disable');
  const pool = new pg.Pool({
    connectionString,
    ssl: local ? undefined : { rejectUnauthorized: false }, // Supabase pooler requires SSL
    max: 5,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) => console.error('[pg pool]', err.message));
  const prepare = (sql) => {
    const { text, returningId } = translatePgSql(sql);
    return {
      get: async (...p) => (await pool.query(text, p)).rows[0],
      all: async (...p) => (await pool.query(text, p)).rows,
      run: async (...p) => {
        const r = await pool.query(text, p);
        return { lastInsertRowid: returningId && r.rows[0] ? r.rows[0].id : undefined, changes: r.rowCount ?? 0 };
      },
    };
  };
  return {
    mode: 'pg',
    prepare,
    get: (sql, ...p) => prepare(sql).get(...p),
    all: (sql, ...p) => prepare(sql).all(...p),
    run: (sql, ...p) => prepare(sql).run(...p),
    exec: async (sql) => { await pool.query(sql); },
    close: async () => { await pool.end(); },
  };
}

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '',
    pass_hash TEXT NOT NULL, referral_code TEXT NOT NULL UNIQUE,
    referred_by INTEGER REFERENCES users(id), is_admin INTEGER NOT NULL DEFAULT 0,
    pending_paise INTEGER NOT NULL DEFAULT 0, withdrawable_paise INTEGER NOT NULL DEFAULT 0,
    approved_paise INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- upstream_payout_paise and internal_notes are SERVER-ONLY. Never serialize them.
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, description TEXT DEFAULT '', category TEXT DEFAULT 'General',
    geo TEXT DEFAULT 'India', icon_text TEXT DEFAULT 'C',
    user_reward_paise INTEGER NOT NULL DEFAULT 0,
    upstream_payout_paise INTEGER NOT NULL DEFAULT 0,
    internal_notes TEXT DEFAULT '',
    steps_json TEXT NOT NULL DEFAULT '[]', rules_text TEXT DEFAULT '',
    campaign_type TEXT NOT NULL DEFAULT 'network',
    reward_mode TEXT NOT NULL DEFAULT 'fixed',
    reward_min_paise INTEGER NOT NULL DEFAULT 0, reward_max_paise INTEGER NOT NULL DEFAULT 0,
    reward_override INTEGER NOT NULL DEFAULT 0,
    link_url TEXT DEFAULT '', credit_days INTEGER,
    source TEXT NOT NULL DEFAULT 'manual', external_id TEXT DEFAULT '',
    is_live INTEGER NOT NULL DEFAULT 1, hide_from_list INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, external_id)
  );
  CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    click_id TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id),
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    stage INTEGER NOT NULL DEFAULT 0, conv_status TEXT NOT NULL DEFAULT 'none',
    ip TEXT DEFAULT '', ua TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    click_id TEXT NOT NULL UNIQUE REFERENCES clicks(click_id),
    status TEXT NOT NULL DEFAULT 'pending', txn_id TEXT DEFAULT '',
    user_reward_paise INTEGER NOT NULL DEFAULT 0,
    upstream_payout_paise INTEGER NOT NULL DEFAULT 0,
    pending_credited INTEGER NOT NULL DEFAULT 0, approved_credited INTEGER NOT NULL DEFAULT 0,
    referral_credited INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT DEFAULT '', expected_credit_date TEXT DEFAULT '',
    released INTEGER NOT NULL DEFAULT 0, released_at TEXT DEFAULT '',
    referral_amount_paise INTEGER NOT NULL DEFAULT 0, referral_released INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS wallet_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
    amount_paise INTEGER NOT NULL, ref TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS postback_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')), ip TEXT DEFAULT '',
    click_id TEXT DEFAULT '', event TEXT DEFAULT '', status TEXT DEFAULT '',
    accepted INTEGER NOT NULL DEFAULT 0, reason TEXT DEFAULT '', payload_json TEXT DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id), amount_paise INTEGER NOT NULL,
    method TEXT NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    click_id TEXT NOT NULL UNIQUE REFERENCES clicks(click_id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    note TEXT DEFAULT '', proof_url TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT DEFAULT '',
    rolled_reward_paise INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), processed_at TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS affiliates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    first_name TEXT NOT NULL DEFAULT '', surname TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', dob TEXT NOT NULL DEFAULT '',
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS affiliate_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliate_id INTEGER NOT NULL REFERENCES affiliates(id),
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    visitor_name TEXT NOT NULL DEFAULT '', visitor_phone TEXT NOT NULL DEFAULT '',
    pay_method TEXT NOT NULL DEFAULT 'upi', upi_id TEXT DEFAULT '', upi_name TEXT DEFAULT '',
    bank_details TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'started',
    visitor_reward_paise INTEGER NOT NULL DEFAULT 0,
    affiliate_amount_paise INTEGER NOT NULL DEFAULT 0,
    affiliate_released INTEGER NOT NULL DEFAULT 0,
    visitor_paid INTEGER NOT NULL DEFAULT 0,
    ip TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT DEFAULT ''
  );
`;

// Postgres twin of SQLITE_DDL (exported for tests): same tables/columns, in the `campaign` schema.
// Money/id columns are BIGINT (SQLite INTEGER is 64-bit; pg INTEGER is 32-bit
// and epoch-ms in sessions.expires_at would overflow it). Idempotent.
export const PG_DDL = `
  CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA};
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.users (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '',
    pass_hash TEXT NOT NULL, referral_code TEXT NOT NULL UNIQUE,
    referred_by BIGINT REFERENCES ${PG_SCHEMA}.users(id), is_admin INTEGER NOT NULL DEFAULT 0,
    pending_paise BIGINT NOT NULL DEFAULT 0, withdrawable_paise BIGINT NOT NULL DEFAULT 0,
    approved_paise BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (${NOW_PG})
  );
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.sessions (
    token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES ${PG_SCHEMA}.users(id),
    expires_at BIGINT NOT NULL, created_at TEXT NOT NULL DEFAULT (${NOW_PG})
  );
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.campaigns (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL, description TEXT DEFAULT '', category TEXT DEFAULT 'General',
    geo TEXT DEFAULT 'India', icon_text TEXT DEFAULT 'C',
    user_reward_paise BIGINT NOT NULL DEFAULT 0,
    upstream_payout_paise BIGINT NOT NULL DEFAULT 0,
    internal_notes TEXT DEFAULT '',
    steps_json TEXT NOT NULL DEFAULT '[]', rules_text TEXT DEFAULT '',
    campaign_type TEXT NOT NULL DEFAULT 'network',
    reward_mode TEXT NOT NULL DEFAULT 'fixed',
    reward_min_paise BIGINT NOT NULL DEFAULT 0, reward_max_paise BIGINT NOT NULL DEFAULT 0,
    reward_override INTEGER NOT NULL DEFAULT 0,
    link_url TEXT DEFAULT '', credit_days INTEGER,
    source TEXT NOT NULL DEFAULT 'manual', external_id TEXT DEFAULT '',
    is_live INTEGER NOT NULL DEFAULT 1, hide_from_list INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (${NOW_PG}),
    UNIQUE(source, external_id)
  );
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.clicks (
    id BIGSERIAL PRIMARY KEY,
    click_id TEXT NOT NULL UNIQUE, user_id BIGINT NOT NULL REFERENCES ${PG_SCHEMA}.users(id),
    campaign_id BIGINT NOT NULL REFERENCES ${PG_SCHEMA}.campaigns(id),
    stage INTEGER NOT NULL DEFAULT 0, conv_status TEXT NOT NULL DEFAULT 'none',
    ip TEXT DEFAULT '', ua TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (${NOW_PG}), updated_at TEXT NOT NULL DEFAULT (${NOW_PG})
  );
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.conversions (
    id BIGSERIAL PRIMARY KEY,
    click_id TEXT NOT NULL UNIQUE REFERENCES ${PG_SCHEMA}.clicks(click_id),
    status TEXT NOT NULL DEFAULT 'pending', txn_id TEXT DEFAULT '',
    user_reward_paise BIGINT NOT NULL DEFAULT 0,
    upstream_payout_paise BIGINT NOT NULL DEFAULT 0,
    pending_credited INTEGER NOT NULL DEFAULT 0, approved_credited INTEGER NOT NULL DEFAULT 0,
    referral_credited INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT DEFAULT '', expected_credit_date TEXT DEFAULT '',
    released INTEGER NOT NULL DEFAULT 0, released_at TEXT DEFAULT '',
    referral_amount_paise BIGINT NOT NULL DEFAULT 0, referral_released INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (${NOW_PG}), updated_at TEXT NOT NULL DEFAULT (${NOW_PG})
  );
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.wallet_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES ${PG_SCHEMA}.users(id), kind TEXT NOT NULL,
    amount_paise BIGINT NOT NULL, ref TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (${NOW_PG})
  );
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.postback_log (
    id BIGSERIAL PRIMARY KEY,
    received_at TEXT NOT NULL DEFAULT (${NOW_PG}), ip TEXT DEFAULT '',
    click_id TEXT DEFAULT '', event TEXT DEFAULT '', status TEXT DEFAULT '',
    accepted INTEGER NOT NULL DEFAULT 0, reason TEXT DEFAULT '', payload_json TEXT DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.withdrawals (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES ${PG_SCHEMA}.users(id), amount_paise BIGINT NOT NULL,
    method TEXT NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (${NOW_PG}),
    processed_at TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.claims (
    id BIGSERIAL PRIMARY KEY,
    click_id TEXT NOT NULL UNIQUE REFERENCES ${PG_SCHEMA}.clicks(click_id),
    user_id BIGINT NOT NULL REFERENCES ${PG_SCHEMA}.users(id),
    campaign_id BIGINT NOT NULL REFERENCES ${PG_SCHEMA}.campaigns(id),
    note TEXT DEFAULT '', proof_url TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT DEFAULT '',
    rolled_reward_paise BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (${NOW_PG}), processed_at TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.affiliates (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE REFERENCES ${PG_SCHEMA}.users(id),
    first_name TEXT NOT NULL DEFAULT '', surname TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', dob TEXT NOT NULL DEFAULT '',
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (${NOW_PG})
  );
  CREATE TABLE IF NOT EXISTS ${PG_SCHEMA}.affiliate_leads (
    id BIGSERIAL PRIMARY KEY,
    affiliate_id BIGINT NOT NULL REFERENCES ${PG_SCHEMA}.affiliates(id),
    campaign_id BIGINT NOT NULL REFERENCES ${PG_SCHEMA}.campaigns(id),
    visitor_name TEXT NOT NULL DEFAULT '', visitor_phone TEXT NOT NULL DEFAULT '',
    pay_method TEXT NOT NULL DEFAULT 'upi', upi_id TEXT DEFAULT '', upi_name TEXT DEFAULT '',
    bank_details TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'started',
    visitor_reward_paise BIGINT NOT NULL DEFAULT 0,
    affiliate_amount_paise BIGINT NOT NULL DEFAULT 0,
    affiliate_released INTEGER NOT NULL DEFAULT 0,
    visitor_paid INTEGER NOT NULL DEFAULT 0,
    ip TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (${NOW_PG}), completed_at TEXT DEFAULT ''
  );
`;

const SETTING_DEFAULTS = {
  referral_percent: '10', affiliate_percent: '10', min_withdrawal_paise: '5000', feed_url: '', site_name: 'CampaignWala',
  user_share_percent: '87.5', credit_days: '7', feeds_json: '', retention_days: '30',
  financial_retention_days: '60',
};

// Opens the right engine and ensures schema/tables/defaults exist.
// DATABASE_URL set -> Postgres (schema `campaign`); otherwise SQLite at dbPath.
export async function openDb(dbPath) {
  const url = process.env.DATABASE_URL;
  let db;
  if (url) {
    db = pgFacade(url);
    await db.exec(PG_DDL);
    // Additive migrations for PG databases created before these columns
    // existed (CREATE TABLE IF NOT EXISTS does not add columns).
    await db.exec(`ALTER TABLE ${PG_SCHEMA}.campaigns ADD COLUMN IF NOT EXISTS hide_from_list INTEGER NOT NULL DEFAULT 0`);
  } else {
    db = sqliteFacade(dbPath);
    await db.exec(SQLITE_DDL);
    // Additive V2 migrations for SQLite databases created by V1 (the pg DDL
    // above already carries the full V2 column set, so pg needs none).
    const addCol = async (table, col, def) => {
      const cols = (await db.all(`PRAGMA table_info(${table})`)).map(r => r.name);
      if (!cols.includes(col)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    };
    await addCol('users', 'approved_paise', 'INTEGER NOT NULL DEFAULT 0');
    for (const [col, def] of [
      ['campaign_type', "TEXT NOT NULL DEFAULT 'network'"],
      ['reward_mode', "TEXT NOT NULL DEFAULT 'fixed'"],
      ['reward_min_paise', 'INTEGER NOT NULL DEFAULT 0'],
      ['reward_max_paise', 'INTEGER NOT NULL DEFAULT 0'],
      ['reward_override', 'INTEGER NOT NULL DEFAULT 0'],
      ['link_url', "TEXT DEFAULT ''"],
      ['credit_days', 'INTEGER'],
      ['hide_from_list', 'INTEGER NOT NULL DEFAULT 0'],
    ]) await addCol('campaigns', col, def);
    for (const [col, def] of [
      ['upstream_payout_paise', 'INTEGER NOT NULL DEFAULT 0'],
      ['approved_at', "TEXT DEFAULT ''"],
      ['expected_credit_date', "TEXT DEFAULT ''"],
      ['released', 'INTEGER NOT NULL DEFAULT 0'],
      ['released_at', "TEXT DEFAULT ''"],
      ['referral_amount_paise', 'INTEGER NOT NULL DEFAULT 0'],
      ['referral_released', 'INTEGER NOT NULL DEFAULT 0'],
    ]) await addCol('conversions', col, def);
  }
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
    await db.run('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)', k, v);
  }
  return db;
}

export async function getSetting(db, key, fallback = '') {
  const row = await db.get('SELECT value FROM settings WHERE key=?', key);
  return row ? row.value : fallback;
}
export async function setSetting(db, key, value) {
  await db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}

// The ONLY shape of a campaign that may ever leave the server.
// Note: upstream payout, margin, reward_override, feed data and link_url for
// network campaigns are server-only. link_url is exposed ONLY for custom
// campaigns, where the link itself is the product (the owner's referral link).
export function publicCampaign(c) {
  const out = {
    id: c.id, title: c.title, description: c.description, category: c.category,
    geo: c.geo, icon_text: c.icon_text, user_reward_paise: c.user_reward_paise,
    campaign_type: c.campaign_type || 'network', reward_mode: c.reward_mode || 'fixed',
    steps: JSON.parse(c.steps_json || '[]'), rules: c.rules_text, is_live: !!c.is_live,
  };
  if (out.reward_mode === 'random') {
    out.reward_min_paise = c.reward_min_paise || 0;
    out.reward_max_paise = c.reward_max_paise || 0;
  }
  return out;
}

// Display string for a campaign reward (handles random range).
export function rewardLabel(c) {
  const inrFmt = (p) => '₹' + (Number(p || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  if ((c.reward_mode || 'fixed') === 'random') return `${inrFmt(c.reward_min_paise)}–${inrFmt(c.reward_max_paise)} (random)`;
  return inrFmt(c.user_reward_paise);
}

export async function seedDemo(db) {
  const row = await db.get('SELECT COUNT(*) AS n FROM campaigns');
  if (row.n > 0) return;
  const sql = `INSERT INTO campaigns
    (title,description,category,geo,icon_text,user_reward_paise,upstream_payout_paise,internal_notes,steps_json,rules_text,source,external_id,is_live)
    VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,1)`;
  // upstream_payout values + internal sentinel exist ONLY so the leak test can prove they never reach the frontend.
  const demo = [
    ['Demo Demat Account', 'Open a free demat account and complete KYC.', 'Finance', 'India', 'D', 25000, 123450, 'LEAK_SENTINEL_UPSTREAM_XYZ',
      JSON.stringify(['Click Start Campaign', 'Install the partner app from the official page', 'Register with your mobile number', 'Complete PAN + Aadhaar KYC', 'Wait for account approval']),
      'New users only. One account per person, per device. Duplicate or old users are rejected by the partner.', 'manual', 'demo-demat'],
    ['Demo Payments Bank', 'Open a payments bank account and add a small amount.', 'Finance', 'India', 'P', 12000, 987650, 'LEAK_SENTINEL_UPSTREAM_XYZ',
      JSON.stringify(['Click Start Campaign', 'Install the partner app', 'Register and open the account', 'Add ₹100 (fully usable by you)', 'Keep the account active']),
      'New users only. Added money stays in your own account. Partner approval is final.', 'manual', 'demo-bank'],
    ['Demo Shopping App', 'Install the app and place your first order.', 'Shopping', 'India', 'S', 8000, 555450, 'LEAK_SENTINEL_UPSTREAM_XYZ',
      JSON.stringify(['Click Start Campaign', 'Install the app', 'Register', 'Place your first order', 'Order must not be cancelled or returned']),
      'First order only. Cancelled or returned orders are rejected.', 'manual', 'demo-shop'],
  ];
  for (const d of demo) await db.run(sql, ...d);
}

// Admin bootstrap + ENV SYNC (V4): when ADMIN_EMAIL/ADMIN_PASSWORD are set,
// the env is the source of truth on every boot — the admin account is created
// if missing, and its password hash is updated whenever the env password
// differs from the stored one. So changing ADMIN_PASSWORD in the environment
// + restarting changes the admin password. (The admin can also change the
// password from the panel; note a later restart re-syncs it to the env value,
// so update the env too after a panel change.)
export async function ensureAdmin(db) {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const em = email.toLowerCase();
  const existing = await db.get('SELECT id, pass_hash FROM users WHERE email=?', em);
  if (existing) {
    await db.run('UPDATE users SET is_admin=1 WHERE id=?', existing.id);
    if (!verifyPassword(password, existing.pass_hash)) {
      await db.run('UPDATE users SET pass_hash=? WHERE id=?', hashPassword(password), existing.id);
    }
    return;
  }
  await db.run('INSERT INTO users(name,email,pass_hash,referral_code,is_admin) VALUES(?,?,?,?,1)',
    'Admin', em, hashPassword(password), randomCode(8));
}
