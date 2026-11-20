import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, randomCode } from './lib.js';

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
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
    is_live INTEGER NOT NULL DEFAULT 1,
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
  `);
  // Additive V2 migrations for databases created by V1.
  const addCol = (table, col, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addCol('users', 'approved_paise', 'INTEGER NOT NULL DEFAULT 0');
  for (const [col, def] of [
    ['campaign_type', "TEXT NOT NULL DEFAULT 'network'"],
    ['reward_mode', "TEXT NOT NULL DEFAULT 'fixed'"],
    ['reward_min_paise', 'INTEGER NOT NULL DEFAULT 0'],
    ['reward_max_paise', 'INTEGER NOT NULL DEFAULT 0'],
    ['reward_override', 'INTEGER NOT NULL DEFAULT 0'],
    ['link_url', "TEXT DEFAULT ''"],
    ['credit_days', 'INTEGER'],
  ]) addCol('campaigns', col, def);
  for (const [col, def] of [
    ['upstream_payout_paise', 'INTEGER NOT NULL DEFAULT 0'],
    ['approved_at', "TEXT DEFAULT ''"],
    ['expected_credit_date', "TEXT DEFAULT ''"],
    ['released', 'INTEGER NOT NULL DEFAULT 0'],
    ['released_at', "TEXT DEFAULT ''"],
    ['referral_amount_paise', 'INTEGER NOT NULL DEFAULT 0'],
    ['referral_released', 'INTEGER NOT NULL DEFAULT 0'],
  ]) addCol('conversions', col, def);
  const defaults = {
    referral_percent: '10', min_withdrawal_paise: '5000', feed_url: '', site_name: 'CampaignWala',
    user_share_percent: '87.5', credit_days: '7', feeds_json: '',
  };
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  for (const [k, v] of Object.entries(defaults)) ins.run(k, v);
  return db;
}

export function getSetting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
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

export function seedDemo(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM campaigns').get().n;
  if (count > 0) return;
  const ins = db.prepare(`INSERT INTO campaigns
    (title,description,category,geo,icon_text,user_reward_paise,upstream_payout_paise,internal_notes,steps_json,rules_text,source,external_id,is_live)
    VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,1)`);
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
  for (const d of demo) ins.run(...d);
}

export function ensureAdmin(db) {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
  if (existing) { db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(existing.id); return; }
  db.prepare('INSERT INTO users(name,email,pass_hash,referral_code,is_admin) VALUES(?,?,?,?,1)')
    .run('Admin', email.toLowerCase(), hashPassword(password), randomCode(8));
}
