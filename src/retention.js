// Data retention (V3) — two tiers. Runs on boot + daily (server.js), and is
// directly callable for tests/admin.
//
// TIER 1 — RAW TRACKING DATA, purged after `retention_days` (default 30):
//  - postback_log rows older than the window            -> DELETE
//  - sessions that have expired                          -> DELETE
//  - clicks in a terminal state (rejected / claim rejected / never converted),
//    older than the window, with NO conversion and NO claim attached
//                                                         -> DELETE (pure tracking record)
//  - clicks that must be kept (a conversion/claim references them), and every
//    other click older than the window                   -> keep row, strip ip/ua
//
// TIER 2 — FINANCIAL RECORDS, purged only 60 days AFTER FULL CLOSURE
// (`financial_retention_days`, default 60). A record's case is fully closed
// only when NOTHING is owed or in flight on it any more:
//  - conversion: approved AND released (incl. referral released, if any),
//    closed at released_at — or rejected, closed at updated_at
//  - withdrawal: paid, or rejected (auto-refunded), closed at processed_at
//  - wallet_ledger entry: older than the window AND its account fully closed
// HARD GUARD, applied to every financial purge: if the owning account has ANY
// non-zero balance (pending / approved / withdrawable) or ANY open state
// (pending conversion, approved-but-unreleased conversion, pending
// withdrawal, pending claim), its financial records are NEVER purged — they
// roll forward until the account closes, and only then does the 60-day clock
// run. User accounts themselves are never deleted.
//
// Timestamps are stored as UTC 'YYYY-MM-DD HH:MM:SS' text in both engines, so
// lexicographic cutoff comparisons are exact.
import { getSetting, setSetting } from './db.js';

const cutoffStr = (days) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 19).replace('T', ' ');
// Account-level guard fragment: true when the account still holds money.
const BALANCE_GUARD = "(u.pending_paise<>0 OR u.approved_paise<>0 OR u.withdrawable_paise<>0)";

export async function runRetention(db, { rawDays, financialDays } = {}) {
  const days = rawDays != null ? Number(rawDays)
    : Number(await getSetting(db, 'retention_days', '30')) || 30;
  const finDays = financialDays != null ? Number(financialDays)
    : Number(await getSetting(db, 'financial_retention_days', '60')) || 60;
  const cutoff = cutoffStr(days);
  const finCutoff = cutoffStr(finDays);

  // ---- Tier 1: raw tracking data ----
  const postback = await db.run('DELETE FROM postback_log WHERE received_at<?', cutoff);
  const sessions = await db.run('DELETE FROM sessions WHERE expires_at<?', Date.now());
  const clicksDeleted = await db.run(
    `DELETE FROM clicks WHERE updated_at<? AND conv_status IN ('rejected','claim_rejected','none')
     AND NOT EXISTS (SELECT 1 FROM conversions WHERE conversions.click_id=clicks.click_id)
     AND NOT EXISTS (SELECT 1 FROM claims WHERE claims.click_id=clicks.click_id)`, cutoff);
  const clicksStripped = await db.run(
    "UPDATE clicks SET ip='', ua='' WHERE updated_at<? AND (ip<>'' OR ua<>'')", cutoff);

  // ---- Tier 2: financial records, 60 days after full closure only ----
  const conversionsPurged = await db.run(
    `DELETE FROM conversions WHERE
       ( (status='approved' AND released=1 AND (referral_amount_paise=0 OR referral_released=1)
          AND released_at<>'' AND released_at<?)
         OR (status='rejected' AND updated_at<?) )
     AND NOT EXISTS (SELECT 1 FROM clicks cl JOIN users u ON u.id=cl.user_id
                     WHERE cl.click_id=conversions.click_id AND ${BALANCE_GUARD})`,
    finCutoff, finCutoff);
  const withdrawalsPurged = await db.run(
    `DELETE FROM withdrawals WHERE status IN ('paid','rejected')
     AND processed_at<>'' AND processed_at<?
     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=withdrawals.user_id AND ${BALANCE_GUARD})`,
    finCutoff);
  const ledgerPurged = await db.run(
    `DELETE FROM wallet_ledger WHERE created_at<?
     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=wallet_ledger.user_id AND ${BALANCE_GUARD})
     AND NOT EXISTS (SELECT 1 FROM clicks cl JOIN conversions cv ON cv.click_id=cl.click_id
                     WHERE cl.user_id=wallet_ledger.user_id
                       AND (cv.status='pending' OR (cv.status='approved' AND cv.released=0)))
     AND NOT EXISTS (SELECT 1 FROM withdrawals w WHERE w.user_id=wallet_ledger.user_id AND w.status='pending')
     AND NOT EXISTS (SELECT 1 FROM claims cq WHERE cq.user_id=wallet_ledger.user_id AND cq.status='pending')`,
    finCutoff);

  const report = {
    days, cutoff, financial_days: finDays, financial_cutoff: finCutoff,
    postback_log_deleted: postback.changes,
    sessions_deleted: sessions.changes,
    clicks_deleted: clicksDeleted.changes,
    clicks_ip_ua_stripped: clicksStripped.changes,
    conversions_purged: conversionsPurged.changes,
    withdrawals_purged: withdrawalsPurged.changes,
    wallet_ledger_purged: ledgerPurged.changes,
  };
  await setSetting(db, 'last_cleanup_at', new Date().toISOString());
  await setSetting(db, 'last_cleanup_report', JSON.stringify(report));
  return report;
}
