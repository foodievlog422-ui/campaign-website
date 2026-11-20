// Unit tests for the SQLite->Postgres SQL translator (src/db.js).
// No live Postgres needed: these pin the exact dialect conversions the pg
// facade relies on, using the real statements the codebase issues.
import { translatePgSql } from '../src/db.js';

const results = [];
let failures = 0;
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
  console.log(results[results.length - 1]);
}
const T = (sql) => translatePgSql(sql).text;

check('T1 placeholders -> $n + schema qualify',
  T('SELECT value FROM settings WHERE key=?') === 'SELECT value FROM campaign.settings WHERE key=$1');
const ins = translatePgSql('INSERT INTO users(name,email,phone,pass_hash,referral_code,referred_by) VALUES(?,?,?,?,?,?)');
check('T2 user INSERT gets RETURNING id + $1..$6',
  ins.returningId && ins.text.includes('INTO campaign.users') && ins.text.includes('VALUES($1,$2,$3,$4,$5,$6)') && ins.text.endsWith('RETURNING id'), ins.text);
const sess = translatePgSql('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)');
check('T3 sessions INSERT: NO returning (no serial id)', !sess.returningId && !/RETURNING/.test(sess.text) && sess.text.includes('campaign.sessions'));
const ign = translatePgSql('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
check('T4 INSERT OR IGNORE -> ON CONFLICT DO NOTHING, no RETURNING',
  ign.text === 'INSERT INTO campaign.settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING', ign.text);
const ups = translatePgSql('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
check('T5 settings upsert: excluded.* preserved, qualified, no RETURNING',
  ups.text.includes('campaign.settings') && ups.text.includes('value=excluded.value') && !/RETURNING/.test(ups.text));
const dt = T("UPDATE conversions SET released=1, released_at=datetime('now') WHERE click_id=?");
check("T6 datetime('now') -> to_char(now() AT TIME ZONE 'UTC',...)",
  dt.includes("to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')") && !dt.includes('datetime(') && dt.includes('campaign.conversions'));
const mx = T("UPDATE clicks SET stage=MAX(stage,1), updated_at=datetime('now') WHERE click_id=?");
check('T7 scalar MAX(stage,1) -> GREATEST(stage,1)',
  mx.includes('stage=GREATEST(stage,1)') && mx.includes('UPDATE campaign.clicks'), mx);
const imp = translatePgSql(`INSERT INTO campaigns (title,description) VALUES(?,?) ON CONFLICT(source,external_id) DO UPDATE SET title=excluded.title, is_live=1`);
check('T8 importer upsert: excluded.* + ON CONFLICT preserved, RETURNING id appended',
  imp.text.includes('campaign.campaigns') && imp.text.includes('title=excluded.title') && imp.text.endsWith('RETURNING id'), imp.text);
const join = T('SELECT cl.*, c.user_reward_paise, u.referred_by FROM clicks cl JOIN campaigns c ON c.id=cl.campaign_id JOIN users u ON u.id=cl.user_id WHERE cl.click_id=?');
check('T9 JOIN query: all three tables qualified, aliases intact',
  join.includes('FROM campaign.clicks cl') && join.includes('JOIN campaign.campaigns c') && join.includes('JOIN campaign.users u'), join);
const sum = T("SELECT COALESCE(SUM(upstream_payout_paise),0) v FROM conversions WHERE status='approved'");
check('T10 aggregate SUM untouched (no GREATEST), FROM qualified',
  sum.includes('SUM(upstream_payout_paise)') && !sum.includes('GREATEST') && sum.includes('FROM campaign.conversions'));
const del = T('DELETE FROM clicks WHERE updated_at<? AND NOT EXISTS (SELECT 1 FROM conversions WHERE conversions.click_id=clicks.click_id)');
check('T11 DELETE + NOT EXISTS subquery qualified, column refs untouched',
  del.includes('DELETE FROM campaign.clicks') && del.includes('FROM campaign.conversions') && del.includes('conversions.click_id=clicks.click_id'), del);
const samples = [
  'SELECT value FROM settings WHERE key=?',
  "UPDATE clicks SET stage=MAX(stage,5), conv_status='approved' WHERE click_id=?",
  'INSERT INTO wallet_ledger(user_id,kind,amount_paise,ref) VALUES(?,?,?,?)',
  "DELETE FROM withdrawals WHERE status IN ('paid','rejected') AND processed_at<?",
];
check('T12 no ? placeholder survives in any translated sample', samples.every(s => !T(s).includes('?')));

console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} translate checks passed`);
process.exit(failures ? 1 : 0);
