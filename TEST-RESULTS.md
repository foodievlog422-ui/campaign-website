# Test Results — Campaign Website V2.1

Run: 2026-11-20 (IST), in this VM. Command: `npm test` (`node tests/run-tests.mjs`).
The suite spawns the real server on a test port with a throwaway SQLite DB, `SEED_DEMO=true`, a sentinel postback secret, and drives everything over HTTP. Raw log: `tests/last-run.txt`.

## Result: 46/46 PASS

V2.1 change (owner request): the **admin campaign list** now shows, on every campaign card, three compact chips — **Company payout** (upstream, ₹), **User reward**, and **Margin** (payout − user reward). Campaigns with no upstream payout set (custom/referral campaigns) show `—` for payout and margin. These values render only inside the authenticated admin area; public pages/API remain clean (tests 8e1–8e4, marked ★★).

V1 tests were kept; the approval-flow tests (4c/4d/4e) were updated to the V2 behaviour the owner asked for: approval no longer pays out directly — money waits in **Approved (release pending)** until the admin releases it. New V2 tests are marked ★.

| # | Test | Result |
|---|---|---|
| 1a | Server starts, home page loads (200) | PASS |
| 1b | Campaigns list renders the 3 seeded demo campaigns | PASS |
| 1c | Public API lists exactly 3 campaigns | PASS |
| 2a | Signup redirects to dashboard | PASS |
| 2b | Remember-me cookie present, `HttpOnly`, `Max-Age=2592000` (30 days) | PASS |
| 2c | Referral code/link issued to new user | PASS |
| 2d | Logout → login works, remember cookie set again | PASS |
| 3a | Start campaign creates unique `click_id`, redirects to progress page | PASS |
| 3b | Progress page shows the full timeline, Clicked step done | PASS |
| 3c | Progress API reports stage 0 = Clicked | PASS |
| 5a | Postback with WRONG secret → 401 rejected, wallet stays ₹0 | PASS |
| 4a | Postback `status=pending` → PENDING wallet credited ₹250 | PASS |
| 5b | Duplicate pending postback → idempotent, still ₹250 | PASS |
| 4b | Postback `event=installed` → progress advances to Installed (stage 2) | PASS |
| 4c ★ | Approval moves ₹250 Pending → **Approved (release pending)**, Withdrawable stays ₹0 | PASS |
| 4c2 ★ | Stage = Approved (5, not Wallet Credited) + expected credit date shown = approval + 7 days | PASS |
| 4d ★ | Referral commission 10% = ₹25 **held** in referrer's Approved bucket, not withdrawable yet | PASS |
| 4f1 ★ | Admin → Releases lists the approved conversion with its release action | PASS |
| 4f2 ★ | Admin manual release → ₹250 withdrawable for user + ₹25 referral paid to referrer | PASS |
| 5c | Duplicate approved postback after release → idempotent, no double credit | PASS |
| 4e | Progress timeline reaches "Wallet Credited" **after release** (all 7 steps) | PASS |
| 6 | **Leak test** — public pages + API contain NO postback secret, NO upstream payout values, NO sentinel, NO `upstream_payout` field | PASS — clean |
| 7a | Withdrawal request (₹250, UPI) accepted | PASS |
| 7b | Withdrawal shows `pending`, amount held from withdrawable balance | PASS |
| 7c | Admin sees the pending withdrawal | PASS |
| 7d | Admin approves → user sees status `paid` | PASS |
| 7e | Admin postback log records both ACCEPTED and REJECTED calls | PASS |
| 8a1 ★ | **App tracking:** postback `event=install` → stage Installed | PASS |
| 8a2 ★ | Postback `event=register` → stage Registered | PASS |
| 8a3 ★ | Postback `event=kyc` → stage KYC Done — full in-app sequence via postbacks only | PASS |
| 8b1 ★ | **Multi-feed + auto pricing:** feed added in Settings, import creates campaign; upstream ₹400 × 87.5% share → user reward auto = **₹350** (35000 paise) | PASS |
| 8b2 ★ | **Leak test 2:** feed token, upstream payout (40000) and margin fields absent from public home + API | PASS — clean |
| 8b3 ★ | Settings page shows multi-feed list, user share % and credit days fields | PASS |
| 8b4 ★ | Offer removed from feed → next import **auto-hides** it from the public list | PASS |
| 8c1 ★ | Custom campaign created (type=custom, random ₹100–₹150); public API exposes only the range | PASS |
| 8c2 ★ | Custom progress page shows claim form + campaign (referral) link button | PASS |
| 8c3 ★ | User claim submit → admin Claims list shows it with the note | PASS |
| 8c4 ★ | Admin approves claim → random amount rolled once (test run: ₹137) into user's Approved bucket | PASS |
| 8c5 ★ | Release of the claim conversion → rolled amount becomes withdrawable | PASS |
| 8c6 ★ | Claim reject with reason → reason visible to the user on the progress page | PASS |
| 8d1 ★ | Admin Earnings page shows upstream total + admin margin | PASS |
| 8d2 ★ | Earnings page redirects to login for non-admin (numbers never public) | PASS |
| 8e1 ★★ | Admin campaign list (admin session) shows Company payout for seeded campaign: 123450 paise = **₹1,234.5** | PASS |
| 8e2 ★★ | Admin list margin = payout − user reward (123450 − 25000 = **₹984.5**), User reward chip present | PASS |
| 8e3 ★★ | Public home + public API contain NO payout/margin values (₹1,234.5 / ₹984.5 / 123450 / 98450) and no "Company payout" label | PASS — clean |
| 8e4 ★★ | Custom campaign (no upstream payout) shows payout and margin as **—** in the admin list | PASS |

## Extra checks (also PASS)

- **V1 → V2 DB migration:** booting V2 against a DB with the old schema adds the new columns (`campaign_type`, `reward_mode`, `link_url`, `credit_days`, conversion release/expected-date columns, user `approved_paise`), creates the `claims` table and the new settings defaults (`user_share_percent=87.5`, `credit_days=7`) — verified directly.
- **Reconciliation stub:** unchanged, still reports pending count and reuses the same idempotent postback path.
- **Default mode (SEED_DEMO unset):** V1-verified behaviour kept — demo seed stays behind `SEED_DEMO=true` only.
- **Docker:** `docker` is not installed in this VM, so the image was not built here. The Dockerfile is unchanged (zero-dependency `node:24-bookworm-slim` copy-and-run); build on the target host with `docker compose up -d --build`.
