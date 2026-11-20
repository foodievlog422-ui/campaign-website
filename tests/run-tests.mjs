// End-to-end tests for Campaign Website V1. Spawns the real server on a test
// port with a throwaway DB and SEED_DEMO=true, then drives it over HTTP.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = 3217;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'TESTSECRET_DO_NOT_LEAK_123';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
const results = [];
let failures = 0;
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
  console.log(results[results.length - 1]);
}

class Client {
  constructor() { this.cookies = new Map(); this.lastSetCookie = ''; }
  async req(method, url, body) {
    const headers = {};
    if (this.cookies.size) headers.cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const r = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) {
      this.lastSetCookie = sc;
      for (const part of sc.split(/,(?=[^;]+?=)/)) {
        const m = part.trim().match(/^([^=]+)=([^;]*)/);
        if (m) { if (m[2]) this.cookies.set(m[1], m[2]); else this.cookies.delete(m[1]); }
      }
    }
    return { status: r.status, headers: r.headers, text: await r.text() };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
}

async function postback(params, secret = SECRET) {
  const r = await fetch(BASE + '/api/postback', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-postback-secret': secret },
    body: JSON.stringify(params),
  });
  return { status: r.status, json: await r.json() };
}
const money = (html, label) => {
  const escRe = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = html.match(new RegExp(escRe + ': <b>([^<]+)</b>'));
  return m ? m[1] : null;
};

