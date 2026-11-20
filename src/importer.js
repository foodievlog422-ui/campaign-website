// Multi-feed JSON importer for CPA networks (V2).
// Feed contract (server-to-server only; URL + token never reach the frontend):
// GET <feed_url>  (optional header: Authorization: Bearer <feed_token>)
// -> JSON array, or { "campaigns": [...] }, each item:
// { external_id, title, description, category, geo, icon_text,
//   user_reward_paise, upstream_payout_paise, steps: [...], rules }
//
// AUTO PRICING: if the item carries upstream_payout_paise > 0, the public
// user reward is auto-computed = floor(upstream * user_share_percent / 100).
// The difference is the admin's margin — server-side only, never exposed.
// Campaigns whose admin locked the reward (reward_override=1) keep their
// manual reward; only their upstream payout is refreshed.
// AUTO-HIDE: offers that disappear from a feed are set is_live=0 for that
// feed's source (only after a successful fetch of that feed).
import { getSetting, setSetting } from './db.js';

export function feedSource(feed, idx) {
  if (idx === 0) return 'feed'; // legacy V1 source, keeps existing rows deduplicated
  const slug = String(feed.name || `feed${idx}`).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return 'feed_' + (slug || `feed${idx}`);
}

// Reads the configured feed list. Migrates the legacy single feed_url /
// feed_token settings (or env vars) into the list on first use.
export function getFeeds(db) {
  let feeds = [];
  try { feeds = JSON.parse(getSetting(db, 'feeds_json', '') || '[]'); } catch { feeds = []; }
  if (!Array.isArray(feeds)) feeds = [];
  if (feeds.length === 0) {
    const url = getSetting(db, 'feed_url', process.env.NETWORK_FEED_URL || '');
    if (url) {
      feeds = [{ name: 'Default feed', url, token: getSetting(db, 'feed_token', process.env.NETWORK_FEED_TOKEN || ''), enabled: true }];
      setSetting(db, 'feeds_json', JSON.stringify(feeds));
    }
  }
  return feeds;
}
export function saveFeeds(db, feeds) {
  setSetting(db, 'feeds_json', JSON.stringify(feeds));
}

export async function importFeed(db, feed, idx = 0, fetchFn = fetch) {
  const url = feed.url || '';
  if (!url) return { ok: false, imported: 0, hidden: 0, feed: feed.name || '', reason: 'feed_url not configured' };
  const headers = feed.token ? { Authorization: `Bearer ${feed.token}` } : {};
  let res;
  try { res = await fetchFn(url, { headers }); } catch (e) { return { ok: false, imported: 0, hidden: 0, feed: feed.name || '', reason: 'fetch failed: ' + e.message }; }
  if (!res.ok) return { ok: false, imported: 0, hidden: 0, feed: feed.name || '', reason: `feed HTTP ${res.status}` };
  const data = await res.json();
  const items = Array.isArray(data) ? data : (data.campaigns || []);
  const source = feedSource(feed, idx);
  const share = Number(getSetting(db, 'user_share_percent', '87.5')) || 0;
  const upsert = db.prepare(`INSERT INTO campaigns
    (title,description,category,geo,icon_text,user_reward_paise,upstream_payout_paise,steps_json,rules_text,source,external_id,is_live)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(source,external_id) DO UPDATE SET
      title=excluded.title, description=excluded.description, category=excluded.category,
      geo=excluded.geo, steps_json=excluded.steps_json, rules_text=excluded.rules_text, is_live=1`);
  const updExisting = db.prepare(`UPDATE campaigns SET title=?, description=?, category=?, geo=?, icon_text=?,
    user_reward_paise=?, upstream_payout_paise=?, steps_json=?, rules_text=?, is_live=1 WHERE source=? AND external_id=?`);
  const updOverride = db.prepare(`UPDATE campaigns SET title=?, description=?, category=?, geo=?, icon_text=?,
    upstream_payout_paise=?, steps_json=?, rules_text=?, is_live=1 WHERE source=? AND external_id=?`);
  let imported = 0;
  const seen = [];
  for (const it of items) {
    if (!it.external_id || !it.title) continue;
    seen.push(String(it.external_id));
    const upstream = Number(it.upstream_payout_paise || 0);
    const autoReward = upstream > 0 ? Math.floor(upstream * share / 100) : Number(it.user_reward_paise || 0);
    const existing = db.prepare('SELECT reward_override FROM campaigns WHERE source=? AND external_id=?').get(source, String(it.external_id));
    const steps = JSON.stringify(Array.isArray(it.steps) ? it.steps : []);
    if (!existing) {
      upsert.run(it.title, it.description || '', it.category || 'General', it.geo || 'India',
        (it.icon_text || it.title[0] || 'C').slice(0, 2), autoReward, upstream, steps, it.rules || '', source, String(it.external_id));
    } else if (existing.reward_override) {
      updOverride.run(it.title, it.description || '', it.category || 'General', it.geo || 'India',
        (it.icon_text || it.title[0] || 'C').slice(0, 2), upstream, steps, it.rules || '', source, String(it.external_id));
    } else {
      updExisting.run(it.title, it.description || '', it.category || 'General', it.geo || 'India',
        (it.icon_text || it.title[0] || 'C').slice(0, 2), autoReward, upstream, steps, it.rules || '', source, String(it.external_id));
    }
    imported++;
  }
  // Auto-hide offers that vanished from this feed.
  let hidden = 0;
  const live = db.prepare('SELECT external_id FROM campaigns WHERE source=? AND is_live=1').all(source);
  const hide = db.prepare('UPDATE campaigns SET is_live=0 WHERE source=? AND external_id=?');
  for (const row of live) if (!seen.includes(String(row.external_id))) { hide.run(source, row.external_id); hidden++; }
  return { ok: true, imported, hidden, feed: feed.name || source };
}

// Imports ALL enabled feeds. Returns a per-feed report.
export async function importAllFeeds(db, fetchFn = fetch) {
  const feeds = getFeeds(db);
  if (feeds.length === 0) return { ok: false, imported: 0, results: [], reason: 'no feeds configured' };
  const results = [];
  let imported = 0;
  for (let i = 0; i < feeds.length; i++) {
    if (feeds[i].enabled === false) { results.push({ ok: false, imported: 0, feed: feeds[i].name || '', reason: 'disabled' }); continue; }
    const r = await importFeed(db, feeds[i], i, fetchFn);
    results.push(r);
    imported += r.imported || 0;
  }
  return { ok: true, imported, results };
}

// Backwards-compatible single-feed entry point (V1 callers/tests).
export async function importFeedLegacy(db, { url, token, fetchFn = fetch } = {}) {
  return importFeed(db, { name: 'Default feed', url, token }, 0, fetchFn);
}

// Reconciliation stub: re-checks conversions that are still "pending" with the
// network, if a reconcile URL is configured. Real networks differ, so the safe
// default is a no-op + a report of how many pendings are waiting. Postbacks
// remain the primary path; this is the daily safety net, never a second
// crediting path — it must call the same applyPostback() logic so crediting
// stays idempotent.
export async function reconcilePending(db) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM conversions WHERE status='pending'").get();
  return { checked: 0, still_pending: row.n, note: 'No reconcile URL configured; postback is the active path. Wire the network status API here and reuse applyPostback().' };
}
