import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, esc, inr, hashPassword, verifyPassword, sha256, randomToken, randomCode, safeEqual, parseCookies, cookieHeader, readBody, parseSteps } from './lib.js';
import { openDb, getSetting, setSetting, publicCampaign, rewardLabel, seedDemo, ensureAdmin } from './db.js';
import { importAllFeeds, getFeeds, saveFeeds, reconcilePending } from './importer.js';
import { runRetention } from './retention.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(ROOT);
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'app.db');
const db = await openDb(DB_PATH);
if (process.env.SEED_DEMO === 'true') await seedDemo(db);
await ensureAdmin(db);

export const STAGES = ['Clicked', 'Tracking Started', 'Installed', 'Registered', 'KYC / Event Done', 'Approved', 'Wallet Credited'];
const postbackSecret = async () => process.env.POSTBACK_SECRET || await getSetting(db, 'postback_secret', '');

// Expected wallet credit date = approval date + credit days
// (per-campaign override wins over the global setting). Returns 'YYYY-MM-DD'.
export async function expectedCreditDate(campaignCreditDays) {
  const days = campaignCreditDays != null && campaignCreditDays !== ''
    ? Number(campaignCreditDays)
    : Number(await getSetting(db, 'credit_days', '7')) || 0;
  const d = new Date(Date.now() + days * 864e5);
  return d.toISOString().slice(0, 10);
}
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

// Moves an APPROVED conversion's money into the "Approved — release pending"
// bucket (user.approved_paise) and holds the referral commission the same way.
// Nothing becomes withdrawable here — only await releaseConversion() does that.
// Shared by the postback path and manual claim approvals. Idempotent via
// conversions.approved_credited.
export async function holdApproval(click, conv, reward, { fromPending = false } = {}) {
  if (fromPending) {
    await db.prepare('UPDATE users SET pending_paise=pending_paise-?, approved_paise=approved_paise+? WHERE id=?').run(reward, reward, click.user_id);
  } else {
    await db.prepare('UPDATE users SET approved_paise=approved_paise+? WHERE id=?').run(reward, click.user_id);
  }
  await db.prepare('INSERT INTO wallet_ledger(user_id,kind,amount_paise,ref) VALUES(?,?,?,?)').run(click.user_id, 'approved_pending_release', reward, click.click_id);
  let referralAmount = conv.referral_amount_paise || 0;
  if (click.referred_by && !conv.referral_credited) {
    const pct = Number(await getSetting(db, 'referral_percent', '10')) || 0;
    referralAmount = Math.floor(reward * pct / 100);
    if (referralAmount > 0) {
      await db.prepare('UPDATE users SET approved_paise=approved_paise+? WHERE id=?').run(referralAmount, click.referred_by);
      await db.prepare('INSERT INTO wallet_ledger(user_id,kind,amount_paise,ref) VALUES(?,?,?,?)').run(click.referred_by, 'referral_pending_release', referralAmount, click.click_id);
    }
  }
  await db.prepare(`UPDATE conversions SET status='approved', approved_credited=1, referral_credited=1,
    referral_amount_paise=?, user_reward_paise=?, approved_at=datetime('now'), expected_credit_date=?, updated_at=datetime('now')
    WHERE click_id=?`).run(referralAmount, reward, await expectedCreditDate(click.credit_days), click.click_id);
}

// Admin manual release: APPROVED money (user reward + referral commission)
// becomes WITHDRAWABLE. This is the ONLY path to "Wallet Credited" (stage 6).
export async function releaseConversion(clickId) {
  const conv = await db.prepare('SELECT * FROM conversions WHERE click_id=?').get(clickId);
  if (!conv) return { ok: false, reason: 'no_conversion' };
  if (conv.status !== 'approved') return { ok: false, reason: 'not_approved' };
  if (conv.released) return { ok: true, reason: 'already_released', idempotent: true };
  const click = await db.prepare('SELECT cl.*, u.referred_by FROM clicks cl JOIN users u ON u.id=cl.user_id WHERE cl.click_id=?').get(clickId);
  const reward = conv.user_reward_paise;
  await db.prepare('UPDATE users SET approved_paise=approved_paise-?, withdrawable_paise=withdrawable_paise+? WHERE id=?').run(reward, reward, click.user_id);
  await db.prepare('INSERT INTO wallet_ledger(user_id,kind,amount_paise,ref) VALUES(?,?,?,?)').run(click.user_id, 'wallet_release', reward, clickId);
  if (click.referred_by && conv.referral_amount_paise > 0 && !conv.referral_released) {
    await db.prepare('UPDATE users SET approved_paise=approved_paise-?, withdrawable_paise=withdrawable_paise+? WHERE id=?').run(conv.referral_amount_paise, conv.referral_amount_paise, click.referred_by);
    await db.prepare('INSERT INTO wallet_ledger(user_id,kind,amount_paise,ref) VALUES(?,?,?,?)').run(click.referred_by, 'referral_credit', conv.referral_amount_paise, clickId);
    await db.prepare('UPDATE conversions SET referral_released=1 WHERE click_id=?').run(clickId);
  }
  await db.prepare("UPDATE conversions SET released=1, released_at=datetime('now'), updated_at=datetime('now') WHERE click_id=?").run(clickId);
  await db.prepare("UPDATE clicks SET stage=6, updated_at=datetime('now') WHERE click_id=?").run(clickId);
  return { ok: true, reason: 'released' };
}

// ---------- postback core (also reused by reconciliation) ----------
export async function applyPostback({ click_id, event = '', status = '', txn_id = '' }) {
  const click = await db.prepare('SELECT cl.*, c.user_reward_paise, c.upstream_payout_paise, c.credit_days, u.referred_by FROM clicks cl JOIN campaigns c ON c.id=cl.campaign_id JOIN users u ON u.id=cl.user_id WHERE cl.click_id=?').get(click_id);
  if (!click) return { accepted: false, reason: 'unknown_click_id' };
  const reward = click.user_reward_paise;
  let conv = await db.prepare('SELECT * FROM conversions WHERE click_id=?').get(click_id);
  const ensureConv = async () => {
    if (!conv) {
      await db.prepare('INSERT INTO conversions(click_id,status,txn_id,user_reward_paise,upstream_payout_paise) VALUES(?,?,?,?,?)').run(click_id, 'pending', txn_id || '', reward, click.upstream_payout_paise || 0);
      conv = await db.prepare('SELECT * FROM conversions WHERE click_id=?').get(click_id);
    }
    return conv;
  };
  let stage = click.stage;
  const ev = String(event).toLowerCase();
  if (ev === 'tracking' || ev === 'tracked') stage = Math.max(stage, 1);
  if (ev === 'installed' || ev === 'install') stage = Math.max(stage, 2);
  if (ev === 'registered' || ev === 'register' || ev === 'signup') stage = Math.max(stage, 3);
  if (ev === 'kyc' || ev === 'event' || ev === 'event_done' || ev === 'qualified') stage = Math.max(stage, 4);

  const st = String(status).toLowerCase();
  let result = 'stage_updated';
  if (st === 'pending') {
    await ensureConv();
    stage = Math.max(stage, 1);
    if (conv.status === 'approved') return { accepted: true, reason: 'already_approved', idempotent: true };
    if (!conv.pending_credited) {
      await db.prepare('UPDATE users SET pending_paise=pending_paise+? WHERE id=?').run(reward, click.user_id);
      await db.prepare('INSERT INTO wallet_ledger(user_id,kind,amount_paise,ref) VALUES(?,?,?,?)').run(click.user_id, 'pending_credit', reward, click_id);
      await db.prepare('UPDATE conversions SET pending_credited=1, status=?, txn_id=?, updated_at=datetime(\'now\') WHERE click_id=?').run('pending', txn_id || conv.txn_id, click_id);
    } else {
      await db.prepare('UPDATE conversions SET updated_at=datetime(\'now\') WHERE click_id=?').run(click_id);
    }
    result = 'pending_credited';
  } else if (st === 'approved') {
    await ensureConv();
    if (conv.approved_credited) {
      result = 'already_approved_idempotent';
    } else {
      // V2: approval does NOT pay out directly. Money waits in the
      // "Approved — release pending" bucket until the admin releases it.
      await holdApproval(click, conv, reward, { fromPending: !!conv.pending_credited });
      if (txn_id) await db.prepare('UPDATE conversions SET txn_id=? WHERE click_id=?').run(txn_id, click_id);
      conv = await db.prepare('SELECT * FROM conversions WHERE click_id=?').get(click_id);
      result = 'approved_pending_release';
    }
    stage = Math.max(stage, 5);
    if (conv.released) stage = 6;
  } else if (st === 'rejected') {
    await ensureConv();
    if (conv.approved_credited) return { accepted: true, reason: 'already_approved', idempotent: true };
    if (conv.pending_credited) {
      await db.prepare('UPDATE users SET pending_paise=pending_paise-? WHERE id=?').run(reward, click.user_id);
      await db.prepare('INSERT INTO wallet_ledger(user_id,kind,amount_paise,ref) VALUES(?,?,?,?)').run(click.user_id, 'rejected_reversal', -reward, click_id);
    }
    await db.prepare('UPDATE conversions SET status=\'rejected\', pending_credited=0, updated_at=datetime(\'now\') WHERE click_id=?').run(click_id);
    result = 'rejected_recorded';
  }
  const convStatus = st === 'pending' || st === 'approved' || st === 'rejected' ? st : (conv ? conv.status : click.conv_status);
  await db.prepare('UPDATE clicks SET stage=?, conv_status=?, updated_at=datetime(\'now\') WHERE click_id=?').run(stage, convStatus, click_id);
  return { accepted: true, reason: result, stage };
}