const env = { ...process.env, PORT: String(PORT), DB_PATH: path.join(tmp, 'app.db'), SEED_DEMO: 'true', POSTBACK_SECRET: SECRET, ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'adminpass123', NODE_ENV: 'production' };
const server = spawn('node', ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
try {
  // wait for health
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { const r = await fetch(BASE + '/health'); up = r.ok; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  if (!up) throw new Error('server did not start');

  // 1. Home + campaigns list
  const anon = new Client();
  const home = await anon.get('/');
  check('1a server starts, home loads', home.status === 200);
  check('1b campaigns list renders seeded demos', home.text.includes('Demo Demat Account') && home.text.includes('Demo Payments Bank'));
  const api = await (await fetch(BASE + '/api/campaigns')).json();
  check('1c public API lists 3 campaigns', api.campaigns.length === 3, `got ${api.campaigns.length}`);

  // 2. Signup / login / remember-me
  const referrer = new Client();
  const su = await referrer.post('/signup', { name: 'Ref One', email: 'ref@test.local', password: 'password123', remember: '1' });
  check('2a signup redirects to dashboard', su.status === 302 && su.headers.get('location') === '/my');
  check('2b remember-me cookie is httpOnly + 30d', /HttpOnly/i.test(referrer.lastSetCookie) && /Max-Age=2592000/.test(referrer.lastSetCookie), referrer.lastSetCookie);
  const refDash = await referrer.get('/my');
  const refCode = (refDash.text.match(/\/r\/([A-Z0-9]+)/) || [])[1];
  check('2c referral code issued', !!refCode, refCode || 'none');
  const user = new Client();
  await user.post('/signup', { name: 'User Two', email: 'user@test.local', password: 'password123', ref: refCode || '', remember: '1' });
  await user.post('/logout');
  const li = await user.post('/login', { email: 'user@test.local', password: 'password123', remember: '1' });
  check('2d login works + remember cookie again', li.status === 302 && /HttpOnly/i.test(user.lastSetCookie) && /Max-Age=2592000/.test(user.lastSetCookie));

  // 3. Start campaign -> click + progress
  const start = await user.post('/campaign/1/start');
  const loc = start.headers.get('location') || '';
  const clickId = loc.split('/').pop();
  check('3a start creates click_id + redirect to progress', start.status === 302 && clickId.startsWith('clk_'), clickId);
  const prog = await user.get(loc);
  check('3b progress page shows timeline, first step done', prog.status === 200 && prog.text.includes('Clicked') && prog.text.includes('Wallet Credited'));
  const progApi = await (await fetch(BASE + '/api/my/progress/' + clickId, { headers: { cookie: [...user.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } })).json();
  check('3c progress API stage=0 (Clicked)', progApi.stage === 0 && progApi.stage_label === 'Clicked');

  // 5a (run early). Wrong secret -> rejected, no credit
  const bad = await postback({ click_id: clickId, status: 'pending', txn_id: 'T1' }, 'WRONG_SECRET');
  const dashAfterBad = await user.get('/my');
  check('5a wrong-secret postback rejected (401), no credit', bad.status === 401 && money(dashAfterBad.text, 'Pending') === '₹0', JSON.stringify(bad.json));

  // 4. Postback flow: pending -> duplicate -> event -> approved -> duplicate
  const p1 = await postback({ click_id: clickId, status: 'pending', txn_id: 'T1', event: 'tracking' });
  const dash1 = await user.get('/my');
  check('4a pending postback credits PENDING wallet ₹250', p1.status === 200 && money(dash1.text, 'Pending') === '₹250', JSON.stringify(p1.json));
  const p1dup = await postback({ click_id: clickId, status: 'pending', txn_id: 'T1', event: 'tracking' });
  const dash1b = await user.get('/my');
  check('5b duplicate pending postback idempotent (still ₹250)', p1dup.status === 200 && money(dash1b.text, 'Pending') === '₹250');
  const ev = await postback({ click_id: clickId, event: 'installed' });
  const prog2 = await (await fetch(BASE + '/api/my/progress/' + clickId, { headers: { cookie: [...user.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } })).json();
  check('4b install event advances progress to Installed', ev.status === 200 && prog2.stage === 2, `stage=${prog2.stage}`);
  const ap = await postback({ click_id: clickId, status: 'approved', txn_id: 'T1' });
  const dash2 = await user.get('/my');
  check('4c V2: approval moves ₹250 pending -> Approved (release pending), NOT withdrawable', ap.status === 200 && money(dash2.text, 'Pending') === '₹0' && money(dash2.text, 'Approved (release pending)') === '₹250' && money(dash2.text, 'Withdrawable') === '₹0');
  const progApproved = await user.get(loc);
  const progApiAp = await (await fetch(BASE + '/api/my/progress/' + clickId, { headers: { cookie: [...user.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } })).json();
  check('4c2 V2: stage=Approved (5) + expected credit date shown (approval + 7 days)', progApiAp.stage === 5 && progApproved.text.includes('Expected wallet credit date') && !!progApiAp.expected_credit_date, progApiAp.expected_credit_date || 'none');
  const refDash2 = await referrer.get('/my');
  check('4d V2: referral commission 10% = ₹25 held in referrer Approved bucket (not withdrawable yet)', money(refDash2.text, 'Approved (release pending)') === '₹25' && money(refDash2.text, 'Withdrawable') === '₹0');
  // Admin manually releases -> only now money becomes withdrawable.
  const adminR = new Client();
  await adminR.post('/login', { email: 'admin@test.local', password: 'adminpass123' });
  const relPage = await adminR.get('/admin/releases');
  check('4f1 V2: admin releases page lists the approved conversion', relPage.text.includes('Demo Demat Account') && relPage.text.includes(`/admin/releases/${clickId}`));
  await adminR.post(`/admin/releases/${clickId}`);
  const dash3 = await user.get('/my');
  const refDash3 = await referrer.get('/my');
  check('4f2 V2: after admin release ₹250 withdrawable + referral ₹25 paid to referrer', money(dash3.text, 'Withdrawable') === '₹250' && money(dash3.text, 'Approved (release pending)') === '₹0' && money(refDash3.text, 'Withdrawable') === '₹25');
  const apDup = await postback({ click_id: clickId, status: 'approved', txn_id: 'T1' });
  const dash4 = await user.get('/my');
  const refDash4 = await referrer.get('/my');
  check('5c duplicate approved postback idempotent (no double credit)', apDup.status === 200 && money(dash4.text, 'Withdrawable') === '₹250' && money(refDash4.text, 'Withdrawable') === '₹25');
  const progFinal = await user.get(loc);
  check('4e progress timeline reaches Wallet Credited after release', progFinal.text.includes('Wallet Credited') && (progFinal.text.match(/done/g) || []).length >= 7);

  // 6. Leak test over every public surface
  const publicPages = ['/', '/api/campaigns', '/api/campaigns/1', '/campaign/1', '/campaign/2', '/campaign/3', '/privacy', '/terms', '/refund-policy', '/login', '/signup', '/style.css', '/app.js'];
  let blob = '';
  for (const u of publicPages) blob += (await (await fetch(BASE + u)).text()) + '\n';
  const leaks = [SECRET, 'LEAK_SENTINEL_UPSTREAM_XYZ', 'upstream_payout', 'upstreamPayout', '123450', '987650', '555450', '1234.5'];
  const found = leaks.filter(s => blob.includes(s));
  check('6 leak test: no secret / upstream payout / sentinel in public pages+API', found.length === 0, found.length ? 'FOUND: ' + found.join(',') : 'clean');

  // 7. Withdrawal -> admin approve
  const wd = await user.post('/wallet/withdraw', { amount: '250', method: 'upi', destination: 'user@okupi' });
  check('7a withdrawal request accepted', wd.status === 302);
  const wallet1 = await user.get('/wallet');
  check('7b withdrawal shows pending, balance held', wallet1.text.includes('Status: pending') && money(wallet1.text, 'Withdrawable balance') === '₹0');
  const admin = new Client();
  await admin.post('/login', { email: 'admin@test.local', password: 'adminpass123' });
  const adminWd = await admin.get('/admin/withdrawals');
  const wdId = (adminWd.text.match(/\/admin\/withdrawals\/(\d+)\/approve/) || [])[1];
  check('7c admin sees pending withdrawal', !!wdId);
  await admin.post(`/admin/withdrawals/${wdId}/approve`);
  const wallet2 = await user.get('/wallet');
  check('7d admin approval marks withdrawal paid', wallet2.text.includes('Status: paid'));
  const adminConv = await admin.get('/admin/conversions');
  check('7e admin postback log records accepted + rejected calls', adminConv.text.includes('ACCEPTED') && adminConv.text.includes('REJECTED'));

  // ---------- V2 tests ----------
  const userCookie = () => [...user.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const progOf = async (cid) => (await fetch(BASE + '/api/my/progress/' + cid, { headers: { cookie: userCookie() } })).json();
  const rupee = (s) => Number(String(s || '').replace(/[₹,]/g, ''));

  // 8a. App tracking: install -> register -> kyc purely via postbacks (MMP-style events)
  const start2 = await user.post('/campaign/2/start');
  const click2 = (start2.headers.get('location') || '').split('/').pop();
  await postback({ click_id: click2, event: 'install' });
  check('8a1 app install event -> stage Installed', (await progOf(click2)).stage === 2);
  await postback({ click_id: click2, event: 'register' });
  check('8a2 app register event -> stage Registered', (await progOf(click2)).stage === 3);
  await postback({ click_id: click2, event: 'kyc' });
  check('8a3 app kyc event -> stage KYC Done (pure postback sequence)', (await progOf(click2)).stage === 4);

  // 8b. Multi-feed import + auto pricing (upstream ₹400 x 87.5% share = user ₹350) + auto-hide + token leak
  let feedItems = [{ external_id: 'net-400', title: 'Feed Demat Pro', description: 'Feed wala demat.', category: 'Finance', geo: 'India', icon_text: 'F', upstream_payout_paise: 40000, steps: ['Install', 'KYC'], rules: 'New users only' }];
  const feedSrv = http.createServer((rq, rs) => { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ campaigns: feedItems })); });
  await new Promise(r => feedSrv.listen(3218, r));
  await admin.post('/admin/feeds/add', { name: 'TestNet', url: 'http://127.0.0.1:3218/feed', token: 'FEEDTOKEN_SECRET_XYZ' });
  const imp1 = await admin.post('/admin/import');
  const apiAfter = await (await fetch(BASE + '/api/campaigns')).json();
  const feedCamp = apiAfter.campaigns.find(c => c.title === 'Feed Demat Pro');
  check('8b1 feed import creates campaign, auto price = floor(40000 x 87.5%) = 35000 paise', imp1.status === 200 && !!feedCamp && feedCamp.user_reward_paise === 35000, feedCamp ? `reward=${feedCamp.user_reward_paise}` : 'not found');
  let pubBlob = (await (await fetch(BASE + '/')).text()) + (await (await fetch(BASE + '/api/campaigns')).text());
  check('8b2 leak: feed token / upstream payout / margin fields not public', !pubBlob.includes('FEEDTOKEN_SECRET_XYZ') && !pubBlob.includes('40000') && !pubBlob.includes('upstream') && !pubBlob.includes('margin'));
  const settingsPage = await admin.get('/admin/settings');
  check('8b3 settings show multi-feed list + user share % + credit days', settingsPage.text.includes('TestNet') && settingsPage.text.includes('user_share_percent') && settingsPage.text.includes('credit_days'));
  feedItems = [];
  await admin.post('/admin/import');
  const apiAfter2 = await (await fetch(BASE + '/api/campaigns')).json();
  check('8b4 offer removed from feed -> auto-hidden from public list', !apiAfter2.campaigns.some(c => c.title === 'Feed Demat Pro'));
  feedSrv.close();

  // 8c. Custom (referral-link) campaign: random reward 100-150, claim -> approve -> release
  await admin.post('/admin/campaigns/new', { title: 'Custom Refer Earn', description: 'Mera referral link wala campaign.', category: 'Apps', geo: 'India', icon_text: 'R', campaign_type: 'custom', reward_mode: 'random', reward_min: '100', reward_max: '150', user_reward: '', link_url: 'https://example.com/myref', steps: 'Link kholo\nAccount banao', rules_text: 'New users only', is_live: '1' });
  const apiC = await (await fetch(BASE + '/api/campaigns')).json();
  const custom = apiC.campaigns.find(c => c.title === 'Custom Refer Earn');
  check('8c1 custom campaign live with random range exposed (10000-15000 paise)', !!custom && custom.campaign_type === 'custom' && custom.reward_min_paise === 10000 && custom.reward_max_paise === 15000);
  const startC = await user.post(`/campaign/${custom.id}/start`);
  const clickC = (startC.headers.get('location') || '').split('/').pop();
  const progC = await user.get(`/my/campaigns/${clickC}`);
  check('8c2 progress page shows claim form + campaign link', progC.text.includes('Claim Submit Karo') && progC.text.includes(`/go/${clickC}`));
  await user.post(`/my/campaigns/${clickC}/claim`, { note: 'Account khola, ID user123', proof_url: 'https://example.com/proof' });
  const claimsPage = await admin.get('/admin/claims');
  const claimId = (claimsPage.text.match(/\/admin\/claims\/(\d+)\/approve/) || [])[1];
  check('8c3 admin sees submitted claim with note', !!claimId && claimsPage.text.includes('Account khola, ID user123'));
  await admin.post(`/admin/claims/${claimId}/approve`);
  const progC2 = await user.get(`/my/campaigns/${clickC}`);
  const rolled = rupee((progC2.text.match(/Claim approved — reward: <b>([^<]+)<\/b>/) || [])[1]);
  const dashC = await user.get('/my');
  check('8c4 claim approve rolls random reward (100-150) into Approved bucket', rolled >= 100 && rolled <= 150 && rupee(money(dashC.text, 'Approved (release pending)')) === rolled, `rolled=${rolled}`);
  await admin.post(`/admin/releases/${clickC}`);
  const dashC2 = await user.get('/my');
  check('8c5 release moves rolled reward to withdrawable', rupee(money(dashC2.text, 'Withdrawable')) === rolled, `withdrawable=${money(dashC2.text, 'Withdrawable')}`);
  // claim reject path with user-visible reason
  const startC2 = await user.post(`/campaign/${custom.id}/start`);
  const clickC2 = (startC2.headers.get('location') || '').split('/').pop();
  await user.post(`/my/campaigns/${clickC2}/claim`, { note: 'Done sir', proof_url: '' });
  const claims2 = await admin.get('/admin/claims');
  const claimId2 = (claims2.text.match(/\/admin\/claims\/(\d+)\/approve/) || [])[1];
  await admin.post(`/admin/claims/${claimId2}/reject`, { reason: 'Screenshot clear nahi hai' });
  const progC3 = await user.get(`/my/campaigns/${clickC2}`);
  check('8c6 claim reject reason visible to user', progC3.text.includes('Screenshot clear nahi hai'));

  // 8d. Earnings page: admin-only, margin math present
  const earn = await admin.get('/admin/earnings');
  check('8d1 admin earnings page shows upstream total + margin', earn.status === 200 && earn.text.includes('Total upstream payout') && earn.text.includes('Admin margin'));
  const earnAnon = await anon.get('/admin/earnings');
  check('8d2 earnings page not accessible without admin login', earnAnon.status === 302);

  // ---------- V2.1 tests: admin campaign list shows payout / reward / margin ----------
  const adminCamps = await admin.get('/admin/campaigns');
  check('8e1 admin campaign list shows Company payout for seeded campaign (123450 paise = ₹1,234.5)', adminCamps.text.includes('Company payout:') && adminCamps.text.includes('₹1,234.5'));
  check('8e2 admin list margin = payout - user reward (123450 - 25000 = ₹984.5)', adminCamps.text.includes('Margin:') && adminCamps.text.includes('₹984.5') && adminCamps.text.includes('User reward:'));
  const pubBlob2 = (await (await fetch(BASE + '/')).text()) + '\n' + JSON.stringify(await (await fetch(BASE + '/api/campaigns')).json());
  check('8e3 public home + API still contain NO payout/margin values or labels', !pubBlob2.includes('₹1,234.5') && !pubBlob2.includes('₹984.5') && !pubBlob2.includes('123450') && !pubBlob2.includes('98450') && !pubBlob2.includes('Company payout'));
  const custIdx = adminCamps.text.indexOf('Custom Refer Earn');
  const custSeg = custIdx >= 0 ? adminCamps.text.slice(custIdx, custIdx + 700) : '';
  check('8e4 custom campaign (no upstream payout) shows payout + margin as — in admin list', custSeg.includes('Company payout: <b>—</b>') && custSeg.includes('Margin: <b>—</b>'), custSeg ? '' : 'custom card not found');

  console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed`);
} catch (err) {
  console.error('TEST RUN ERROR', err);
  failures++;
} finally {
  server.kill('SIGTERM');
  fs.writeFileSync(new URL('./last-run.txt', import.meta.url), results.join('\n') + `\n${failures === 0 ? 'ALL PASS' : 'FAILURES: ' + failures}\n`);
}
process.exit(failures ? 1 : 0);
