// Retention tests (V3): facade-level, throwaway SQLite DB.
// Tier 1 (30d): raw tracking purge. Tier 2 (60d): financial records purge
// ONLY after full closure, and NEVER for accounts with money/open states.
delete process.env.DATABASE_URL; // force SQLite for this test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { runRetention } from '../src/retention.js';

const results = [];
let failures = 0;
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
  console.log(results[results.length - 1]);
}
const ts = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 19).replace('T', ' ');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ret-'));
const db = await openDb(path.join(tmp, 'app.db'));

async function mkUser(email, { pending = 0, approved = 0, withdrawable = 0 } = {}) {
  const r = await db.run('INSERT INTO users(name,email,pass_hash,referral_code,pending_paise,approved_paise,withdrawable_paise) VALUES(?,?,?,?,?,?,?)',
    email, email, 'x', 'REF' + Math.random().toString(36).slice(2, 8).toUpperCase(), pending, approved, withdrawable);
  return Number(r.lastInsertRowid);
}
const camp = await db.run("INSERT INTO campaigns(title,source,external_id) VALUES('C1','manual','ret-1')");
const campId = Number(camp.lastInsertRowid);
async function mkClick(userId, clickId, convStatus, daysAgo, { ip = '1.2.3.4', ua = 'UA-old' } = {}) {
  await db.run('INSERT INTO clicks(click_id,user_id,campaign_id,stage,conv_status,ip,ua,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    clickId, userId, campId, 0, convStatus, ip, ua, ts(daysAgo), ts(daysAgo));
}
async function mkLedger(userId, kind, amount, ref, daysAgo) {
  await db.run('INSERT INTO wallet_ledger(user_id,kind,amount_paise,ref,created_at) VALUES(?,?,?,?,?)',
    userId, kind, amount, ref, ts(daysAgo));
}

// ---------- Tier 1 seeds ----------
// u1: zero balances everywhere.
const u1 = await mkUser('u1@test.local');
await mkClick(u1, 'clk_old_rejected', 'rejected', 31);            // terminal, no conv -> DELETE
await mkClick(u1, 'clk_fresh_rejected', 'rejected', 1);           // fresh -> keep
await mkClick(u1, 'clk_old_approved', 'approved', 31);            // has conversion -> keep, strip ip/ua
await db.run("INSERT INTO conversions(click_id,status,user_reward_paise,released,released_at,created_at,updated_at) VALUES('clk_old_approved','approved',1000,1,?,?,?)", ts(31), ts(31), ts(31));
await db.run("INSERT INTO postback_log(received_at,click_id,accepted) VALUES(?,'clk_old_rejected',1)", ts(31));
await db.run("INSERT INTO postback_log(received_at,click_id,accepted) VALUES(?,'clk_fresh_rejected',1)", ts(1));
await db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', 'expiredhash', u1, Date.now() - 1000);
await db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', 'validhash', u1, Date.now() + 864e5);

// ---------- Tier 2 seeds ----------
// u2: FULLY CLOSED 61 days ago, zero balances -> conversion + withdrawal + ledger PURGED.
const u2 = await mkUser('u2@test.local');
await mkClick(u2, 'clk_closed', 'approved', 61, { ip: '', ua: '' });
await db.run("INSERT INTO conversions(click_id,status,user_reward_paise,released,released_at,created_at,updated_at) VALUES('clk_closed','approved',2000,1,?,?,?)", ts(61), ts(61), ts(61));
await db.run("INSERT INTO withdrawals(user_id,amount_paise,method,destination,status,created_at,processed_at) VALUES(?,2000,'upi','u2@ok','paid',?,?)", u2, ts(61), ts(61));
await mkLedger(u2, 'wallet_release', 2000, 'clk_closed', 61);
await mkLedger(u2, 'withdrawal_hold', -2000, 'wd_1', 61);

// u3: same age, but NON-ZERO balance (₹50 withdrawable) -> NOTHING financial purged.
const u3 = await mkUser('u3@test.local', { withdrawable: 5000 });
await mkClick(u3, 'clk_rich', 'approved', 61, { ip: '', ua: '' });
await db.run("INSERT INTO conversions(click_id,status,user_reward_paise,released,released_at,created_at,updated_at) VALUES('clk_rich','approved',2000,1,?,?,?)", ts(61), ts(61), ts(61));
await db.run("INSERT INTO withdrawals(user_id,amount_paise,method,destination,status,created_at,processed_at) VALUES(?,2000,'upi','u3@ok','paid',?,?)", u3, ts(61), ts(61));
await mkLedger(u3, 'wallet_release', 2000, 'clk_rich', 61);

// u4: zero balances, but OPEN states (pending conversion + approved-unreleased) -> financial records survive.
const u4 = await mkUser('u4@test.local');
await mkClick(u4, 'clk_pending', 'pending', 61, { ip: '', ua: '' });
await db.run("INSERT INTO conversions(click_id,status,user_reward_paise,created_at,updated_at) VALUES('clk_pending','pending',3000,?,?)", ts(61), ts(61));
await mkClick(u4, 'clk_unreleased', 'approved', 61, { ip: '', ua: '' });
await db.run("INSERT INTO conversions(click_id,status,user_reward_paise,released,created_at,updated_at) VALUES('clk_unreleased','approved',3000,0,?,?)", ts(61), ts(61));
await mkLedger(u4, 'pending_credit', 3000, 'clk_pending', 61);

// u2/u3/u4 clicks are old but carry conversions, so Tier 1 must keep them too.

const report = await runRetention(db);
console.log('report:', JSON.stringify(report));

// ---------- Tier 1 assertions ----------
const click = async (id) => db.get('SELECT * FROM clicks WHERE click_id=?', id);
check('R1 old terminal click (31d, no conversion) deleted', !(await click('clk_old_rejected')));
check('R2 fresh terminal click (1d) kept', !!(await click('clk_fresh_rejected')));
const keptApproved = await click('clk_old_approved');
check('R3 old click WITH conversion kept, IP/UA stripped', !!keptApproved && keptApproved.ip === '' && keptApproved.ua === '');
const logs = await db.all('SELECT * FROM postback_log');
check('R4 postback log: 31d-old deleted, fresh kept', logs.length === 1 && logs[0].click_id === 'clk_fresh_rejected', `remaining=${logs.length}`);
const sess = await db.all('SELECT token_hash FROM sessions');
check('R5 expired session deleted, valid session kept', sess.length === 1 && sess[0].token_hash === 'validhash');

// ---------- Tier 2 assertions ----------
check('F1 closed 61d conversion purged (zero-balance account)', !(await db.get("SELECT id FROM conversions WHERE click_id='clk_closed'")));
check('F2 closed 61d paid withdrawal purged', (await db.get('SELECT COUNT(*) AS n FROM withdrawals WHERE user_id=?', u2)).n === 0);
check('F3 closed 61d wallet ledger purged', (await db.get('SELECT COUNT(*) AS n FROM wallet_ledger WHERE user_id=?', u2)).n === 0);
check('F4 non-zero-balance account: old conversion SURVIVES', !!(await db.get("SELECT id FROM conversions WHERE click_id='clk_rich'")));
check('F5 non-zero-balance account: old withdrawal + ledger SURVIVE',
  (await db.get('SELECT COUNT(*) AS n FROM withdrawals WHERE user_id=?', u3)).n === 1 &&
  (await db.get('SELECT COUNT(*) AS n FROM wallet_ledger WHERE user_id=?', u3)).n === 1);
check('F6 open states survive: pending + approved-unreleased conversions kept',
  !!(await db.get("SELECT id FROM conversions WHERE click_id='clk_pending'")) &&
  !!(await db.get("SELECT id FROM conversions WHERE click_id='clk_unreleased'")));
check('F7 open-state account: old ledger SURVIVES', (await db.get('SELECT COUNT(*) AS n FROM wallet_ledger WHERE user_id=?', u4)).n === 1);
check('F8 u1 released conversion is only 31d closed (< 60) -> kept', !!(await db.get("SELECT id FROM conversions WHERE click_id='clk_old_approved'")));
const u3row = await db.get('SELECT * FROM users WHERE id=?', u3);
check('F9 user accounts + balances never touched', !!u3row && u3row.withdrawable_paise === 5000 && !!(await db.get('SELECT id FROM users WHERE id=?', u2)));
check('F10 report counts financial purges (1 conv / 1 wd / 2 ledger)',
  report.conversions_purged === 1 && report.withdrawals_purged === 1 && report.wallet_ledger_purged === 2, JSON.stringify(report));

await db.close();
console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} retention checks passed`);
process.exit(failures ? 1 : 0);