// ---------- http helpers ----------
function send(res, code, body, headers = {}) { res.writeHead(code, headers); res.end(body); }
function html(res, code, body, headers = {}) { send(res, code, body, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); }
function json(res, code, obj, headers = {}) { send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json', ...headers }); }
function redirect(res, to, headers = {}) { send(res, 302, '', { Location: to, ...headers }); }

async function currentUser(req) {
  const cookies = parseCookies(req);
  if (!cookies.sid) return null;
  const s = await db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha256(cookies.sid));
  if (!s || s.expires_at < Date.now()) return null;
  return await db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id) || null;
}
async function startSession(res, userId, remember) {
  const token = randomToken(32);
  const days = remember ? 30 : 1;
  await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha256(token), userId, Date.now() + days * 864e5);
  return cookieHeader('sid', token, remember ? { maxAge: 30 * 86400 } : {});
}

async function layout(user, title, body) {
  const site = esc(await getSetting(db, 'site_name', 'CampaignWala'));
  const nav = user
    ? `<span class="who">${esc(user.name)}</span><a href="/my">My Dashboard</a><a href="/wallet">Wallet</a>${user.is_admin ? '<a href="/admin">Admin</a>' : ''}<form method="post" action="/logout" class="inline"><button class="linkbtn" type="submit">Logout</button></form>`
    : `<a href="/login">Login</a><a class="btn small" href="/signup">Sign up</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${site}</title><link rel="stylesheet" href="/style.css"></head><body>
<header><div class="wrap head"><a class="logo" href="/">${site}</a><nav>${nav}</nav></div></header>
<main class="wrap">${body}</main>
<footer><div class="wrap foot"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms</a><a href="/refund-policy">Refund &amp; Rejection Policy</a></div></footer>
</body></html>`;
}
function timelineHtml(click) {
  const items = STAGES.map((label, i) => {
    const done = i <= click.stage && click.conv_status !== 'rejected';
    const rejectedNote = click.conv_status === 'rejected' && i === 5;
    return `<li class="${done ? 'done' : 'todo'} ${rejectedNote ? 'bad' : ''}"><span class="dot">${done ? '✓' : i + 1}</span><span>${esc(label)}${rejectedNote ? ' — Rejected by partner' : ''}</span></li>`;
  }).join('');
  return `<ol class="timeline">${items}</ol>`;
}
const publicList = async () => (await db.prepare('SELECT * FROM campaigns WHERE is_live=1 ORDER BY id DESC').all()).map(publicCampaign);

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const user = await currentUser(req);

    if (p === '/style.css') { return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'style.css')), { 'Content-Type': 'text/css' }); }
    if (p === '/app.js') { return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'app.js')), { 'Content-Type': 'text/javascript' }); }
    if (p === '/health') return json(res, 200, { ok: true });

    // Public API — sanitized shape ONLY (see publicCampaign).
    if (p === '/api/campaigns' && req.method === 'GET') return json(res, 200, { campaigns: await publicList() });
    if (p.startsWith('/api/campaigns/') && req.method === 'GET') {
      const c = await db.prepare('SELECT * FROM campaigns WHERE id=? AND is_live=1').get(p.split('/')[3]);
      return c ? json(res, 200, publicCampaign(c)) : json(res, 404, { error: 'not_found' });
    }

    // S2S postback — secret verified, every call logged, secrets never logged.
    if (p === '/api/postback') {
      const q = Object.fromEntries(url.searchParams);
      const body = req.method === 'POST' ? await readBody(req) : {};
      const data = { ...q, ...body };
      const provided = req.headers['x-postback-secret'] || data.secret || '';
      const { secret, ...payload } = data;
      const _pbSecret = await postbackSecret();
      const okSecret = !!_pbSecret && safeEqual(provided, _pbSecret);
      let result;
      if (!okSecret) result = { accepted: false, reason: 'bad_secret' };
      else if (!data.click_id) result = { accepted: false, reason: 'missing_click_id' };
      else result = await applyPostback(data);
      await db.prepare('INSERT INTO postback_log(ip,click_id,event,status,accepted,reason,payload_json) VALUES(?,?,?,?,?,?,?)')
        .run(req.socket.remoteAddress || '', data.click_id || '', data.event || '', data.status || '', result.accepted ? 1 : 0, result.reason, JSON.stringify(payload));
      return json(res, result.accepted ? 200 : 401, result);
    }

    if (p === '/' && req.method === 'GET') {
      const cards = (await publicList()).map(c => `<article class="card camp"><div class="icon">${esc(c.icon_text)}</div>
        <div class="grow"><h3>${esc(c.title)}</h3><p class="muted">${esc(c.category)} · ${esc(c.geo)}</p><p>${esc(c.description)}</p></div>
        <div class="reward">${esc(rewardLabel(c))}<a class="btn" href="/campaign/${c.id}">View</a></div></article>`).join('');
      return html(res, 200, await layout(user, 'Live Campaigns', `<h1>Live Campaigns</h1><p class="muted">Campaign complete karo, paisa seedha tumhare wallet me. Withdraw UPI, bank ya gift card me.</p>${cards || '<p>No live campaigns right now. Thodi der me dobara check karo.</p>'}`));
    }
    if (p.startsWith('/campaign/') && req.method === 'GET') {
      const c = await db.prepare('SELECT * FROM campaigns WHERE id=? AND is_live=1').get(p.split('/')[2]);
      if (!c) return html(res, 404, await layout(user, 'Not found', '<h1>Campaign not found</h1>'));
      const pub = publicCampaign(c);
      return html(res, 200, await layout(user, pub.title, `<article class="card"><div class="icon big">${esc(pub.icon_text)}</div>
        <h1>${esc(pub.title)}</h1><p class="muted">${esc(pub.category)} · ${esc(pub.geo)}</p><p>${esc(pub.description)}</p>
        <p class="bigreward">You get: ${esc(rewardLabel(pub))}</p>
        ${pub.reward_mode === 'random' ? '<p class="muted">Random reward hai — exact amount campaign approve hone ke time decide hoga, is range ke andar hi milega.</p>' : ''}
        ${pub.campaign_type === 'custom' ? '<p class="muted">Yeh manual verification campaign hai: Start karke link se task complete karo, phir apni progress page se claim submit karo. Admin verify karke approve karega.</p>' : ''}
        <h2>Steps</h2><ol>${pub.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
        <h2>Rules</h2><p>${esc(pub.rules)}</p>
        ${user ? `<form method="post" action="/campaign/${pub.id}/start"><button class="btn" type="submit">Start Campaign</button></form>` : '<a class="btn" href="/login">Login to start</a>'}
        </article>`));
    }
    if (p.match(/^\/campaign\/\d+\/start$/) && req.method === 'POST') {
      if (!user) return redirect(res, '/login');
      const id = p.split('/')[2];
      const c = await db.prepare('SELECT * FROM campaigns WHERE id=? AND is_live=1').get(id);
      if (!c) return html(res, 404, await layout(user, 'Not found', '<h1>Campaign not found</h1>'));
      const clickId = 'clk_' + randomToken(10);
      await db.prepare('INSERT INTO clicks(click_id,user_id,campaign_id,stage,ip,ua) VALUES(?,?,?,?,?,?)')
        .run(clickId, user.id, c.id, 0, req.socket.remoteAddress || '', req.headers['user-agent'] || '');
      return redirect(res, `/my/campaigns/${clickId}`);
    }

    // Auth
    if (p === '/signup' && req.method === 'GET') {
      const ref = url.searchParams.get('ref') || parseCookies(req).ref || '';
      return html(res, 200, await layout(null, 'Sign up', `<h1>Create account</h1><form class="card form" method="post" action="/signup">
        <label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
        <label>Phone<input name="phone"></label><label>Password<input name="password" type="password" required minlength="8"></label>
        <label>Referral code (optional)<input name="ref" value="${esc(ref)}"></label>
        <label class="check"><input type="checkbox" name="remember" value="1"> Remember me for 30 days</label>
        <button class="btn" type="submit">Sign up</button></form>`));
    }
    if (p === '/signup' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.name || !b.email || !b.password || String(b.password).length < 8) return html(res, 400, await layout(null, 'Sign up', '<p>Details sahi se bharo — password kam se kam 8 characters.</p>'));
      if (await db.prepare('SELECT id FROM users WHERE email=?').get(String(b.email).toLowerCase())) return html(res, 400, await layout(null, 'Sign up', '<p>Is email se account pehle se hai. Login karo.</p>'));
      const referrer = b.ref ? await db.prepare('SELECT id FROM users WHERE referral_code=?').get(String(b.ref).trim().toUpperCase()) : null;
      const info = await db.prepare('INSERT INTO users(name,email,phone,pass_hash,referral_code,referred_by) VALUES(?,?,?,?,?,?)')
        .run(b.name, String(b.email).toLowerCase(), b.phone || '', hashPassword(b.password), randomCode(8), referrer ? referrer.id : null);
      const cookie = await startSession(res, Number(info.lastInsertRowid), b.remember === '1');
      return redirect(res, '/my', { 'Set-Cookie': cookie });
    }
    if (p === '/login' && req.method === 'GET') return html(res, 200, await layout(null, 'Login', `<h1>Login</h1><form class="card form" method="post" action="/login">
      <label>Email<input name="email" type="email" required></label><label>Password<input name="password" type="password" required></label>
      <label class="check"><input type="checkbox" name="remember" value="1"> Remember me for 30 days</label>
      <button class="btn" type="submit">Login</button></form><p class="muted">Naya account? <a href="/signup">Sign up</a></p>`));
    if (p === '/login' && req.method === 'POST') {
      const b = await readBody(req);
      const u = await db.prepare('SELECT * FROM users WHERE email=?').get(String(b.email || '').toLowerCase());
      if (!u || !verifyPassword(b.password || '', u.pass_hash)) return html(res, 401, await layout(null, 'Login', '<p>Email ya password galat hai.</p>'));
      const cookie = await startSession(res, u.id, b.remember === '1');
      return redirect(res, '/my', { 'Set-Cookie': cookie });
    }
    if (p === '/logout' && req.method === 'POST') {
      const cookies = parseCookies(req);
      if (cookies.sid) await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(cookies.sid));
      return redirect(res, '/', { 'Set-Cookie': cookieHeader('sid', '', { maxAge: 0 }) });
    }
    if (p.startsWith('/r/') && req.method === 'GET') {
      return redirect(res, `/signup?ref=${encodeURIComponent(p.split('/')[2] || '')}`, { 'Set-Cookie': cookieHeader('ref', p.split('/')[2] || '', { maxAge: 30 * 86400 }) });
    }

    // User area
    if (p === '/my' && req.method === 'GET') {
      if (!user) return redirect(res, '/login');
      const mine = await db.prepare('SELECT cl.*, c.title FROM clicks cl JOIN campaigns c ON c.id=cl.campaign_id WHERE cl.user_id=? ORDER BY cl.id DESC').all(user.id);
      const list = mine.map(cl => `<article class="card"><h3>${esc(cl.title)}</h3><p class="muted">Status: ${esc(cl.conv_status)} · Stage: ${esc(STAGES[cl.stage])}</p><a class="btn small" href="/my/campaigns/${esc(cl.click_id)}">Progress dekho</a></article>`).join('');
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const refLink = `${proto}://${req.headers.host}/r/${user.referral_code}`;
      return html(res, 200, await layout(user, 'My Dashboard', `<h1>My Dashboard</h1>
        <section class="card"><h2>Wallet</h2><p>Pending: <b>${inr(user.pending_paise)}</b> · Approved (release pending): <b>${inr(user.approved_paise)}</b> · Withdrawable: <b>${inr(user.withdrawable_paise)}</b></p><a class="btn small" href="/wallet">Withdraw karo</a></section>
        <section class="card"><h2>Refer &amp; Earn</h2><p class="muted">Tumhare link se join karke jab dost ka campaign approve hoga, tumhe ${esc(await getSetting(db, 'referral_percent', '10'))}% commission milega.</p><p class="reflink">${esc(refLink)}</p><p class="muted">Code: ${esc(user.referral_code)}</p></section>
        <h2>My Campaigns</h2>${list || '<p>Abhi koi campaign start nahi kiya.</p>'}`));
    }
    if (p.startsWith('/my/campaigns/') && req.method === 'GET') {
      if (!user) return redirect(res, '/login');
      const clickId = p.split('/')[3];
      const cl = await db.prepare('SELECT cl.*, c.title, c.user_reward_paise, c.campaign_type, c.reward_mode, c.reward_min_paise, c.reward_max_paise, c.link_url FROM clicks cl JOIN campaigns c ON c.id=cl.campaign_id WHERE cl.click_id=? AND cl.user_id=?').get(clickId, user.id);
      if (!cl) return html(res, 404, await layout(user, 'Not found', '<h1>Not found</h1>'));
      const conv = await db.prepare('SELECT * FROM conversions WHERE click_id=?').get(clickId);
      const claim = await db.prepare('SELECT * FROM claims WHERE click_id=?').get(clickId);
      const rewardText = cl.campaign_type === 'custom' && claim && claim.status === 'approved'
        ? inr(claim.rolled_reward_paise)
        : esc(rewardLabel(cl));
      let extra = '';
      if (cl.link_url) extra += `<p><a class="btn" href="/go/${esc(cl.click_id)}" target="_blank" rel="noopener">Campaign kholo →</a></p>`;
      if (conv && conv.status === 'approved' && !conv.released) {
        extra += `<p class="notice">✅ Approved! Expected wallet credit date: <b id="creditDate">${esc(fmtDate(conv.expected_credit_date))}</b><br><span class="muted">Admin is date ke aas-paas amount release karega, tab woh Withdrawable hoga.</span></p>`;
      }
      if (conv && conv.released) extra += `<p class="notice">💰 Paisa wallet me credit ho gaya hai — <a href="/wallet">Wallet dekho</a></p>`;
      if (cl.campaign_type === 'custom') {
        if (!claim) {
          extra += `<h2>Task complete kar liya? Claim karo</h2><form class="form" method="post" action="/my/campaigns/${esc(cl.click_id)}/claim">
            <label>Note (kya kiya, kis number/ID se)<textarea name="note" required rows="3"></textarea></label>
            <label>Proof link (screenshot ka link, optional)<input name="proof_url" type="url" placeholder="https://..."></label>
            <button class="btn" type="submit">Claim Submit Karo</button></form>`;
        } else if (claim.status === 'pending') {
          extra += `<p class="notice">📩 Tumhara claim submit ho gaya hai. Admin verify karke approve/reject karega — status yahi dikhega.</p>`;
        } else if (claim.status === 'approved') {
          extra += `<p class="notice">✅ Claim approved — reward: <b>${inr(claim.rolled_reward_paise)}</b>. Upar wali expected date par wallet me release hoga.</p>`;
        } else if (claim.status === 'rejected') {
          extra += `<p class="notice bad">❌ Claim reject ho gaya. Reason: <b>${esc(claim.reject_reason || '—')}</b></p>
          <h2>Dobara claim karo</h2><form class="form" method="post" action="/my/campaigns/${esc(cl.click_id)}/claim">
            <label>Note<textarea name="note" required rows="3"></textarea></label>
            <label>Proof link (optional)<input name="proof_url" type="url" placeholder="https://..."></label>
            <button class="btn" type="submit">Claim Dobara Submit Karo</button></form>`;
        }
      }
      return html(res, 200, await layout(user, 'Progress', `<article class="card"><h1>${esc(cl.title)}</h1>
        <p class="muted">Reward: ${rewardText} · Status: <span id="convStatus">${esc(cl.conv_status)}</span></p>
        <div id="timeline">${timelineHtml(cl)}</div>${extra}
        <p class="muted">Yeh page har kuch seconds me khud update hota hai. Jo step ho gaya woh ✓, jo baki hai woh number me dikhega.</p></article>
        <script src="/app.js"></script><script>watchProgress(${JSON.stringify(clickId)})</script>`));
    }
    if (p.match(/^\/my\/campaigns\/[^/]+\/claim$/) && req.method === 'POST') {
      if (!user) return redirect(res, '/login');
      const clickId = p.split('/')[3];
      const cl = await db.prepare('SELECT cl.*, c.campaign_type FROM clicks cl JOIN campaigns c ON c.id=cl.campaign_id WHERE cl.click_id=? AND cl.user_id=?').get(clickId, user.id);
      if (!cl) return html(res, 404, await layout(user, 'Not found', '<h1>Not found</h1>'));
      if (cl.campaign_type !== 'custom') return html(res, 400, await layout(user, 'Claim', '<p>Is campaign me claim nahi hota — tracking automatic hai.</p>'));
      const b = await readBody(req);
      if (!b.note || !String(b.note).trim()) return html(res, 400, await layout(user, 'Claim', '<p>Note likhna zaroori hai.</p>'));
      const existing = await db.prepare('SELECT * FROM claims WHERE click_id=?').get(clickId);
      if (existing && existing.status !== 'rejected') return redirect(res, `/my/campaigns/${clickId}`);
      if (existing) await db.prepare('DELETE FROM claims WHERE click_id=?').run(clickId);
      await db.prepare('INSERT INTO claims(click_id,user_id,campaign_id,note,proof_url) VALUES(?,?,?,?,?)')
        .run(clickId, user.id, cl.campaign_id, String(b.note).trim(), String(b.proof_url || '').trim());
      await db.prepare("UPDATE clicks SET conv_status='claim_submitted', stage=MAX(stage,1), updated_at=datetime('now') WHERE click_id=?").run(clickId);
      return redirect(res, `/my/campaigns/${clickId}`);
    }
    if (p.startsWith('/go/') && req.method === 'GET') {
      if (!user) return redirect(res, '/login');
      const clickId = p.split('/')[2];
      const cl = await db.prepare('SELECT cl.*, c.link_url FROM clicks cl JOIN campaigns c ON c.id=cl.campaign_id WHERE cl.click_id=? AND cl.user_id=?').get(clickId, user.id);
      if (!cl) return html(res, 404, await layout(user, 'Not found', '<h1>Not found</h1>'));
      if (!cl.link_url) return redirect(res, `/my/campaigns/${clickId}`);
      await db.prepare("UPDATE clicks SET stage=MAX(stage,1), updated_at=datetime('now') WHERE click_id=?").run(clickId);
      return redirect(res, cl.link_url.replaceAll('{click_id}', clickId));
    }
    if (p.startsWith('/api/my/progress/') && req.method === 'GET') {
      if (!user) return json(res, 401, { error: 'login_required' });
      const cl = await db.prepare('SELECT * FROM clicks WHERE click_id=? AND user_id=?').get(p.split('/')[4], user.id);
      if (!cl) return json(res, 404, { error: 'not_found' });
      const conv = await db.prepare('SELECT status, expected_credit_date, released FROM conversions WHERE click_id=?').get(cl.click_id);
      const claim = await db.prepare('SELECT status FROM claims WHERE click_id=?').get(cl.click_id);
      return json(res, 200, {
        click_id: cl.click_id, stage: cl.stage, stage_label: STAGES[cl.stage], conv_status: cl.conv_status, stages: STAGES,
        expected_credit_date: conv ? fmtDate(conv.expected_credit_date) : '', released: conv ? !!conv.released : false,
        claim_status: claim ? claim.status : null,
      });
    }
    if (p === '/wallet' && req.method === 'GET') {
      if (!user) return redirect(res, '/login');
      const min = Number(await getSetting(db, 'min_withdrawal_paise', '5000'));
      const wds = await db.prepare('SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC').all(user.id);
      const ledger = await db.prepare('SELECT * FROM wallet_ledger WHERE user_id=? ORDER BY id DESC LIMIT 20').all(user.id);
      const approvedList = await db.prepare(`SELECT cv.user_reward_paise, cv.expected_credit_date, c.title FROM conversions cv
        JOIN clicks cl ON cl.click_id=cv.click_id JOIN campaigns c ON c.id=cl.campaign_id
        WHERE cl.user_id=? AND cv.status='approved' AND cv.released=0 ORDER BY cv.expected_credit_date`).all(user.id);
      return html(res, 200, await layout(user, 'Wallet', `<h1>Wallet</h1><section class="card">
        <p>Pending balance: <b>${inr(user.pending_paise)}</b> <span class="muted">(partner approval ka wait ho raha hai)</span></p>
        <p>Approved (release pending): <b>${inr(user.approved_paise)}</b> <span class="muted">(approve ho gaya hai — admin expected date par release karega, tab withdrawable hoga)</span></p>
        ${approvedList.map(a => `<p class="muted">• ${esc(a.title)} — ${inr(a.user_reward_paise)} · Expected credit: <b>${esc(fmtDate(a.expected_credit_date))}</b></p>`).join('')}
        <p>Withdrawable balance: <b>${inr(user.withdrawable_paise)}</b></p>
        <form class="form" method="post" action="/wallet/withdraw"><label>Amount (₹)<input name="amount" type="number" min="1" required></label>
        <label>Method<select name="method"><option value="upi">UPI</option><option value="bank">Bank</option><option value="giftcard">Gift Card</option></select></label>
        <label>UPI ID / Bank details / Email<input name="destination" required></label>
        <p class="muted">Minimum withdrawal: ${inr(min)}</p><button class="btn" type="submit">Request Withdrawal</button></form></section>
        <h2>My Withdrawals</h2>${wds.map(w => `<article class="card"><b>${inr(w.amount_paise)}</b> · ${esc(w.method)} · Status: ${esc(w.status)}</article>`).join('') || '<p>Abhi koi withdrawal nahi.</p>'}
        <h2>History</h2>${ledger.map(l => `<article class="card"><span>${esc(l.kind)}</span> <b>${inr(l.amount_paise)}</b> <span class="muted">${esc(l.created_at)}</span></article>`).join('') || '<p>No history yet.</p>'}`));
    }
    if (p === '/wallet/withdraw' && req.method === 'POST') {
      if (!user) return redirect(res, '/login');
      const b = await readBody(req);
      const amount = Math.round(Number(b.amount || 0) * 100);
      const min = Number(await getSetting(db, 'min_withdrawal_paise', '5000'));
      if (!amount || amount < min) return html(res, 400, await layout(user, 'Wallet', `<p>Minimum withdrawal ${inr(min)} hai.</p>`));
      if (amount > user.withdrawable_paise) return html(res, 400, await layout(user, 'Wallet', '<p>Withdrawable balance kam hai.</p>'));
      if (!b.destination || !['upi', 'bank', 'giftcard'].includes(b.method)) return html(res, 400, await layout(user, 'Wallet', '<p>Details sahi se bharo.</p>'));
      await db.prepare('UPDATE users SET withdrawable_paise=withdrawable_paise-? WHERE id=?').run(amount, user.id);
      const info = await db.prepare('INSERT INTO withdrawals(user_id,amount_paise,method,destination) VALUES(?,?,?,?)').run(user.id, amount, b.method, b.destination);
      await db.prepare('INSERT INTO wallet_ledger(user_id,kind,amount_paise,ref) VALUES(?,?,?,?)').run(user.id, 'withdrawal_hold', -amount, 'wd_' + info.lastInsertRowid);
      return redirect(res, '/wallet');
    }

    // Static policy pages
    if (p === '/privacy') return html(res, 200, await layout(user, 'Privacy Policy', POLICY.privacy));
    if (p === '/terms') return html(res, 200, await layout(user, 'Terms', POLICY.terms));
    if (p === '/refund-policy') return html(res, 200, await layout(user, 'Refund & Rejection Policy', POLICY.refund));

    // Admin
    if (p.startsWith('/admin')) {
      if (!user) return redirect(res, '/login');
      if (!user.is_admin) return html(res, 403, await layout(user, 'Admin', '<h1>Admin access only</h1>'));
      return await adminRoutes(req, res, p, url, user);
    }

    return html(res, 404, await layout(user, 'Not found', '<h1>Page not found</h1>'));
  } catch (err) {
    console.error(err);
    return html(res, 500, '<h1>Something went wrong</h1>');
  }
});

