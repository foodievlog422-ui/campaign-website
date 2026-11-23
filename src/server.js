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
// Short day label for sqlite datetime strings ('YYYY-MM-DD HH:MM:SS').
const fmtDay = (ts) => {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T'));
  return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
// Inline SVG icons (Lucide-style, stroke=currentColor) — V6 design system.
const ic = (paths, size = 16) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const I = {
  shield: ic('<path d="M12 3l7 2.8V11c0 4.6-3 7.9-7 9.5C8 18.9 5 15.6 5 11V5.8z"/><path d="m9 11.5 2 2 4-4"/>'),
  badge: ic('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>'),
  wallet: ic('<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>'),
  arrowR: ic('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>', 15),
  arrowUR: ic('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>', 13),
  chevR: ic('<path d="m9 18 6-6-6-6"/>', 15),
  back: ic('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>', 13),
  clock: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  check: ic('<path d="M20 6 9 17l-5-5"/>', 13),
  gift: ic('<rect x="3" y="8" width="18" height="4"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>', 17),
  ext: ic('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>', 15),
  lock: ic('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 13),
  spark: ic('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>', 18),
  arrowD: ic('<path d="M12 4v16"/><path d="m19 13-7 7-7-7"/>', 18),
  menu: ic('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>', 17),
  users: ic('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20v-1.5A4.5 4.5 0 0 1 7 14h4a4.5 4.5 0 0 1 4.5 4.5V20"/><path d="M16 5a3.5 3.5 0 0 1 0 6.5"/><path d="M21.5 20v-1.5a4.5 4.5 0 0 0-3-4.3"/>'),
  clip: ic('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
  refresh: ic('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>', 12),
  download: ic('<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 21h16"/>', 12),
  sliders: ic('<path d="M4 6h9"/><path d="M17 6h3"/><circle cx="15" cy="6" r="2"/><path d="M4 12h3"/><path d="M11 12h9"/><circle cx="9" cy="12" r="2"/><path d="M4 18h11"/><path d="M19 18h1"/><circle cx="17" cy="18" r="2"/>', 15),
  help: ic('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4"/><path d="M12 17h.01"/>', 14),
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

async function layout(user, title, body, opts = {}) {
  const site = esc(await getSetting(db, 'site_name', 'CampaignWala'));
  const firstName = user ? esc(String(user.name || '').trim().split(/\s+/)[0]) : '';
  const memberLinks = user ? `<a href="/my">My Dashboard</a><a href="/wallet">${I.wallet}Wallet</a>${user.is_admin ? '<a href="/admin">Admin</a>' : ''}` : '';
  const nav = `<a href="/#campaigns">Campaigns</a><a href="/#how-it-works">How it works</a>${memberLinks}`;
  const actions = user
    ? `<span class="hi">Hi, ${firstName}</span><form method="post" action="/logout" class="inline"><button class="btn-logout" type="submit">Log out</button></form>`
    : `<a class="login-link" href="/login">Login</a><a class="btn small" href="/signup">Sign up <span aria-hidden="true">↗</span></a>`;
  const mnav = `<details class="mmenu"><summary aria-label="Open navigation">${I.menu}</summary><nav>
    <a href="/#campaigns">Campaigns</a><a href="/#how-it-works">How it works</a>${user ? '<a href="/my">My Dashboard</a><a href="/wallet">Wallet</a>' + (user.is_admin ? '<a href="/admin">Admin</a>' : '') : '<a href="/login">Login</a><a href="/signup">Sign up</a>'}
  </nav></details>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${site}</title><meta name="mitgo-verification" content="e97a990a-6417-4648-983f-b821ae013a95"><meta name="mylead-verification" content="ba856886239dedcc56ca0541621fdb50"><meta name="theme-color" content="#ffffff"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css"></head><body>
<header class="site"><div class="wrap-wide head"><a class="logo" href="/" aria-label="${site} home"><span class="mark">₹</span>${site}</a><nav class="main" aria-label="Main navigation">${nav}</nav><div class="head-actions">${actions}${mnav}</div></div></header>
${opts.raw ? `<main>${body}</main>` : `<main><div class="wrap page">${body}</div></main>`}
<footer class="site"><div class="wrap-wide foot"><a class="flogo" href="/"><span class="mark">₹</span>${site}</a><nav aria-label="Legal"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms</a><a href="/refund-policy">Refund &amp; Rejection Policy</a><a href="https://t.me/+66DYjnIvwVYwMjBl" target="_blank" rel="noopener">Join our Telegram Channel ${I.arrowUR}</a></nav><span class="copy">© 2026 ${site}</span></div></footer>
</body></html>`;
}

// ---------- inline form errors (V4) ----------
// Auth/user form failures re-render THE SAME form: the message sits in red
// directly under the field it belongs to and the field border turns red.
// Entered values are preserved (passwords are NEVER echoed back).
const ferr = (errs, name) => (errs && errs[name] ? `<p class="ferr">${esc(errs[name])}</p>` : '');
const inv = (errs, name) => (errs && errs[name] ? ' class="invalid"' : '');

function loginForm({ email = '', errs = {}, remember = false } = {}) {
  const credErr = errs.credentials || '';
  const eErrs = credErr ? { ...errs, email: credErr } : errs;
  const pErrs = credErr ? { ...errs, password: credErr } : errs;
  return `<div class="authwrap"><section class="card authcard"><div class="brandmark">₹</div>
  <h1>Welcome back</h1><p class="muted">Login karo — apne campaigns, progress aur wallet yahi milenge.</p>
  <form class="form" method="post" action="/login">
    <label>Email<input name="email" type="email" required autocomplete="email" value="${esc(email)}"${inv(eErrs, 'email')}>${ferr(eErrs, 'email')}</label>
    <label>Password<input name="password" type="password" required autocomplete="current-password"${inv(pErrs, 'password')}>${ferr(pErrs, 'password')}</label>
    <label class="check"><input type="checkbox" name="remember" value="1"${remember ? ' checked' : ''}> Remember me for 30 days</label>
    <button class="btn block" type="submit">Login</button></form>
  <p class="muted center">Naya account banana hai? <a href="/signup">Sign up karo</a></p></section></div>`;
}

function signupForm({ name = '', email = '', phone = '', ref = '', errs = {}, remember = false } = {}) {
  return `<div class="authwrap"><section class="card authcard"><div class="brandmark">₹</div>
  <h1>Create account</h1><p class="muted">Free account banao, campaign complete karo aur wallet se paisa nikalo.</p>
  <form class="form" method="post" action="/signup">
    <label>Name<input name="name" required autocomplete="name" value="${esc(name)}"${inv(errs, 'name')}>${ferr(errs, 'name')}</label>
    <label>Email<input name="email" type="email" required autocomplete="email" value="${esc(email)}"${inv(errs, 'email')}>${ferr(errs, 'email')}</label>
    <label>Phone<input name="phone" autocomplete="tel" value="${esc(phone)}"${inv(errs, 'phone')}>${ferr(errs, 'phone')}</label>
    <label>Password<input name="password" type="password" required minlength="8" autocomplete="new-password"${inv(errs, 'password')}>${ferr(errs, 'password')}</label>
    <label>Referral code (optional)<input name="ref" value="${esc(ref)}"></label>
    <label class="check"><input type="checkbox" name="remember" value="1"${remember ? ' checked' : ''}> Remember me for 30 days</label>
    <button class="btn block" type="submit">Sign up</button></form>
  <p class="muted center">Pehle se account hai? <a href="/login">Login karo</a></p></section></div>`;
}
function stepperHtml(click) {
  const items = STAGES.map((label, i) => {
    const done = i <= click.stage && click.conv_status !== 'rejected';
    const rejectedNote = click.conv_status === 'rejected' && i === 5;
    const cls = rejectedNote ? 'bad' : done ? 'done' : (i === click.stage + 1 && click.conv_status !== 'rejected' ? 'current' : '');
    const inner = rejectedNote ? '✕' : done ? '✓' : i + 1;
    return `<li class="${cls}"><span class="sdot">${inner}</span><span class="slbl">${esc(label)}${rejectedNote ? ' — Rejected by partner' : ''}</span></li>`;
  }).join('');
  return `<ol class="stepper">${items}</ol>`;
}
// Friendly status pill for a user's campaign (dashboard rows + progress head).
function statusPill(cl) {
  if (cl.conv_status === 'rejected' || cl.conv_status === 'claim_rejected') return '<span class="pill red">Rejected</span>';
  if (cl.stage >= 6) return '<span class="pill black">Credited</span>';
  if (cl.conv_status === 'approved') return '<span class="pill black">Approved</span>';
  if (cl.conv_status === 'claim_submitted') return '<span class="pill grey">Claim in review</span>';
  return '<span class="pill grey">In review</span>';
}
const publicList = async () => (await db.prepare('SELECT * FROM campaigns WHERE is_live=1 AND hide_from_list=0 ORDER BY id DESC').all()).map(publicCampaign);

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
      const list = await publicList();
      const rows = list.map(c => `<article class="camp-row"><div class="icon">${esc(c.icon_text)}</div>
        <div class="grow"><h3>${esc(c.title)}</h3><span class="cat-chip">${esc(c.category)}</span><p class="desc">${esc(c.description)}</p><p class="meta">${esc(c.geo)} <span style="color:#c4c4c4">·</span> <span class="dotlive"></span> Live</p></div>
        <div class="camp-side"><div><span class="get">You get</span><span class="amt">${esc(rewardLabel(c))}</span></div><a class="btn small ghost" href="/campaign/${c.id}">Details ${I.chevR}</a></div></article>`).join('');
      const empty = `<div class="empty"><div class="ring">₹</div><h3>Campaigns jald aa rahe hain</h3>
        <p class="muted">Abhi naye campaigns taiyaar ho rahe hain. Thodi der me dobara check karo — achhe offers sabse pehle yahi dikhenge.</p>
        ${user ? '' : '<p class="mt14"><a class="btn" href="/signup">Free account banao</a></p>'}</div>`;
      const first = list[0];
      const preview = `<div class="wprev-wrap"><span class="deco a"></span><span class="deco b"></span><div class="wprev">
        <div class="wp-top"><div><span class="wp-label">Your campaign wallet</span><div class="wp-amt">₹1,250<small>earned</small></div></div><span class="wp-ic">${I.wallet}</span></div>
        <div class="wp-prog"><b>Campaign progress</b><span>2 of 3 steps</span></div>
        <div class="wp-bar"><i class="on"></i><i class="on"></i><i></i></div>
        ${first ? `<div class="wp-row"><span class="icon" style="flex-basis:36px;width:36px;height:36px;font-size:12px;border-radius:8px">${esc(first.icon_text)}</span><div style="min-width:0"><p class="t">${esc(first.title)}</p><p class="s">KYC verification · In review</p></div><span class="a">${esc(rewardLabel(first))}</span></div>` : ''}
        <div class="wp-next"><span class="tick">${I.check}</span> Next: partner approval</div></div>
        <span class="float-badge"><i></i> Live tracking</span></div>`;
      return html(res, 200, await layout(user, 'Live Campaigns', `
      <section class="hero6"><div class="wrap-wide hero-grid"><div>
        <span class="eyebrow">Campaigns · Rewards · You</span>
        <h1>Campaigns complete karo, <span class="dim">paisa kamao.</span></h1>
        <p class="lede">Apne favourite brands ke simple tasks poore karo. Har step track karo aur apni earning seedha wallet mein dekho.</p>
        <div class="hero-cta">${user ? `<a class="btn" href="/my">My Dashboard ${I.arrowR}</a><a class="btn ghost" href="/wallet">Wallet dekho</a>` : `<a class="btn" href="/signup">Free account banao ${I.arrowR}</a><a class="btn ghost" href="/login">Login</a>`}</div>
        <div class="trustrow"><span>${I.shield} Wallet mein safe balance</span><span>${I.badge} Har step ki live tracking</span><span>${I.wallet} UPI · Bank · Gift Card</span></div>
      </div>${preview}</div></section>
      <section class="how" id="how-it-works"><div class="wrap-wide">
        <div class="how-head"><div class="sec-head"><span class="eyebrow">Simple as 1 · 2 · 3</span><h2>Kaise kaam karta hai</h2><p>Bas teen simple steps. Progress aur reward ki har update tumhare dashboard par.</p></div><a class="shuru" href="${user ? '/my' : '/signup'}">Shuru karo ${I.arrowUR}</a></div>
        <div class="steps3">
          <article class="step3"><div class="row"><span class="sicon">${I.spark}</span><span class="snum">01</span></div><h3>Campaign chuno</h3><p>Apne liye sahi offer dekho aur uske steps samjho.</p></article>
          <article class="step3"><div class="row"><span class="sicon">${I.check}</span><span class="snum">02</span></div><h3>Steps complete karo</h3><p>Partner ki site ya app par task poora karo. Hum progress track karenge.</p></article>
          <article class="step3"><div class="row"><span class="sicon">${I.arrowD}</span><span class="snum">03</span></div><h3>Paisa withdraw karo</h3><p>Approval ke baad reward wallet mein aayega. UPI ya bank se nikaalo.</p></article>
        </div></div></section>
      <section class="campsec" id="campaigns"><div class="wrap-wide">
        <div class="campsec-head"><div class="sec-head flush"><span class="eyebrow">Hand-picked for you</span><h2>Live Campaigns</h2><p>Naye offers aate rehte hain — apna next reward dhoondo.</p></div>${list.length ? `<span class="livepill"><i></i> ${list.length} campaigns live</span>` : ''}</div>
        <div class="camp-list">${rows || empty}</div>
        <p class="locknote">${I.lock} Campaign terms apply. Rewards are credited after partner verification.</p>
      </div></section>
      <section class="ctaband"><div class="wrap-wide"><div class="band"><div><p class="kicker">Your next reward is waiting</p><h2>Ready to get started?</h2></div>${user ? `<a class="btn white" href="/my">Go to dashboard ${I.arrowR}</a>` : `<a class="btn white" href="/signup">Create free account ${I.arrowR}</a>`}</div></div></section>`, { raw: true }));
    }
    if (p.startsWith('/campaign/') && req.method === 'GET') {
      const c = await db.prepare('SELECT * FROM campaigns WHERE id=? AND is_live=1').get(p.split('/')[2]);
      if (!c) return html(res, 404, await layout(user, 'Not found', '<h1>Campaign not found</h1>'));
      const pub = publicCampaign(c);
      // A hidden "extra" campaign sharing this campaign's link (e.g. the F&O
      // bonus under the demat campaign) is offered from this page only.
      const extra = c.link_url ? await db.prepare('SELECT * FROM campaigns WHERE is_live=1 AND hide_from_list=1 AND link_url=? AND id<>? ORDER BY id LIMIT 1').get(c.link_url, c.id) : null;
      return html(res, 200, await layout(user, pub.title, `
        <a class="backlink" href="/#campaigns">${I.back} All campaigns</a>
        <div class="detail-head"><div class="icon big">${esc(pub.icon_text)}</div>
          <div style="min-width:0;flex:1"><h1>${esc(pub.title)}</h1><span class="cat-chip" style="margin-left:0">${esc(pub.category)}</span><p class="meta">${esc(pub.geo)} <span style="color:#bbb">·</span> <span class="dotlive"></span> Live now</p></div></div>
        <p style="margin-top:28px;font-size:14.5px;line-height:1.75;color:#666">${esc(pub.description)} We'll keep you updated as each step is verified.</p>
        <div class="reward-band"><div><p class="lbl">Campaign complete karne par tumhe milega</p><p class="amt">${esc(rewardLabel(pub))}</p>
        ${pub.reward_mode === 'random' ? '<p class="muted small" style="margin:6px 0 0">Random reward hai — exact amount campaign approve hone ke time decide hoga, is range ke andar hi milega.</p>' : ''}</div>
        <span class="when">${I.clock} Partner verification ke baad</span></div>
        ${extra ? `<div class="reward-band" style="border-style:dashed"><div><p class="lbl">Extra kamaai — isi account par</p><p class="amt" style="font-size:24px">${esc(rewardLabel(extra))} extra</p><p class="muted small" style="margin-top:6px">${esc(extra.title)} — neeche wala campaign khol kar iske steps dekho.</p></div><a class="btn ghost" href="/campaign/${extra.id}">Extra campaign ${I.chevR}</a></div>` : ''}
        ${pub.campaign_type === 'custom' ? '<p class="notebox">Yeh manual verification campaign hai. Task ke baad apni details submit karo — team claim review karegi. Start karke link se task complete karo, phir apni progress page se claim submit karo.</p>' : ''}
        <h2 style="font-size:16px;margin-top:36px">Steps — aise complete hoga</h2><ol class="steps-list2">${pub.steps.map((s, i) => `<li><span class="n">${i + 1}</span><span class="t">${esc(s)}</span></li>`).join('')}</ol>
        <section class="rules2"><h2>Campaign rules</h2><ul>${String(pub.rules || '').split('\n').map(r => r.trim()).filter(Boolean).map(r => `<li>${esc(r)}</li>`).join('')}</ul></section>
        <div class="startcard"><div class="row"><span class="sic">${I.shield}</span><div><p class="t">Your progress stays transparent</p><p class="s">Campaign start karne ke baad har update tumhari progress timeline mein dikhegi.</p></div></div>
        ${user ? `<form method="post" action="/campaign/${pub.id}/start" style="margin-top:16px"><button class="btn block tall" type="submit">Start Campaign ${I.arrowR}</button></form>` : `<a class="btn block tall" href="/login" style="margin-top:16px">Login karke start karo ${I.arrowR}</a>`}
        <p class="fineprint">Start karne par partner ki website naye tab mein khulegi.</p></div>`));
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

    // Auth — failures re-render the SAME form with red inline errors under
    // the field at fault (V4). No separate error page, password never echoed.
    if (p === '/signup' && req.method === 'GET') {
      const ref = url.searchParams.get('ref') || parseCookies(req).ref || '';
      return html(res, 200, await layout(null, 'Sign up', signupForm({ ref })));
    }
    if (p === '/signup' && req.method === 'POST') {
      const b = await readBody(req);
      const vals = { name: b.name || '', email: b.email || '', phone: b.phone || '', ref: b.ref || '', remember: b.remember === '1' };
      const errs = {};
      if (!String(vals.name).trim()) errs.name = 'Apna naam likho.';
      if (!String(vals.email).trim()) errs.email = 'Email likho.';
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(vals.email).trim())) errs.email = 'Yeh email sahi nahi lag raha — dobara check karo.';
      if (!b.password) errs.password = 'Password rakho.';
      else if (String(b.password).length < 8) errs.password = 'Password kam se kam 8 characters ka rakho.';
      if (!errs.email && await db.prepare('SELECT id FROM users WHERE email=?').get(String(vals.email).toLowerCase()))
        errs.email = 'Is email se account pehle se hai — neeche se login karo.';
      if (Object.keys(errs).length) return html(res, 200, await layout(null, 'Sign up', signupForm({ ...vals, errs })));
      const referrer = b.ref ? await db.prepare('SELECT id FROM users WHERE referral_code=?').get(String(b.ref).trim().toUpperCase()) : null;
      const info = await db.prepare('INSERT INTO users(name,email,phone,pass_hash,referral_code,referred_by) VALUES(?,?,?,?,?,?)')
        .run(String(vals.name).trim(), String(vals.email).toLowerCase(), vals.phone || '', hashPassword(b.password), randomCode(8), referrer ? referrer.id : null);
      const cookie = await startSession(res, Number(info.lastInsertRowid), b.remember === '1');
      return redirect(res, '/my', { 'Set-Cookie': cookie });
    }
    if (p === '/login' && req.method === 'GET') return html(res, 200, await layout(null, 'Login', loginForm()));
    if (p === '/login' && req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim();
      const u = await db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase());
      if (!u || !verifyPassword(b.password || '', u.pass_hash)) {
        // Same generic message for unknown email / wrong password, shown in
        // red under BOTH fields so the user sees exactly what to re-check.
        const errs = { credentials: 'Email ya password galat hai — dobara check karke try karo.' };
        if (!email) errs.email = 'Email likho.';
        return html(res, 200, await layout(null, 'Login', loginForm({ email, errs, remember: b.remember === '1' })));
      }
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
      const mine = await db.prepare('SELECT cl.*, c.title, c.icon_text, c.user_reward_paise, c.reward_mode, c.reward_min_paise, c.reward_max_paise FROM clicks cl JOIN campaigns c ON c.id=cl.campaign_id WHERE cl.user_id=? ORDER BY cl.id DESC').all(user.id);
      const list = mine.map(cl => `<a class="mycamp-row" href="/my/campaigns/${esc(cl.click_id)}"><span class="icon" style="flex-basis:40px;width:40px;height:40px;font-size:11px;border-radius:8px">${esc(cl.icon_text || 'C')}</span>
        <span style="min-width:0;flex:1"><span class="t">${esc(cl.title)}</span><span class="s">Started ${esc(fmtDay(cl.created_at))} · ${esc(STAGES[cl.stage])}</span></span>
        <span class="right">${statusPill(cl)}<span class="amt">${esc(rewardLabel(cl))}</span>${I.chevR}</span></a>`).join('');
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const refLink = `${proto}://${req.headers.host}/r/${user.referral_code}`;
      const refPct = esc(await getSetting(db, 'referral_percent', '10'));
      const refEarned = ((await db.prepare("SELECT COALESCE(SUM(amount_paise),0) v FROM wallet_ledger WHERE user_id=? AND kind IN ('referral_pending_release','referral_credit')").get(user.id)) || {}).v || 0;
      const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const hr = nowIST.getHours();
      const greetWord = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
      const dateLine = nowIST.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
      const firstName = esc(String(user.name || '').trim().split(/\s+/)[0]);
      return html(res, 200, await layout(user, 'My Dashboard', `
        <div class="dash-head"><div><p class="greet-date">${esc(dateLine)}</p><h1 class="greet">${greetWord}, ${firstName}<span class="dot">.</span></h1><p class="muted" style="margin:8px 0 0;font-size:12.5px">Yahan se apne campaigns aur earnings track karo.</p></div>
        <a class="btn" href="/#campaigns">Explore campaigns ${I.arrowR}</a></div>
        <section class="balances" aria-label="Wallet balances">
          <article class="bal"><div class="top"><span class="lbl">Pending</span><span class="bic">${I.clock}</span></div><p class="amt">${inr(user.pending_paise)}</p><p class="hint">Partner approval ka wait ho raha hai</p></article>
          <article class="bal"><div class="top"><span class="lbl">Approved · release pending</span><span class="bic">${I.check}</span></div><p class="amt">${inr(user.approved_paise)}</p><p class="hint">Approve ho gaya — admin expected date par release karega</p></article>
          <article class="bal dark"><div class="top"><span class="lbl">Withdrawable</span><span class="bic">${I.wallet}</span></div><p class="amt">${inr(user.withdrawable_paise)}</p><p class="hint">Yeh paisa abhi withdraw kar sakte ho</p></article>
        </section>
        <p class="sr-only">Pending: <b>${inr(user.pending_paise)}</b> · Approved (release pending): <b>${inr(user.approved_paise)}</b> · Withdrawable: <b>${inr(user.withdrawable_paise)}</b></p>
        <div class="openwallet"><a href="/wallet">Open wallet ${I.arrowUR}</a></div>
        <section class="refpanel"><div class="row"><div class="who"><span class="gic">${I.gift}</span><div><h2>Refer &amp; earn</h2><p class="sub">Tumhare link se join karke jab dost ka campaign approve hoga, tumhe ${refPct}% commission milega.</p></div></div>
        <div class="earn"><p class="earn-lbl">Referral earnings</p><p class="earn-amt">${inr(refEarned)}</p></div></div>
        <div class="refbox"><span class="lnk" id="refLink">${esc(refLink)}</span><button class="copybtn" type="button" id="copyRef">Copy link</button></div>
        <p class="muted small" style="margin:10px 0 0">Code: ${esc(user.referral_code)}</p></section>
        <div class="mycamp-head"><div><p class="kick">Your activity</p><h2>My Campaigns ${mine.length ? `<span class="cnt">(${mine.length})</span>` : ''}</h2></div><a href="/#campaigns">Browse all ${I.chevR}</a></div>
        ${list ? `<div class="mycamp-list">${list}</div>` : '<div class="empty"><div class="ring">₹</div><h3>Abhi koi campaign start nahi kiya</h3><p class="muted">Home page se koi live campaign chuno aur Start dabao — progress yahi dikhega.</p><p style="margin-top:12px"><a class="btn small" href="/#campaigns">Campaigns dekho</a></p></div>'}
        <script>document.getElementById('copyRef').addEventListener('click',function(){var t=document.getElementById('refLink').textContent;var b=this;function ok(){b.textContent='Copied ✓';setTimeout(function(){b.textContent='Copy link'},1600)}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok).catch(ok)}else{ok()}});</script>`));
    }
    if (p.startsWith('/my/campaigns/') && req.method === 'GET') {
      if (!user) return redirect(res, '/login');
      const clickId = p.split('/')[3];
      const cl = await db.prepare('SELECT cl.*, c.title, c.icon_text, c.user_reward_paise, c.campaign_type, c.reward_mode, c.reward_min_paise, c.reward_max_paise, c.link_url FROM clicks cl JOIN campaigns c ON c.id=cl.campaign_id WHERE cl.click_id=? AND cl.user_id=?').get(clickId, user.id);
      if (!cl) return html(res, 404, await layout(user, 'Not found', '<h1>Not found</h1>'));
      const conv = await db.prepare('SELECT * FROM conversions WHERE click_id=?').get(clickId);
      const claim = await db.prepare('SELECT * FROM claims WHERE click_id=?').get(clickId);
      const rewardText = cl.campaign_type === 'custom' && claim && claim.status === 'approved'
        ? inr(claim.rolled_reward_paise)
        : esc(rewardLabel(cl));
      let extra = '';
      // Status strip inside the stepper card — message follows the live state.
      let strip;
      if (cl.conv_status === 'rejected') {
        strip = `<div class="status-strip"><span class="sic">${I.clock}</span><div style="flex:1"><p class="t">Campaign partner ne reject kar diya</p><p class="s">Rules check me kuch match nahi hua. Details ke liye Refund &amp; Rejection Policy dekho.</p></div></div>`;
      } else if (conv && conv.released) {
        strip = `<div class="status-strip"><span class="sic">${I.check}</span><div style="flex:1"><p class="t">Paisa wallet me credit ho gaya hai</p><p class="s">💰 Amount ab Withdrawable hai — <a href="/wallet">Wallet dekho</a></p></div></div>`;
      } else if (conv && conv.status === 'approved' && !conv.released) {
        strip = `<div class="status-strip"><span class="sic">${I.check}</span><div style="flex:1"><p class="t">✅ Approved! Partner ne confirm kar diya</p><p class="s">Expected wallet credit date: <b id="creditDate">${esc(fmtDate(conv.expected_credit_date))}</b> — admin is date ke aas-paas amount release karega, tab woh Withdrawable hoga.</p></div></div>`;
      } else {
        strip = `<div class="status-strip"><span class="sic">${I.clock}</span><div style="flex:1"><p class="t">Partner verification in progress</p><p class="s">Tumhara task submit ho gaya hai. Update milte hi timeline aage badhegi.</p></div><span class="when">Status: <span id="convStatus">${esc(cl.conv_status === 'none' ? 'started' : cl.conv_status)}</span></span></div>`;
      }
      if (cl.link_url) extra += `<section class="partner-card"><div class="who"><span class="pic">${I.ext}</span><div><p class="t">Need to finish the partner task?</p><p class="s">Campaign open karo aur required steps complete karo.</p></div></div><a class="btn small ghost" href="/go/${esc(cl.click_id)}" target="_blank" rel="noopener">Open partner link ${I.ext}</a></section>`;
      if (cl.campaign_type === 'custom') {
        const claimErr = url.searchParams.get('claim_error') === 'note';
        const noteErrHtml = claimErr ? '<p class="ferr">Note likhna zaroori hai — kya kiya, kis number/ID se, short me likho.</p>' : '';
        const claimForm = (btnLabel) => `<form class="form" method="post" action="/my/campaigns/${esc(cl.click_id)}/claim">
            <label>Note (kya kiya, kis number/ID se)<textarea name="note" required rows="3"${claimErr ? ' class="invalid"' : ''}></textarea>${noteErrHtml}</label>
            <label>Proof link (screenshot ka link, optional)<input name="proof_url" type="url" placeholder="https://..."></label>
            <button class="btn" type="submit">${btnLabel}</button></form>`;
        if (!claim) {
          extra += `<h2>Task complete kar liya? Claim karo</h2>${claimForm('Claim Submit Karo')}`;
        } else if (claim.status === 'pending') {
          extra += `<p class="notice">📩 Tumhara claim submit ho gaya hai. Admin verify karke approve/reject karega — status yahi dikhega.</p>`;
        } else if (claim.status === 'approved') {
          extra += `<p class="notice">✅ Claim approved — reward: <b>${inr(claim.rolled_reward_paise)}</b>. Upar wali expected date par wallet me release hoga.</p>`;
        } else if (claim.status === 'rejected') {
          extra += `<p class="notice bad">❌ Claim reject ho gaya. Reason: <b>${esc(claim.reject_reason || '—')}</b></p>
          <h2>Dobara claim karo</h2>${claimForm('Claim Dobara Submit Karo')}`;
        }
      }
      return html(res, 200, await layout(user, 'Progress', `
        <a class="backlink" href="/my" style="margin-bottom:0">${I.back} Back to dashboard</a>
        <div class="prog-head"><div class="who"><span class="icon" style="flex-basis:44px;width:44px;height:44px;font-size:11px;border-radius:8px">${esc(cl.icon_text || 'C')}</span><div><p class="kick">Campaign progress</p><h1>${esc(cl.title)}</h1></div></div>${statusPill(cl)}</div>
        <p class="muted" style="margin:14px 0 0">Reward: <b style="color:var(--ink)">${rewardText}</b></p>
        <section class="stepper-card"><div class="sc-head"><div><p class="kick">Live timeline</p><h2>Your campaign journey</h2></div><span class="auto-note"><i></i> Updates automatically</span></div>
        <div id="timeline">${stepperHtml(cl)}</div>${strip}</section>
        ${extra}
        <p style="display:flex;gap:8px;align-items:flex-start;font-size:10.5px;line-height:1.6;color:#878787;margin-top:16px">${I.shield}<span>Reward approval ke baad expected wallet credit date yahan dikhegi. Yeh page har kuch seconds me khud update hota hai — jo step ho gaya woh ✓, jo baki hai woh number me dikhega.</span></p>
        <script src="/app.js"></script><script>watchProgress(${JSON.stringify(clickId)})</script>`));
    }
    if (p.match(/^\/my\/campaigns\/[^/]+\/claim$/) && req.method === 'POST') {
      if (!user) return redirect(res, '/login');
      const clickId = p.split('/')[3];
      const cl = await db.prepare('SELECT cl.*, c.campaign_type FROM clicks cl JOIN campaigns c ON c.id=cl.campaign_id WHERE cl.click_id=? AND cl.user_id=?').get(clickId, user.id);
      if (!cl) return html(res, 404, await layout(user, 'Not found', '<h1>Not found</h1>'));
      if (cl.campaign_type !== 'custom') return redirect(res, `/my/campaigns/${clickId}`);
      const b = await readBody(req);
      // Empty note: back to the SAME progress page, red error under the field.
      if (!b.note || !String(b.note).trim()) return redirect(res, `/my/campaigns/${clickId}?claim_error=note`);
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
    // Wallet page is a function so a failed withdraw can re-render THE SAME
    // page with red inline errors + preserved values (V4).
    const walletPage = async (errs = {}, vals = {}) => {
      const fresh = await db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
      const min = Number(await getSetting(db, 'min_withdrawal_paise', '5000'));
      const wds = await db.prepare('SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC').all(user.id);
      const ledger = await db.prepare('SELECT * FROM wallet_ledger WHERE user_id=? ORDER BY id DESC LIMIT 20').all(user.id);
      const approvedList = await db.prepare(`SELECT cv.user_reward_paise, cv.expected_credit_date, c.title FROM conversions cv
        JOIN clicks cl ON cl.click_id=cv.click_id JOIN campaigns c ON c.id=cl.campaign_id
        WHERE cl.user_id=? AND cv.status='approved' AND cv.released=0 ORDER BY cv.expected_credit_date`).all(user.id);
      const sel = (m) => (vals.method === m ? ' selected' : '');
      const kindMap = {
        pending_credit: ['Campaign reward', 'Pending'],
        approved_pending_release: ['Reward approved', 'Release pending'],
        wallet_release: ['Reward released', 'Withdrawable'],
        referral_pending_release: ['Referral commission', 'Release pending'],
        referral_credit: ['Referral commission released', 'Withdrawable'],
        rejected_reversal: ['Reward reversed', 'Rejected'],
        withdrawal_hold: ['Withdrawal requested', 'Processing'],
        withdrawal_refund: ['Withdrawal refund', 'Returned to wallet'],
      };
      const signed = (p) => (p < 0 ? '−' : '+') + inr(Math.abs(p));
      const activity = ledger.map(l => {
        const km = kindMap[l.kind] || [l.kind, ''];
        return `<div class="entry"><span class="aic">${I.arrowUR}</span><div style="min-width:0;flex:1"><p class="t">${esc(km[0])}</p><p class="s">${esc(l.created_at)}${km[1] ? ' · ' + esc(km[1]) : ''}</p></div><span class="amt">${signed(l.amount_paise)}</span></div>`;
      }).join('');
      return layout(user, 'Wallet', `
        <div class="dash-head"><div><p class="greet-date">Account / Wallet</p><h1 class="greet" style="font-size:30px">Wallet</h1><p class="muted" style="margin:8px 0 0;font-size:12.5px;max-width:450px">Earnings yahan jama hoti hain. Approved reward ki date ke baad withdraw request bhejo.</p></div><span class="bic" style="width:40px;height:40px;border-radius:9px;background:#F4F4F4;display:flex;align-items:center;justify-content:center">${I.wallet}</span></div>
        <section class="balances" aria-label="Wallet balances">
          <article class="bal"><div class="top"><span class="lbl">Pending</span><span class="bic">${I.clock}</span></div><p class="amt" style="font-size:22px">${inr(fresh.pending_paise)}</p><p class="hint">Partner approval ka wait ho raha hai</p></article>
          <article class="bal"><div class="top"><span class="lbl">Approved · release pending</span><span class="bic">${I.check}</span></div><p class="amt" style="font-size:22px">${inr(fresh.approved_paise)}</p><p class="hint">Approve ho gaya — admin expected date par release karega</p></article>
          <article class="bal dark"><div class="top"><span class="lbl">Withdrawable</span><span class="bic">${I.wallet}</span></div><p class="amt" style="font-size:22px">${inr(fresh.withdrawable_paise)}</p><p class="hint">Abhi withdraw kar sakte ho</p></article>
        </section>
        <p class="sr-only">Pending: <b>${inr(fresh.pending_paise)}</b> · Approved (release pending): <b>${inr(fresh.approved_paise)}</b> · Withdrawable balance: <b>${inr(fresh.withdrawable_paise)}</b></p>
        ${approvedList.length ? `<div class="notebox" style="margin-top:16px">${approvedList.map(a => `<p style="margin:2px 0">• ${esc(a.title)} — ${inr(a.user_reward_paise)} · Expected credit: <b>${esc(fmtDate(a.expected_credit_date))}</b></p>`).join('')}</div>` : ''}
        <div class="wallet-grid">
          <section class="wcard"><h2>Withdraw funds</h2><p class="sub">Available balance: ${inr(fresh.withdrawable_paise)} · Minimum withdrawal: ${inr(min)}</p>
          <form class="form" method="post" action="/wallet/withdraw" style="margin-top:16px"><label>Amount (₹)<input name="amount" type="number" min="1" required value="${esc(vals.amount ?? '')}"${inv(errs, 'amount')}>${ferr(errs, 'amount')}</label>
          <label>Method<select name="method"><option value="upi"${sel('upi')}>UPI</option><option value="bank"${sel('bank')}>Bank</option><option value="giftcard"${sel('giftcard')}>Gift Card</option></select></label>
          <label>UPI ID / Bank details / Email<input name="destination" required value="${esc(vals.destination ?? '')}"${inv(errs, 'destination')}>${ferr(errs, 'destination')}</label>
          <button class="btn block" type="submit">Request Withdrawal</button></form></section>
          <section class="wcard"><h2>Wallet activity</h2><p class="sub">Credits, releases and withdrawals</p>
          <div class="activity" style="margin-top:8px">${activity || '<p class="muted" style="margin-top:12px">No history yet.</p>'}</div></section>
        </div>
        <h2 style="margin-top:32px">My Withdrawals</h2>${wds.map(w => `<article class="card"><b>${inr(w.amount_paise)}</b> · ${esc(w.method)} · ${esc(w.destination)} · Status: ${esc(w.status)}</article>`).join('') || '<p class="muted">Abhi koi withdrawal nahi.</p>'}`);
    };
    if (p === '/wallet' && req.method === 'GET') {
      if (!user) return redirect(res, '/login');
      return html(res, 200, await walletPage());
    }
    if (p === '/wallet/withdraw' && req.method === 'POST') {
      if (!user) return redirect(res, '/login');
      const b = await readBody(req);
      const amount = Math.round(Number(b.amount || 0) * 100);
      const min = Number(await getSetting(db, 'min_withdrawal_paise', '5000'));
      const vals = { amount: b.amount || '', method: b.method || 'upi', destination: b.destination || '' };
      const errs = {};
      if (!amount || amount < min) errs.amount = `Minimum withdrawal ${inr(min)} hai — isse kam amount nahi nikal sakta.`;
      else if (amount > user.withdrawable_paise) errs.amount = `Withdrawable balance sirf ${inr(user.withdrawable_paise)} hai — amount kam karo.`;
      if (!b.destination || !String(b.destination).trim()) errs.destination = 'Jahan paisa bhejna hai woh details likho (UPI ID / bank details / email).';
      else if (!['upi', 'bank', 'giftcard'].includes(b.method)) errs.destination = 'Method sahi se chuno.';
      if (Object.keys(errs).length) return html(res, 200, await walletPage(errs, vals));
      await db.prepare('UPDATE users SET withdrawable_paise=withdrawable_paise-? WHERE id=?').run(amount, user.id);
      const info = await db.prepare('INSERT INTO withdrawals(user_id,amount_paise,method,destination) VALUES(?,?,?,?)').run(user.id, amount, b.method, String(b.destination).trim());
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
    return html(res, 500, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Error</title><link rel="stylesheet" href="/style.css"></head><body><main class="wrap"><div class="card empty" style="margin-top:28px"><div class="ring">!</div><h3>Kuch gadbad ho gayi</h3><p class="muted">Server par ek problem aayi hai. Thodi der me dobara try karo.</p><p style="margin-top:12px"><a class="btn small" href="/">Home par jao</a></p></div></main></body></html>`);
  }
});

async function adminRoutes(req, res, p, url, user) {
  const L = async (t, b) => await layout(user, t, b);
  // V6 admin shell: crumbs + title + access pill + tab nav (owner's design).
  const SECTIONS = [['Campaigns', '/admin/campaigns'], ['Releases', '/admin/releases'], ['Claims', '/admin/claims'], ['Earnings', '/admin/earnings'], ['Users', '/admin/users'], ['Conversions & Postbacks', '/admin/conversions'], ['Withdrawals', '/admin/withdrawals'], ['Settings', '/admin/settings'], ['Change Password', '/admin/password']];
  const A = async (t, active, sub, b) => await L(t, `<p class="crumbs">${esc(await getSetting(db, 'site_name', 'CampaignWala'))} / Admin</p>
    <div class="admin-head"><div><h1 class="admin-title">${esc(t)}</h1>${sub ? `<p class="admin-sub">${esc(sub)}</p>` : ''}</div><span class="accesspill">Admin access</span></div>
    <nav class="adminnav2" aria-label="Admin sections">${SECTIONS.map(s => `<a href="${s[1]}"${s[0] === active ? ' class="on"' : ''}>${s[0]}</a>`).join('')}</nav>${b}`);
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
    const liveCount = (await db.prepare('SELECT COUNT(*) n FROM campaigns WHERE is_live=1').get()).n;
    const wdTotal = ((await db.prepare("SELECT COALESCE(SUM(amount_paise),0) v FROM withdrawals WHERE status='pending'").get()) || {}).v || 0;
    const relTotal = ((await db.prepare("SELECT COALESCE(SUM(user_reward_paise),0) v FROM conversions WHERE status='approved' AND released=0").get()) || {}).v || 0;
    const recent = await db.prepare('SELECT cv.*, c.title, u.name FROM conversions cv JOIN clicks cl ON cl.click_id=cv.click_id JOIN campaigns c ON c.id=cl.campaign_id JOIN users u ON u.id=cl.user_id ORDER BY cv.id DESC LIMIT 3').all();
    const scard = (label, value, note, icon) => `<article class="statcard"><div class="top"><span class="lbl">${label}</span><span class="sic">${icon}</span></div><p class="n">${value}</p><p class="note">${note}</p></article>`;
    return html(res, 200, await A('Admin Dashboard', '', 'Platform activity aur rewards ko manage karo.', `
      <div class="strip"><div><p class="t">Platform data up to date</p><p class="s">${lastCleanup ? `Last retention cleanup · ${esc(lastCleanup)} (raw 30d · financial 60d after closure)` : 'Retention cleanup abhi tak nahi hua'}</p></div>
      <div class="acts"><form method="post" action="/admin/reconcile"><button class="btn small ghost" type="submit">${I.refresh} Reconcile</button></form>
      <form method="post" action="/admin/import"><button class="btn small" type="submit">${I.download} Import now</button></form></div></div>
      <section class="statcards">
        ${scard('Users', stats.users, 'Total members', I.users)}
        ${scard('Campaigns', stats.campaigns, liveCount + ' live now', I.clip)}
        ${scard('Conversions', stats.conversions, 'All time', I.badge)}
        ${scard('Pending withdrawals', stats.pendingWd, inr(wdTotal) + ' total', I.wallet)}
        ${scard('Release pending', stats.pendingRelease, inr(relTotal) + ' total', I.clock)}
        ${scard('Claims pending', stats.pendingClaims, 'Needs review', I.shield)}
      </section>
      <section class="panels">
        <div class="panel"><div style="display:flex;align-items:flex-start;justify-content:space-between"><div><h2>Recent activity</h2><p class="sub">Latest platform events</p></div><a href="/admin/conversions" style="font-size:9.5px;font-weight:600;color:#666;text-decoration:none;display:inline-flex;gap:4px;align-items:center">View log ${I.arrowUR}</a></div>
        ${recent.map(cv => `<div class="prow"><span class="pic">${I.badge}</span><div style="min-width:0;flex:1"><p class="t">Conversion ${esc(cv.status)}</p><p class="s">${esc(cv.title)} · ${esc(cv.name)} · ${esc(fmtDay(cv.updated_at))}</p></div><span class="amt">${inr(cv.user_reward_paise)}</span></div>`).join('') || '<p class="muted" style="margin-top:12px">Abhi koi conversion nahi.</p>'}</div>
        <div class="panel"><div style="display:flex;align-items:center;gap:8px"><span class="pic" style="border-radius:8px">${I.sliders}</span><h2>Quick settings</h2></div>
        <div class="qset" style="margin-top:8px"><span class="k">User share</span><span class="v">${esc(await getSetting(db, 'user_share_percent', '87.5'))}%</span></div>
        <div class="qset"><span class="k">Referral share</span><span class="v">${esc(await getSetting(db, 'referral_percent', '10'))}%</span></div>
        <div class="qset"><span class="k">Default credit days</span><span class="v">${esc(await getSetting(db, 'credit_days', '7'))} days</span></div>
        <a href="/admin/settings" style="display:inline-flex;gap:4px;align-items:center;font-size:10.5px;font-weight:600;color:#555;text-decoration:none;margin-top:10px">Manage settings ${I.chevR}</a></div>
      </section>`));
  }
  if (p === '/admin/import' && req.method === 'POST') {
    const r = await importAllFeeds(db);
    return html(res, 200, await A('Import', 'Campaigns', '', `<div class="card"><p>Import result: ${esc(JSON.stringify(r))}</p><p><a href="/admin/campaigns">Campaigns dekho</a></p></div>`));
  }
  if (p === '/admin/reconcile' && req.method === 'POST') {
    const r = await reconcilePending(db);
    return html(res, 200, await A('Reconcile', '', '', `<div class="card"><p>${esc(JSON.stringify(r))}</p><p><a href="/admin">← Admin Dashboard</a></p></div>`));
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
      return `<article class="card"><h3>${esc(c.title)}</h3><p class="muted">${esc(c.source)} · ${esc(c.campaign_type)} · ${c.is_live ? 'LIVE' : 'OFF'}${c.reward_override ? ' · manual lock' : ''}${c.hide_from_list ? ' · HIDDEN from list (extra)' : ''}</p>
      <p class="chips"><span class="chip">Company payout: <b>${payoutTxt}</b></span><span class="chip">User reward: <b>${esc(rewardLabel(c))}</b></span><span class="chip">Margin: <b>${marginTxt}</b></span></p>
      <p><a class="btn small" href="/admin/campaigns/${c.id}/edit">Edit</a></p>
      <form method="post" action="/admin/campaigns/${c.id}/toggle"><button class="btn small ghost" type="submit">${c.is_live ? 'Turn OFF' : 'Turn LIVE'}</button></form></article>`;
    }).join('');
    return html(res, 200, await A('Campaigns', 'Campaigns', 'Live offers, payouts aur campaign rules manage karo.', `<p style="margin:20px 0 14px"><a class="btn" href="/admin/campaigns/new">+ New Campaign</a></p>${cards || '<p class="muted">Abhi koi campaign nahi hai.</p>'}`));
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
    <label class="check"><input type="checkbox" name="hide_from_list" value="1" ${c.hide_from_list ? 'checked' : ''}> Home list me mat dikhao — sirf usi link wale dusre campaign ke page par "Extra" bankar khulega (jaise F&O bonus)</label>
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
      hide: b.hide_from_list === '1' ? 1 : 0,
    };
  };
  if (p === '/admin/campaigns/new' && req.method === 'GET') return html(res, 200, await A('New Campaign', 'Campaigns', '', campForm()));
  if (p === '/admin/campaigns/new' && req.method === 'POST') {
    const b = await readBody(req);
    const f = await campFields(b);
    await db.prepare(`INSERT INTO campaigns(title,description,category,geo,icon_text,user_reward_paise,upstream_payout_paise,steps_json,rules_text,campaign_type,reward_mode,reward_min_paise,reward_max_paise,reward_override,link_url,credit_days,source,external_id,is_live,hide_from_list)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'manual',?,?,?)`)
      .run(f.title, f.description, f.category, f.geo, f.icon, f.reward, f.upstream, f.steps, f.rules, f.type, f.mode, f.min, f.max, f.override, f.link, f.creditDays, 'manual-' + Date.now(), f.live, f.hide);
    return redirect(res, '/admin/campaigns');
  }
  const editMatch = p.match(/^\/admin\/campaigns\/(\d+)\/edit$/);
  if (editMatch && req.method === 'GET') {
    const c = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(editMatch[1]);
    return c ? html(res, 200, await A('Edit Campaign', 'Campaigns', '', campForm(c))) : html(res, 404, await L('404', '<h1>Not found</h1>'));
  }
  if (editMatch && req.method === 'POST') {
    const b = await readBody(req);
    const c = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(editMatch[1]);
    const f = await campFields(b, c);
    await db.prepare(`UPDATE campaigns SET title=?,description=?,category=?,geo=?,icon_text=?,user_reward_paise=?,upstream_payout_paise=?,steps_json=?,rules_text=?,
      campaign_type=?,reward_mode=?,reward_min_paise=?,reward_max_paise=?,reward_override=?,link_url=?,credit_days=?,is_live=?,hide_from_list=? WHERE id=?`)
      .run(f.title, f.description, f.category, f.geo, f.icon, f.reward, f.upstream, f.steps, f.rules, f.type, f.mode, f.min, f.max, f.override, f.link, f.creditDays, f.live, f.hide, c.id);
    return redirect(res, '/admin/campaigns');
  }
  const toggleMatch = p.match(/^\/admin\/campaigns\/(\d+)\/toggle$/);
  if (toggleMatch && req.method === 'POST') {
    await db.prepare('UPDATE campaigns SET is_live = 1 - is_live WHERE id=?').run(toggleMatch[1]);
    return redirect(res, '/admin/campaigns');
  }
  if (p === '/admin/users' && req.method === 'GET') {
    const users = await db.prepare('SELECT * FROM users ORDER BY id DESC').all();
    const rows = users.map(u => `<tr><td>${esc(u.name)}${u.is_admin ? ' <span class="pill black">ADMIN</span>' : ''}<br><span style="font-weight:400;color:#888;font-size:10px">${esc(u.email)} · ${esc(u.phone || '')}</span></td><td>${inr(u.pending_paise)}</td><td>${inr(u.approved_paise)}</td><td>${inr(u.withdrawable_paise)}</td><td>${esc(u.referral_code)}</td></tr>`).join('');
    return html(res, 200, await A('Users', 'Users', 'Member profiles, balances aur referral activity.', `<div class="tblwrap"><div class="tw-head"><div><h2>Users overview</h2><p>Showing ${users.length} members</p></div></div><div class="tblscroll"><table class="tbl"><thead><tr><th>Member</th><th>Pending</th><th>Approved</th><th>Withdrawable</th><th>Referral</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No users yet.</td></tr>'}</tbody></table></div></div>`));
  }
  if (p === '/admin/conversions' && req.method === 'GET') {
    const convs = await db.prepare('SELECT cv.*, c.title FROM conversions cv JOIN clicks cl ON cl.click_id=cv.click_id JOIN campaigns c ON c.id=cl.campaign_id ORDER BY cv.id DESC LIMIT 50').all();
    const logs = await db.prepare('SELECT * FROM postback_log ORDER BY id DESC LIMIT 50').all();
    const crows = convs.map(cv => `<tr><td>${esc(cv.title)}<br><span style="font-weight:400;color:#888;font-size:10px">${esc(cv.click_id)}</span></td><td>${esc(cv.status)}${cv.status === 'approved' ? (cv.released ? ' · RELEASED' : ` · release pending (expected ${esc(fmtDate(cv.expected_credit_date))})`) : ''}</td><td>${inr(cv.user_reward_paise)}</td><td>${esc(cv.updated_at || '')}</td></tr>`).join('');
    const lrows = logs.map(l => `<tr><td>#${l.id}<br><span style="font-weight:400;color:#888;font-size:10px">${esc(l.received_at)}</span></td><td>${esc(l.click_id)}</td><td>event=${esc(l.event)} status=${esc(l.status)}</td><td>${l.accepted ? 'ACCEPTED' : 'REJECTED'} (${esc(l.reason)})</td></tr>`).join('');
    return html(res, 200, await A('Conversions & Postbacks', 'Conversions & Postbacks', 'Partner signals aur conversion status ka audit log.', `
      <div class="tblwrap"><div class="tw-head"><div><h2>Conversions overview</h2><p>Showing recent records</p></div></div><div class="tblscroll"><table class="tbl"><thead><tr><th>Campaign / ID</th><th>Status</th><th>User reward</th><th>Updated</th></tr></thead><tbody>${crows || '<tr><td colspan="4">None yet.</td></tr>'}</tbody></table></div></div>
      <div class="tblwrap"><div class="tw-head"><div><h2>Postback Log</h2><p>Network se aaya har signal</p></div></div><div class="tblscroll"><table class="tbl"><thead><tr><th>Received</th><th>Click</th><th>Event / Status</th><th>Result</th></tr></thead><tbody>${lrows || '<tr><td colspan="4">No postbacks yet.</td></tr>'}</tbody></table></div></div>`));
  }
  if (p === '/admin/withdrawals' && req.method === 'GET') {
    const wds = await db.prepare('SELECT w.*, u.name, u.email FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC').all();
    const rows = wds.map(w => `<tr><td>${esc(w.name)}<br><span style="font-weight:400;color:#888;font-size:10px">${esc(w.email)}</span></td><td>${inr(w.amount_paise)}</td><td>${esc(w.method)}</td><td>${esc(w.destination)}</td><td>Status: ${esc(w.status)}</td><td class="acts">${w.status === 'pending' ? `<form method="post" action="/admin/withdrawals/${w.id}/approve" class="inline"><button class="btn small" type="submit">Approve &amp; Paid</button></form> <form method="post" action="/admin/withdrawals/${w.id}/reject" class="inline"><button class="btn small ghost" type="submit">Reject (refund)</button></form>` : ''}</td></tr>`).join('');
    return html(res, 200, await A('Withdrawals', 'Withdrawals', 'User requests review karke paid mark ya reject karo.', `<div class="tblwrap"><div class="tw-head"><div><h2>Withdrawals overview</h2><p>Showing ${wds.length} requests</p></div></div><div class="tblscroll"><table class="tbl"><thead><tr><th>User</th><th>Amount</th><th>Method</th><th>Destination</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="6">None.</td></tr>'}</tbody></table></div></div>`));
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
    return html(res, 200, await A('Releases', 'Releases', 'Approved rewards jo credit date ke liye ready hain.', `
      <div class="strip"><div><p class="t">Release karte hi paisa Withdrawable ho jayega</p><p class="s">Referral commission bhi referrer ko saath me mil jayega.</p></div>
      <form method="post" action="/admin/releases/bulk-due"><button class="btn small" type="submit">Release ALL due (date aa gayi hai)</button></form></div>
      <div style="margin-top:20px">${cards || '<p class="muted">Abhi kuch release pending nahi.</p>'}</div>`));
  }
  if (p === '/admin/releases/bulk-due' && req.method === 'POST') {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.prepare("SELECT click_id FROM conversions WHERE status='approved' AND released=0 AND expected_credit_date<=?").all(today);
    let n = 0;
    for (const r of rows) if ((await releaseConversion(r.click_id)).ok) n++;
    return html(res, 200, await A('Releases', 'Releases', '', `<div class="card"><p>${n} conversion(s) release ho gaye.</p><p><a href="/admin/releases">Wapas Releases</a></p></div>`));
  }
  const relMatch = p.match(/^\/admin\/releases\/([\w-]+)$/);
  if (relMatch && req.method === 'POST') {
    const r = await releaseConversion(relMatch[1]);
    return html(res, 200, await A('Releases', 'Releases', '', `<div class="card"><p>Release result: ${esc(r.reason)}</p><p><a href="/admin/releases">Wapas Releases</a></p></div>`));
  }
  // ---- Claims (custom / manual-verification campaigns) ----
  if (p === '/admin/claims' && req.method === 'GET') {
    const claims = await db.prepare(`SELECT cq.*, c.title, u.name, u.email FROM claims cq
      JOIN campaigns c ON c.id=cq.campaign_id JOIN users u ON u.id=cq.user_id ORDER BY cq.id DESC LIMIT 100`).all();
    return html(res, 200, await A('Claims', 'Claims', 'Manual campaigns ke user-submitted claims review karo.', `<div style="margin-top:20px">${claims.map(cq => `<article class="card"><b>${esc(cq.title)}</b> · Status: ${esc(cq.status)}${cq.status === 'approved' ? ` · Reward: ${inr(cq.rolled_reward_paise)}` : ''}
      <p class="muted">${esc(cq.name)} (${esc(cq.email)}) · ${esc(cq.created_at)}</p>
      <p>Note: ${esc(cq.note)}</p>${cq.proof_url ? `<p>Proof: <a href="${esc(cq.proof_url)}" target="_blank" rel="noopener">${esc(cq.proof_url)}</a></p>` : ''}
      ${cq.status === 'rejected' ? `<p class="muted">Reject reason: ${esc(cq.reject_reason)}</p>` : ''}
      ${cq.status === 'pending' ? `<form method="post" action="/admin/claims/${cq.id}/approve" class="inline"><button class="btn small" type="submit">Approve</button></form>
      <form method="post" action="/admin/claims/${cq.id}/reject" class="form inline-form"><input name="reason" placeholder="Reject reason (user ko dikhega)" required><button class="btn small ghost" type="submit">Reject</button></form>` : ''}</article>`).join('') || '<p>No claims yet.</p>'}</div>`));
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
  // ---- Change own admin password (V4) — inline errors, session stays alive.
  // Note: ADMIN_PASSWORD env re-syncs on boot (see ensureAdmin), so after a
  // panel change the env should be updated too, warna restart par env wala
  // password wapas lag jayega.
  const passwordForm = (errs = {}, done = false) => `
    ${done ? '<p class="notice">✅ Password change ho gaya. Isi password se ab login hoga.<br><span class="muted">Note: server restart par ADMIN_PASSWORD env wala password dobara sync ho jata hai — env bhi update kar dena.</span></p>' : ''}
    <form class="card form" method="post" action="/admin/password">
    <label>Current password<input name="current" type="password" required autocomplete="current-password"${inv(errs, 'current')}>${ferr(errs, 'current')}</label>
    <label>New password (kam se kam 8 characters)<input name="next" type="password" required minlength="8" autocomplete="new-password"${inv(errs, 'next')}>${ferr(errs, 'next')}</label>
    <label>New password dobara likho<input name="confirm" type="password" required autocomplete="new-password"${inv(errs, 'confirm')}>${ferr(errs, 'confirm')}</label>
    <button class="btn" type="submit">Password Change Karo</button></form>
    <p><a href="/admin">← Admin Dashboard</a></p>`;
  if (p === '/admin/password' && req.method === 'GET') {
    return html(res, 200, await A('Change Password', 'Change Password', 'Admin account ke liye ek naya, strong password set karo.', passwordForm()));
  }
  if (p === '/admin/password' && req.method === 'POST') {
    const b = await readBody(req);
    const me = await db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    const errs = {};
    if (!verifyPassword(b.current || '', me.pass_hash)) errs.current = 'Current password galat hai.';
    if (!b.next || String(b.next).length < 8) errs.next = 'New password kam se kam 8 characters ka rakho.';
    else if (b.next !== b.confirm) errs.confirm = 'Dono new password match nahi ho rahe.';
    if (Object.keys(errs).length) return html(res, 200, await A('Change Password', 'Change Password', 'Admin account ke liye ek naya, strong password set karo.', passwordForm(errs)));
    await db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(b.next), user.id);
    return html(res, 200, await A('Change Password', 'Change Password', 'Admin account ke liye ek naya, strong password set karo.', passwordForm({}, true)));
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
    return html(res, 200, await A('Earnings', 'Earnings', 'Company payout, user reward aur campaign margin ka breakdown. (sirf admin)', `<section class="card" style="margin-top:20px">
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
    return html(res, 200, await A('Settings', 'Settings', 'Site, referral, payout share aur feeds configuration.', `<form class="card form" method="post" action="/admin/settings" style="margin-top:20px">
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
