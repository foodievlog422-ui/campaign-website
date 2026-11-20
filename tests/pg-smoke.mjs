// Postgres-mode smoke test. SKIPPED gracefully when TEST_DATABASE_URL is not
// set — the live run happens at deploy verification against the real Supabase
// pooler. When set, it boots the real facade (openDb) against that database:
// schema + tables are created in the `campaign` schema, a settings roundtrip
// and a user insert (RETURNING id path) are exercised, then cleaned up.
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('SKIP  pg-smoke: TEST_DATABASE_URL not set (live Postgres verification happens at deploy time)');
  process.exit(0);
}
process.env.DATABASE_URL = url;
const { openDb, getSetting, setSetting } = await import('../src/db.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};
const db = await openDb('ignored-in-pg-mode.db');
try {
  check('P1 facade is in pg mode', db.mode === 'pg');
  const t = await db.get("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema='campaign'");
  check('P2 campaign schema holds all 10 app tables', t.n >= 10, `tables=${t.n}`);
  const other = await db.get("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema='campaign' AND table_name='users'");
  check('P3 users table is schema-qualified (campaign.users)', other.n === 1);
  await setSetting(db, 'smoke_key', 'smoke-42');
  check('P4 settings upsert + read roundtrip', (await getSetting(db, 'smoke_key')) === 'smoke-42');
  const ins = await db.run('INSERT INTO users(name,email,pass_hash,referral_code) VALUES(?,?,?,?)',
    'Smoke', `smoke-${Date.now()}@test.local`, 'x', 'SMK' + Date.now());
  check('P5 user INSERT returns numeric id (RETURNING path)', Number.isFinite(Number(ins.lastInsertRowid)) && Number(ins.lastInsertRowid) > 0, `id=${ins.lastInsertRowid}`);
  await db.run('DELETE FROM users WHERE id=?', Number(ins.lastInsertRowid));
  await db.run('DELETE FROM settings WHERE key=?', 'smoke_key');
  check('P6 cleanup done', true);
} finally {
  await db.close();
}
process.exit(failures ? 1 : 0);