async function adminRoutes(req, res, p, url, user) {
  const L = async (t, b) => await layout(user, t, b);
  if (p === '/admin' && req.method === 'GET') {
    const stats = {
      users: (await db.prepare('SELECT COUNT(*) n FROM users').get()).n,
      campaigns: (await db.prepare('SELECT COUNT(*) n FROM campaigns').get()).n,
      conversions: (await db.prepare('SELECT COUNT(*) n FROM conversions').get()).n,
      pendingWd: (await db.prepare("SELECT COUNT(*) n FROM withdrawals WHERE status='pending'").get()).n,
      pendingRelease: (await db.prepare("SELECT COUNT(*) n FROM conversions WHERE status='approved' AND released=0").get()).n,
      pendingClaims: (await db.prepare("SELECT COUNT(*) n FROM claims WHERE status='pending'").get()).n,
    };
    const lastCleanup = await getSetting(db, 'last_cleanup_at', '');
    return html(res, 200, await L('Admin', `<h1>Admin Dashboard</h1>
      <section class="card"><p>Users: <b>${stats.users}</b> · Campaigns: <b>${stats.campaigns}</b> · Conversions: <b>${stats.conversions}</b> · Pending withdrawals: <b>${stats.pendingWd}</b> · Release pending: <b>${stats.pendingRelease}</b> · Claims pending: <b>${stats.pendingClaims}</b></p>${lastCleanup ? `<p class="muted">Last data cleanup (retention: raw 30d · financial 60d after closure): ${esc(lastCleanup)}</p>` : ''}</section>
      <nav class="adminnav"><a class="btn small" href="/admin/campaigns">Campaigns</a><a class="btn small" href="/admin/releases">Releases</a><a class="btn small" href="/admin/claims">Claims</a><a class="btn small" href="/admin/earnings">Earnings</a><a class="btn small" href="/admin/users">Users</a><a class="btn small" href="/admin/conversions">Conversions &amp; Postbacks</a><a class="btn small" href="/admin/withdrawals">Withdrawals</a><a class="btn small" href="/admin/settings">Settings</a></nav>
      <form method="post" action="/admin/import"><button class="btn" type="submit">Import campaigns from ALL feeds now</button></form>
      <form method="post" action="/admin/reconcile"><button class="btn ghost" type="submit">Run reconciliation check</button></form>`));
  }
  if (p === '/admin/import' && req.method === 'POST') {
    const r = await importAllFeeds(db);
    return html(res, 200, await L('Import', `<p>Import result: ${esc(JSON.stringify(r))}</p><p><a href="/admin/campaigns">Campaigns dekho</a></p>`));
  }
  if (p === '/admin/reconcile' && req.method === 'POST') {
    const r = await reconcilePending(db);
    return html(res, 200, await L('Reconcile', `<p>${esc(JSON.stringify(r))}</p>`));
  }
  if (p === '/admin/campaigns' && req.method === 'GET') {
    const all = await db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
    const cards = all.map(c => {
      // ADMIN-ONLY money line: company payout / user reward / margin.
      // upstream_payout_paise is server-only data — it is rendered ONLY here,
      // inside the authenticated admin area, never in publicCampaign/public API.
      // Custom campaigns have no upstream payout in-system -> show an em dash.
      const hasUpstream = Number(c.upstream_payout_paise) > 0;
      const payoutTxt = hasUpstream ? inr(c.upstream_payout_paise) : '—';
      const marginTxt = hasUpstream ? inr(c.upstream_payout_paise - c.user_reward_paise) : '—';
      return `<article class="card"><h3>${esc(c.title)}</h3><p class="muted">${esc(c.source)} · ${esc(c.campaign_type)} · ${c.is_live ? 'LIVE' : 'OFF'}${c.reward_override ? ' · manual lock' : ''}</p>
      <p class="chips"><span class="chip">Company payout: <b>${payoutTxt}</b></span><span class="chip">User reward: <b>${esc(rewardLabel(c))}</b></span><span class="chip">Margin: <b>${marginTxt}</b></span></p>
      <p><a class="btn small" href="/admin/campaigns/${c.id}/edit">Edit</a></p>
      <form method="post" action="/admin/campaigns/${c.id}/toggle"><button class="btn small ghost" type="submit">${c.is_live ? 'Turn OFF' : 'Turn LIVE'}</button></form></article>`;
    }).join('');
    return html(res, 200, await L('Campaigns', `<h1>Campaigns</h1><p><a class="btn" href="/admin/campaigns/new">+ New Campaign</a></p>${cards}`));
  }
  const campForm = (c = {}) => `<form class="card form" method="post" action="${c.id ? `/admin/campaigns/${c.id}/edit` : '/admin/campaigns/new'}">
    <label>Title<input name="title" required value="${esc(c.title || '')}"></label>
    <label>Description<textarea name="description">${esc(c.description || '')}</textarea></label>
    <label>Category<input name="category" value="${esc(c.category || 'General')}"></label>
    <label>Geo<input name="geo" value="${esc(c.geo || 'India')}"></label>
    <label>Icon text (1-2 letters)<input name="icon_text" maxlength="2" value="${esc(c.icon_text || 'C')}"></label>
    <label>Type<select name="campaign_type">
      <option value="network" ${c.campaign_type !== 'custom' ? 'selected' : ''}>Network (postback tracking)</option>
      <option value="custom" ${c.campaign_type === 'custom' ? 'selected' : ''}>Custom (manual claim — apna referral link)</option></select></label>
    <label>Campaign link URL — custom ke liye apna referral link; network ke liye tracking link ({'{'}click_id{'}'} placeholder chalega)<input name="link_url" value="${esc(c.link_url || '')}" placeholder="https://..."></label>
    <label>Reward type<select name="reward_mode">
      <option value="fixed" ${c.reward_mode !== 'random' ? 'selected' : ''}>Fixed amount</option>
      <option value="random" ${c.reward_mode === 'random' ? 'selected' : ''}>Random range (approval par roll hoga)</option></select></label>
    <label>User reward (₹) — fixed type ke liye<input name="user_reward" type="number" step="0.01" value="${c.id ? c.user_reward_paise / 100 : ''}"></label>
    <label>Random reward min (₹)<input name="reward_min" type="number" step="0.01" value="${c.id && c.reward_min_paise ? c.reward_min_paise / 100 : ''}"></label>
    <label>Random reward max (₹)<input name="reward_max" type="number" step="0.01" value="${c.id && c.reward_max_paise ? c.reward_max_paise / 100 : ''}"></label>
    <label>Upstream payout (₹) — server only, kabhi frontend par nahi jata<input name="upstream_payout" type="number" step="0.01" value="" placeholder="${c.id ? 'blank = no change' : ''}"></label>
    <label>Credit days override (blank = global setting)<input name="credit_days" type="number" min="0" value="${c.credit_days ?? ''}"></label>
    <label class="check"><input type="checkbox" name="reward_lock" value="1" ${c.reward_override ? 'checked' : ''}> Manual reward lock — feed ki auto pricing is campaign ka reward change nahi karegi</label>
    <label>Steps (ek line me ek step)<textarea name="steps" rows="5">${esc(c.id ? JSON.parse(c.steps_json || '[]').join('\n') : '')}</textarea></label>
    <label>Rules<textarea name="rules_text">${esc(c.rules_text || '')}</textarea></label>
    <label class="check"><input type="checkbox" name="is_live" value="1" ${c.is_live === undefined || c.is_live ? 'checked' : ''}> Live</label>
    <button class="btn" type="submit">Save</button></form>`;
  const campFields = async (b, existing = null) => {
    const type = b.campaign_type === 'custom' ? 'custom' : 'network';
    const mode = b.reward_mode === 'random' ? 'random' : 'fixed';
    const upstream = existing && (b.upstream_payout === '' || b.upstream_payout == null)
      ? existing.upstream_payout_paise : Math.round(Number(b.upstream_payout || 0) * 100);
    let reward = Math.round(Number(b.user_reward || 0) * 100);
    let override = b.reward_lock === '1' ? 1 : 0;
    // Auto pricing on manual save too (unless locked): reward follows upstream × share.
    if (!override && upstream > 0 && type === 'network') {
      reward = Math.floor(upstream * (Number(await getSetting(db, 'user_share_percent', '87.5')) || 0) / 100);
    }
    if (mode === 'random' && !reward) reward = Math.round(Number(b.reward_min || 0) * 100);
    return {
      title: b.title, description: b.description || '', category: b.category || 'General', geo: b.geo || 'India',
      icon: (b.icon_text || 'C').slice(0, 2), type, mode, reward, override, upstream,
      min: Math.round(Number(b.reward_min || 0) * 100), max: Math.round(Number(b.reward_max || 0) * 100),
      link: String(b.link_url || '').trim(),
      creditDays: b.credit_days === '' || b.credit_days == null ? null : Math.max(0, Math.round(Number(b.credit_days))),
      steps: JSON.stringify(parseSteps(b.steps)), rules: b.rules_text || '', live: b.is_live === '1' ? 1 : 0,
    };
  };
  if (p === '/admin/campaigns/new' && req.method === 'GET') return html(res, 200, await L('New Campaign', `<h1>New Campaign</h1>${campForm()}`));
  if (p === '/admin/campaigns/new' && req.method === 'POST') {
    const b = await readBody(req);
    const f = await campFields(b);
    await db.prepare(`INSERT INTO campaigns(title,description,category,geo,icon_text,user_reward_paise,upstream_payout_paise,steps_json,rules_text,campaign_type,reward_mode,reward_min_paise,reward_max_paise,reward_override,link_url,credit_days,source,external_id,is_live)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'manual',?,?)`)
      .run(f.title, f.description, f.category, f.geo, f.icon, f.reward, f.upstream, f.steps, f.rules, f.type, f.mode, f.min, f.max, f.override, f.link, f.creditDays, 'manual-' + Date.now(), f.live);
    return redirect(res, '/admin/campaigns');
  }
  const editMatch = p.match(/^\/admin\/campaigns\/(\d+)\/edit$/);
  if (editMatch && req.method === 'GET') {
    const c = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(editMatch[1]);
    return c ? html(res, 200, await L('Edit Campaign', `<h1>Edit Campaign</h1>${campForm(c)}`)) : html(res, 404, await L('404', '<h1>Not found</h1>'));
  }
  if (editMatch && req.method === 'POST') {
    const b = await readBody(req);
    const c = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(editMatch[1]);
    const f = await campFields(b, c);
    await db.prepare(`UPDATE campaigns SET title=?,description=?,category=?,geo=?,icon_text=?,user_reward_paise=?,upstream_payout_paise=?,steps_json=?,rules_text=?,
      campaign_type=?,reward_mode=?,reward_min_paise=?,reward_max_paise=?,reward_override=?,link_url=?,credit_days=?,is_live=? WHERE id=?`)
      .run(f.title, f.description, f.category, f.geo, f.icon, f.reward, f.upstream, f.steps, f.rules, f.type, f.mode, f.min, f.max, f.override, f.link, f.creditDays, f.live, c.id);
    return redirect(res, '/admin/campaigns');
  }
  const toggleMatch = p.match(/^\/admin\/campaigns\/(\d+)\/toggle$/);
  if (toggleMatch && req.method === 'POST') {
    await db.prepare('UPDATE campaigns SET is_live = 1 - is_live WHERE id=?').run(toggleMatch[1]);
    return redirect(res, '/admin/campaigns');
  }
  if (p === '/admin/users' && req.method === 'GET') {
    const users = await db.prepare('SELECT * FROM users ORDER BY id DESC').all();
    return html(res, 200, await L('Users', `<h1>Users</h1>${users.map(u => `<article class="card"><h3>${esc(u.name)}</h3><p class="muted">${esc(u.email)} · ${esc(u.phone || '')}</p><p>Pending ${inr(u.pending_paise)} · Approved (release pending) ${inr(u.approved_paise)} · Withdrawable ${inr(u.withdrawable_paise)} · Ref code ${esc(u.referral_code)}${u.is_admin ? ' · ADMIN' : ''}</p></article>`).join('')}`));
  }
  if (p === '/admin/conversions' && req.method === 'GET') {
    const convs = await db.prepare('SELECT cv.*, c.title FROM conversions cv JOIN clicks cl ON cl.click_id=cv.click_id JOIN campaigns c ON c.id=cl.campaign_id ORDER BY cv.id DESC LIMIT 50').all();
    const logs = await db.prepare('SELECT * FROM postback_log ORDER BY id DESC LIMIT 50').all();
    return html(res, 200, await L('Conversions', `<h1>Conversions</h1>${convs.map(cv => `<article class="card"><b>${esc(cv.title)}</b><p class="muted">${esc(cv.click_id)} · ${esc(cv.status)}${cv.status === 'approved' ? (cv.released ? ' · RELEASED' : ` · release pending (expected ${esc(fmtDate(cv.expected_credit_date))})`) : ''} · User reward ${inr(cv.user_reward_paise)}</p></article>`).join('') || '<p>None yet.</p>'}
      <h1>Postback Log</h1>${logs.map(l => `<article class="card"><p class="muted">#${l.id} · ${esc(l.received_at)} · ${esc(l.click_id)} · event=${esc(l.event)} status=${esc(l.status)} · ${l.accepted ? 'ACCEPTED' : 'REJECTED'} (${esc(l.reason)})</p></article>`).join('') || '<p>No postbacks yet.</p>'}`));
  }
  if (p === '/admin/withdrawals' && req.method === 'GET') {
    const wds = await db.prepare('SELECT w.*, u.name, u.email FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC').all();
    return html(res, 200, await L('Withdrawals', `<h1>Withdrawals</h1>${wds.map(w => `<article class="card"><b>${inr(w.amount_paise)}</b> · ${esc(w.method)}<p class="muted">${esc(w.name)} (${esc(w.email)}) · ${esc(w.destination)} · Status: ${esc(w.status)}</p>
      ${w.status === 'pending' ? `<form method="post" action="/admin/withdrawals/${w.id}/approve" class="inline"><button class="btn small" type="submit">Approve &amp; Paid</button></form>
      <form method="post" action="/admin/withdrawals/${w.id}/reject" class="inline"><button class="btn small ghost" type="submit">Reject (refund)</button></form>` : ''}</article>`).join('') || '<p>None.</p>'}`));
  }
  const wdMatch = p.match(/^\/admin\/withdrawals\/(\d+)\/(approve|reject)$/);
  if (wdMatch && req.method === 'POST') {
    const w = await db.prepare('SELECT * FROM withdrawals WHERE id=? AND status=\'pending\'').get(wdMatch[1]);
    if (w) {
      if (wdMatch[2] === 'approve') {
        await db.prepare('UPDATE withdrawals SET status=\'paid\', processed_at=datetime(\'now\') WHERE id=?').run(w.id);
      } else {
        await db.prepare('UPDATE withdrawals SET status=\'rejected\', processed_at=datetime(\'now\') WHERE id=?').run(w.id);
        await db.prepare('UPDATE users SET withdrawable_paise=withdrawable_paise+? WHERE id=?').run(w.amount_paise, w.user_id);
        await db.prepare('INSERT INTO wallet_ledger(user_id,kind,amount_paise,ref) VALUES(?,?,?,?)').run(w.user_id, 'withdrawal_refund', w.amount_paise, 'wd_' + w.id);
      }
    }
    return redirect(res, '/admin/withdrawals');
  }
  // ---- Releases: approved money waits here until the admin releases it ----
  if (p === '/admin/releases' && req.method === 'GET') {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.prepare(`SELECT cv.*, cl.user_id, c.title, u.name, u.email FROM conversions cv
      JOIN clicks cl ON cl.click_id=cv.click_id JOIN campaigns c ON c.id=cl.campaign_id JOIN users u ON u.id=cl.user_id
      WHERE cv.status='approved' AND cv.released=0 ORDER BY cv.expected_credit_date ASC`).all();
    const cards = rows.map(cv => {
      const due = cv.expected_credit_date && cv.expected_credit_date <= today;
      return `<article class="card ${due ? 'due' : ''}"><b>${esc(cv.title)}</b> — ${inr(cv.user_reward_paise)} ${due ? '<span class="badge">DUE — release karo</span>' : ''}
      <p class="muted">${esc(cv.name)} (${esc(cv.email)}) · Approved: ${esc((cv.approved_at || '').slice(0, 10))} · Expected credit: <b>${esc(fmtDate(cv.expected_credit_date))}</b>${cv.referral_amount_paise ? ` · Referral held: ${inr(cv.referral_amount_paise)}` : ''}</p>
      <form method="post" action="/admin/releases/${esc(cv.click_id)}"><button class="btn small" type="submit">Release to Wallet</button></form></article>`;
    }).join('');
    return html(res, 200, await L('Releases', `<h1>Releases (Approved — release pending)</h1>
      <form method="post" action="/admin/releases/bulk-due"><button class="btn" type="submit">Release ALL due (date aa gayi hai)</button></form>
      <p class="muted">Release karte hi paisa user ke Withdrawable wallet me jayega aur referral commission bhi referrer ko mil jayega.</p>${cards || '<p>Abhi kuch release pending nahi.</p>'}`));
  }
  if (p === '/admin/releases/bulk-due' && req.method === 'POST') {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.prepare("SELECT click_id FROM conversions WHERE status='approved' AND released=0 AND expected_credit_date<=?").all(today);
    let n = 0;
    for (const r of rows) if ((await releaseConversion(r.click_id)).ok) n++;
    return html(res, 200, await L('Releases', `<p>${n} conversion(s) release ho gaye.</p><p><a href="/admin/releases">Wapas Releases</a></p>`));
  }
  const relMatch = p.match(/^\/admin\/releases\/([\w-]+)$/);
  if (relMatch && req.method === 'POST') {
    const r = await releaseConversion(relMatch[1]);
    return html(res, 200, await L('Releases', `<p>Release result: ${esc(r.reason)}</p><p><a href="/admin/releases">Wapas Releases</a></p>`));
  }
  // ---- Claims (custom / manual-verification campaigns) ----
  if (p === '/admin/claims' && req.method === 'GET') {
    const claims = await db.prepare(`SELECT cq.*, c.title, u.name, u.email FROM claims cq
      JOIN campaigns c ON c.id=cq.campaign_id JOIN users u ON u.id=cq.user_id ORDER BY cq.id DESC LIMIT 100`).all();
    return html(res, 200, await L('Claims', `<h1>Claims (Custom Campaigns)</h1>${claims.map(cq => `<article class="card"><b>${esc(cq.title)}</b> · Status: ${esc(cq.status)}${cq.status === 'approved' ? ` · Reward: ${inr(cq.rolled_reward_paise)}` : ''}
      <p class="muted">${esc(cq.name)} (${esc(cq.email)}) · ${esc(cq.created_at)}</p>
      <p>Note: ${esc(cq.note)}</p>${cq.proof_url ? `<p>Proof: <a href="${esc(cq.proof_url)}" target="_blank" rel="noopener">${esc(cq.proof_url)}</a></p>` : ''}
      ${cq.status === 'rejected' ? `<p class="muted">Reject reason: ${esc(cq.reject_reason)}</p>` : ''}
      ${cq.status === 'pending' ? `<form method="post" action="/admin/claims/${cq.id}/approve" class="inline"><button class="btn small" type="submit">Approve</button></form>
      <form method="post" action="/admin/claims/${cq.id}/reject" class="form inline-form"><input name="reason" placeholder="Reject reason (user ko dikhega)" required><button class="btn small ghost" type="submit">Reject</button></form>` : ''}</article>`).join('') || '<p>No claims yet.</p>'}`));
  }
  const claimMatch = p.match(/^\/admin\/claims\/(\d+)\/(approve|reject)$/);
  if (claimMatch && req.method === 'POST') {
    const claim = await db.prepare("SELECT * FROM claims WHERE id=? AND status='pending'").get(claimMatch[1]);
    if (claim) {
      const b = await readBody(req);
      if (claimMatch[2] === 'reject') {
        await db.prepare("UPDATE claims SET status='rejected', reject_reason=?, processed_at=datetime('now') WHERE id=?").run(String(b.reason || 'Verification fail ho gaya'), claim.id);
        await db.prepare("UPDATE clicks SET conv_status='claim_rejected', updated_at=datetime('now') WHERE click_id=?").run(claim.click_id);
      } else {
        const camp = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(claim.campaign_id);
        let amount = camp.user_reward_paise;
        if (camp.reward_mode === 'random') {
          const min = camp.reward_min_paise, max = Math.max(min, camp.reward_max_paise);
          amount = (min % 100 === 0 && max % 100 === 0)
            ? (min / 100 + Math.floor(Math.random() * (max / 100 - min / 100 + 1))) * 100
            : min + Math.floor(Math.random() * (max - min + 1));
        }
        const click = await db.prepare('SELECT cl.*, u.referred_by FROM clicks cl JOIN users u ON u.id=cl.user_id WHERE cl.click_id=?').get(claim.click_id);
        click.credit_days = camp.credit_days;
        let conv = await db.prepare('SELECT * FROM conversions WHERE click_id=?').get(claim.click_id);
        if (!conv) {
          await db.prepare('INSERT INTO conversions(click_id,status,txn_id,user_reward_paise,upstream_payout_paise) VALUES(?,?,?,?,?)')
            .run(claim.click_id, 'pending', '', amount, camp.upstream_payout_paise || 0);
          conv = await db.prepare('SELECT * FROM conversions WHERE click_id=?').get(claim.click_id);
        }
        if (!conv.approved_credited) await holdApproval(click, conv, amount, { fromPending: !!conv.pending_credited });
        await db.prepare("UPDATE claims SET status='approved', rolled_reward_paise=?, processed_at=datetime('now') WHERE id=?").run(amount, claim.id);
        await db.prepare("UPDATE clicks SET stage=MAX(stage,5), conv_status='approved', updated_at=datetime('now') WHERE click_id=?").run(claim.click_id);
      }
    }
    return redirect(res, '/admin/claims');
  }
  // ---- Earnings (ADMIN ONLY — upstream payout & margin kabhi public nahi) ----
  if (p === '/admin/earnings' && req.method === 'GET') {
    const sum = async (sql) => ((await db.prepare(sql).get())?.v) || 0;
    const e = {
      upstreamApproved: await sum("SELECT COALESCE(SUM(upstream_payout_paise),0) v FROM conversions WHERE status='approved'"),
      rewardsReleased: await sum("SELECT COALESCE(SUM(user_reward_paise),0) v FROM conversions WHERE status='approved' AND released=1"),
      rewardsPending: await sum("SELECT COALESCE(SUM(user_reward_paise),0) v FROM conversions WHERE status='approved' AND released=0"),
      referralPaid: await sum("SELECT COALESCE(SUM(referral_amount_paise),0) v FROM conversions WHERE status='approved' AND referral_released=1"),
      referralPending: await sum("SELECT COALESCE(SUM(referral_amount_paise),0) v FROM conversions WHERE status='approved' AND referral_released=0"),
      approvedCount: await sum("SELECT COUNT(*) v FROM conversions WHERE status='approved'"),
    };
    e.rewardsApproved = e.rewardsReleased + e.rewardsPending;
    e.referralTotal = e.referralPaid + e.referralPending;
    e.marginApproved = e.upstreamApproved - e.rewardsApproved - e.referralTotal;
    e.marginReleased = await sum("SELECT COALESCE(SUM(upstream_payout_paise),0) v FROM conversions WHERE status='approved' AND released=1") - e.rewardsReleased - e.referralPaid;
    return html(res, 200, await L('Earnings', `<h1>Earnings (sirf admin)</h1><section class="card">
      <p>Approved conversions: <b>${e.approvedCount}</b></p>
      <p>Total upstream payout (approved): <b>${inr(e.upstreamApproved)}</b></p>
      <p>User rewards — released: <b>${inr(e.rewardsReleased)}</b> · release pending: <b>${inr(e.rewardsPending)}</b></p>
      <p>Referral commission — paid: <b>${inr(e.referralPaid)}</b> · pending: <b>${inr(e.referralPending)}</b></p>
      <p>Admin margin (approved basis = payout − user reward − referral): <b>${inr(e.marginApproved)}</b></p>
      <p>Admin margin (released basis): <b>${inr(e.marginReleased)}</b></p>
      <p class="muted">Note: upstream payout network se tabhi final hota hai jab network khud pay kare — yeh numbers approved conversions par based hain.</p></section>`));
  }
  if (p === '/admin/settings' && req.method === 'GET') {
    const feeds = await getFeeds(db);
    const feedCards = feeds.map((f, i) => `<article class="card"><b>${esc(f.name || 'Feed ' + (i + 1))}</b> · ${f.enabled === false ? 'OFF' : 'ON'}
      <p class="muted">URL saved (server only, hidden) · Token: ${f.token ? 'set (hidden)' : 'not set'}</p>
      <form method="post" action="/admin/feeds/${i}/toggle" class="inline"><button class="btn small ghost" type="submit">${f.enabled === false ? 'Enable' : 'Disable'}</button></form>
      <form method="post" action="/admin/feeds/${i}/delete" class="inline"><button class="btn small ghost" type="submit">Delete feed</button></form></article>`).join('');
    return html(res, 200, await L('Settings', `<h1>Settings</h1><form class="card form" method="post" action="/admin/settings">
      <label>Site name<input name="site_name" value="${esc(await getSetting(db, 'site_name', 'CampaignWala'))}"></label>
      <label>Referral commission %<input name="referral_percent" type="number" step="0.1" value="${esc(await getSetting(db, 'referral_percent', '10'))}"></label>
      <label>Minimum withdrawal (₹)<input name="min_withdrawal" type="number" step="0.01" value="${Number(await getSetting(db, 'min_withdrawal_paise', '5000')) / 100}"></label>
      <label>User share % — feed import par user reward = upstream payout ka itna % (baaki admin margin, server only)<input name="user_share_percent" type="number" step="0.1" min="1" max="100" value="${esc(await getSetting(db, 'user_share_percent', '87.5'))}"></label>
      <label>Credit days — approval ke kitne din baad expected wallet credit date (admin release usi ke aas-paas karega)<input name="credit_days" type="number" min="0" value="${esc(await getSetting(db, 'credit_days', '7'))}"></label>
      <label>Postback secret (server only)<input name="postback_secret" value="" placeholder="${(await postbackSecret()) ? 'set (hidden) — blank = no change' : 'not set'}"></label>
      <button class="btn" type="submit">Save Settings</button></form>
      <h2>Campaign Feeds (multi-network, server only)</h2>${feedCards || '<p class="muted">Abhi koi feed nahi hai.</p>'}
      <form class="card form" method="post" action="/admin/feeds/add">
      <label>Feed name<input name="name" required placeholder="e.g. Admitad / OGAds"></label>
      <label>Feed URL<input name="url" required placeholder="https://network.example/feed.json"></label>
      <label>Feed token (optional, server only)<input name="token"></label>
      <button class="btn" type="submit">+ Add Feed</button></form>
      <p class="muted">Postback URL for networks: <code>/api/postback</code> — parameters: click_id, event (tracking/installed/registered/kyc), status (pending/approved/rejected), txn_id, secret (or header x-postback-secret). App ke andar ke steps bhi event postback se hi aage badhte hain.</p>`));
  }
  if (p === '/admin/settings' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.site_name) await setSetting(db, 'site_name', b.site_name);
    if (b.referral_percent !== undefined) await setSetting(db, 'referral_percent', b.referral_percent);
    if (b.min_withdrawal !== undefined) await setSetting(db, 'min_withdrawal_paise', String(Math.round(Number(b.min_withdrawal) * 100)));
    if (b.user_share_percent !== undefined && b.user_share_percent !== '') await setSetting(db, 'user_share_percent', b.user_share_percent);
    if (b.credit_days !== undefined && b.credit_days !== '') await setSetting(db, 'credit_days', b.credit_days);
    if (b.feed_url) await setSetting(db, 'feed_url', b.feed_url);
    if (b.feed_token) await setSetting(db, 'feed_token', b.feed_token);
    if (b.postback_secret) await setSetting(db, 'postback_secret', b.postback_secret);
    return redirect(res, '/admin/settings');
  }
  if (p === '/admin/feeds/add' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.name && b.url) {
      const feeds = await getFeeds(db);
      feeds.push({ name: String(b.name).trim(), url: String(b.url).trim(), token: String(b.token || ''), enabled: true });
      await saveFeeds(db, feeds);
    }
    return redirect(res, '/admin/settings');
  }
  const feedMatch = p.match(/^\/admin\/feeds\/(\d+)\/(toggle|delete)$/);
  if (feedMatch && req.method === 'POST') {
    const feeds = await getFeeds(db);
    const i = Number(feedMatch[1]);
    if (feeds[i]) {
      if (feedMatch[2] === 'toggle') feeds[i].enabled = feeds[i].enabled === false ? true : false;
      else feeds.splice(i, 1);
      await saveFeeds(db, feeds);
    }
    return redirect(res, '/admin/settings');
  }
  return html(res, 404, await L('404', '<h1>Not found</h1>'));
}

const POLICY = {
  privacy: `<article class="card"><h1>Privacy Policy</h1><p>Hum sirf wahi data lete hain jo service chalane ke liye zaroori hai: naam, email, phone, tumhare campaign clicks aur wallet history.</p><p>Tumhara data kisi ko becha nahi jata. Campaign partners ko sirf utni hi jaankari jaati hai jitni tracking aur approval ke liye chahiye (jaise ek anonymous click ID). Password hashed form me store hota hai, plain text me kabhi nahi.</p><p>Login cookie sirf tumhe logged-in rakhne ke liye use hoti hai. Tum kabhi bhi support se apna data delete karne ko keh sakte ho.</p></article>`,
  terms: `<article class="card"><h1>Terms</h1><p>Har campaign ke apne rules hote hain — jaise sirf naye users, ek device se ek hi baar. Rules todne par partner campaign ko reject kar sakta hai.</p><p>Wallet me dikh raha Pending balance final nahi hota. Partner approval ke baad amount <b>Approved</b> ho jata hai aur tumhe ek expected wallet credit date dikhti hai; admin us date ke aas-paas amount release karta hai, tabhi woh Withdrawable banta hai. Galat ya fraud activity par account band ho sakta hai aur pending balance ruk sakta hai.</p><p>Ek person ke multiple accounts allowed nahi hain. Apna account kisi aur ke saath share mat karo.</p></article>`,
  refund: `<article class="card"><h1>Refund &amp; Rejection Policy</h1><h2>Pending matlab kya hai?</h2><p>Jab tum campaign complete karte ho, pehle amount <b>Pending</b> me jata hai. Partner (advertiser/network) pehle check karta hai ki sab rules follow hue — naya user, sahi KYC, duplicate nahi. Isme kuch ghante se kuch din lag sakte hain.</p><h2>Approved — paisa wallet me kab ayega?</h2><p>Partner approve kare to amount <b>Approved</b> ho jata hai aur campaign ki progress screen par ek <b>expected wallet credit date</b> dikhti hai (aam taur par approval ke 7 din baad). Admin us date ke aas-paas amount manually release karta hai — release hote hi amount <b>Withdrawable</b> me aa jata hai, phir tum UPI, bank ya gift card me withdrawal maang sakte ho.</p><h2>Rejected — paisa kyun rukta hai?</h2><p>Agar partner reject kar de — purana user, duplicate device/account, KYC incomplete, VPN/emulator use, ya campaign ka daily limit khatm — to pending amount hata diya jata hai. Yeh paisa hamare paas aata hi nahi, isliye hum use credit nahi kar sakte. Yeh koi fee ya katauti nahi hai.</p><h2>Withdrawal refund</h2><p>Agar tumhara withdrawal kisi wajah se reject hota hai (galat UPI ID waghera), pura amount tumhare wallet me wapas aa jata hai — koi charge nahi. Sahi details ke saath dobara request kar sakte ho.</p><h2>Galti lage to?</h2><p>Agar tumhe lagta hai tracking sahi hone ke baad bhi campaign reject hua, My Campaigns me us campaign ki progress screen ka screenshot lekar support ko bhejo. Hum network ke saath dobara check karenge.</p></article>`,
};

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => console.log(`Campaign website listening on :${PORT} (db: ${db.mode}${db.mode === 'pg' ? ', schema: campaign' : ': ' + DB_PATH})`));
  // Retention: once on boot, then daily. Raw tracking data purges at 30 days;
  // financial records only 60 days after their case fully closes, and never
  // while the account holds a balance or an open state (see src/retention.js).
  const cleanup = () => runRetention(db)
    .then(r => console.log('[retention]', JSON.stringify(r)))
    .catch(e => console.error('[retention]', e.message));
  cleanup();
  setInterval(cleanup, 24 * 3600 * 1000).unref();
}
export { server, db };
