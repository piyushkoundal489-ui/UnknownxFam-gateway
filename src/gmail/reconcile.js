// Gmail as an OPTIONAL payment-notification source (the "FamApp"-style bank alert flow). An email alone never marks
// a payment PAID: sender allow-list, Gmail's own DKIM verdict, credited amount, time window, an unmatched-elsewhere
// reference, and (when a prior balance is known) a consistent running balance must ALL line up. If evidence exists
// but can't be safely tied to exactly one order, or the balance looks wrong, the order goes to MANUAL_REVIEW instead
// of being guessed at. Only structured fields are ever stored — never the email body.
import { cfg } from '../lib/config.js';
import { first, all, run, now } from '../lib/db.js';
import { open } from '../lib/crypto.js';
import { parseAmount, settleOrder, markManualReview, claimEvent, finishEvent, releaseEvent, OPEN_STATES } from '../payments/core.js';
import { G, gmailGet } from './google.js';
import { userToken } from './connection.js';

// ---------- pure helpers (unit-tested) ----------
export const header = (p, n) => ((p.headers || []).find((h) => h.name.toLowerCase() === n.toLowerCase()) || {}).value || '';
export const headerAll = (p, n) => (p.headers || []).filter((h) => h.name.toLowerCase() === n.toLowerCase()).map((h) => h.value);
export function fromAddress(from) { const m = /<([^<>@\s]+@[^<>\s]+)>/.exec(from) || /[^<>@\s"]+@[^<>\s"]+/.exec(from); return m ? (m[1] || m[0]).toLowerCase() : ''; }
export function senderAllowed(addr, allowed) {
  addr = addr.toLowerCase(); if (!addr.includes('@')) return false; const dom = addr.slice(addr.lastIndexOf('@') + 1);
  return allowed.some((a) => { a = a.trim().toLowerCase(); if (!a) return false; return a.includes('@') ? addr === a : dom === a || dom.endsWith('.' + a); });
}
/** Gmail's own Authentication-Results (the TOPMOST one, added by Google on receipt) must show dkim=pass for an aligned domain. */
export function dkimOk(authHeaders, fromAddr) {
  if (!fromAddr.includes('@')) return false; const fd = fromAddr.slice(fromAddr.lastIndexOf('@') + 1);
  const top = authHeaders.find((h) => h.trim().toLowerCase().startsWith('mx.google.com')); if (!top) return false;
  for (const m of top.matchAll(/dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/gi)) { const d = m[1].toLowerCase(); if (d === fd || fd.endsWith('.' + d) || d.endsWith('.' + fd)) return true; }
  return false;
}
const AMT = '(?:Rs\\.?|INR|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)';
const BAL_WORD = '(?:bal(?:ance)?|avl|available)';
/** Credited amount in paise; balance/limit/fee figures are ignored (those are read separately, see extractBalance). */
export function extractAmount(text) {
  const found = new Set();
  for (const re of [new RegExp('(?:credited|received)[^0-9₹\\n]{0,60}?' + AMT, 'giud'), new RegExp(AMT + '[^.\\n]{0,80}?(?:credited|received)', 'giud')]) {
    for (const m of text.matchAll(re)) {
      const off = m.indices[1][0]; const ctx = text.slice(Math.max(0, off - 40), off);
      if (new RegExp(`(?:${BAL_WORD}|limit|charges?|fees?)[\\s:\\-=]*(?:is|of)?[\\s:\\-=]*(?:Rs\\.?|INR|₹)\\s*$`, 'iu').test(ctx)) continue;
      const p = parseAmount(m[1]); if (p !== null) found.add(p);
    }
  }
  if (found.size === 1) return { amount: [...found][0], ambiguous: false };
  return { amount: null, ambiguous: found.size > 1 };
}
/** The account's running balance as stated in the notification, in paise (or null if not present/ambiguous). */
export function extractBalance(text) {
  const found = new Set();
  for (const m of text.matchAll(new RegExp(BAL_WORD + '[^0-9₹]{0,25}?' + AMT, 'giu'))) { const p = parseAmount(m[1]); if (p !== null) found.add(p); }
  return found.size === 1 ? [...found][0] : null;
}
export function extractUtr(text) {
  let m = /\b(?:UTR|RRN|UPI\s*Ref(?:erence)?(?:\s*(?:No|Number|ID))?\.?|Ref(?:erence)?\s*(?:No|Number|ID)\.?)\s*[:\-#]?\s*(\d{12})\b/i.exec(text); if (m) return m[1];
  m = /\bUTR\s*(?:No|Number|ID)?\.?\s*[:\-#]?\s*([A-Z0-9]{10,22})\b/.exec(text); return m ? m[1] : null;
}
/** Bank/provider transaction id — distinct from the UTR (e.g. "Txn ID: T2609221234"). Falls back to null, never guessed. */
export function extractTransactionId(text) {
  const m = /\b(?:Txn|Transaction)\s*(?:ID|No|Number)?\.?\s*(?:[:#]|-(?=\s))?\s*([A-Za-z0-9][A-Za-z0-9-]{4,46}[A-Za-z0-9])(?![A-Za-z0-9-])/i.exec(text);
  return m ? m[1] : null;
}
/** Payer name/handle, when the alert states one ("...credited...from RAVI KUMAR", "...received ₹50.0 from Laiba naved at 04:49 PM IST...", "...from john@upi"). */
const NAME_END = '(?=[.,;:\\n(]|\\s+(?:at|on|via|using|through|with|to|for|UPI|Ref|UTR|Txn|Transaction|Date|Updated|Balance|by)\\b|\\s*$)';
const NAME = "([\\p{L}][\\p{L}\\p{M}0-9._' @-]{1,60}?)";
export function extractReceivedFrom(text) {
  const t = String(text || '');
  // prefer the "from" that belongs to the credit sentence ("received/credited ... from NAME"), then any other "from NAME"
  const m = new RegExp('\\b(?:received|credited)\\b[^\\n]{0,80}?\\bfrom\\s+' + NAME + NAME_END, 'iu').exec(t) || new RegExp('\\bfrom\\s+' + NAME + NAME_END, 'iu').exec(t);
  const name = m ? m[1].trim().replace(/\s{2,}/g, ' ').replace(/[.\-' ]+$/, '') : '';
  return name && !/^(?:your|the|a|an|account|bank|famapp|support)\b/i.test(name) ? name : null;
}
/** A stated purpose/remark/note, if the alert includes one. Never invented. */
export function extractPurpose(text) {
  const m = /\b(?:for|purpose|remark|note)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 ,.\-]{1,60}?)(?=[.\n]|$)/i.exec(text);
  return m ? m[1].trim() : null;
}
export const orderRef = (text) => { const m = /\bORDER_[A-F0-9]{12}\b/.exec(text); return m ? m[0] : null; };

/** Configurable sender -> display provider name (e.g. "alerts@famapp.in" -> "FamApp"); falls back to a capitalized domain label. */
export function providerFromSender(fromAddr, mapping = {}) {
  const addr = String(fromAddr || '').toLowerCase(); if (!addr.includes('@')) return null;
  const dom = addr.slice(addr.lastIndexOf('@') + 1);
  for (const [k, v] of Object.entries(mapping)) { const key = k.toLowerCase(); if (addr === key || dom === key || dom.endsWith('.' + key)) return v; }
  const base = dom.split('.')[0].replace(/^(alerts?|notify|no-?reply|updates?)$/i, dom.split('.')[1] || dom);
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : null;
}
export function parseProviderMap(spec) {
  const out = {};
  for (const pair of String(spec || '').split(',')) { const [k, v] = pair.split(':').map((s) => (s || '').trim()); if (k && v) out[k.toLowerCase()] = v; }
  return out;
}

/** Decides whether ONE email proves ONE pending order was paid. Pure. msg = {from, auth[], time, text}. */
export function evaluate(msg, orders, c) {
  if (!senderAllowed(msg.from, c.allowed)) return { result: 'sender_not_allowed' };
  if (c.requireDkim && !dkimOk(msg.auth, msg.from)) return { result: 'dkim_failed' };
  const t = msg.text;
  if (!/credited|received/i.test(t) || /debited/i.test(t)) return { result: 'not_credit' };
  const a = extractAmount(t);
  if (a.ambiguous) return { result: 'ambiguous_amount' };
  if (a.amount === null) return { result: 'no_amount' };
  const utr = extractUtr(t), oref = orderRef(t), txnId = extractTransactionId(t);
  const receivedFrom = extractReceivedFrom(t), purpose = extractPurpose(t), updatedBalance = extractBalance(t);
  let cand = orders.filter((o) => OPEN_STATES.includes(o.status) && o.pay_amount === a.amount && msg.time >= o.created_at - 5 && msg.time <= o.expires_at);
  if (!cand.length) return { result: 'no_open_order', amount: a.amount };
  if (oref) { cand = cand.filter((o) => o.id === oref); if (!cand.length) return { result: 'reference_mismatch', amount: a.amount }; }
  if (cand.length > 1) return { result: 'ambiguous_order', amount: a.amount, candidateOrders: cand };
  const hasReference = !!(utr || oref || txnId);
  if (c.requireReference && !hasReference) return { result: 'no_reference', amount: a.amount, order: cand[0] };
  return { result: 'match', order: cand[0], amount: a.amount, utr, transactionId: txnId, receivedFrom, purpose, updatedBalance, referenceVerified: hasReference };
}

// ---------- message parsing ----------
const decode64u = (s) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))); } catch { return ''; } };
function collect(part, acc, depth = 0) {
  if (depth > 6 || !part) return; const mime = part.mimeType || '';
  if (part.body && part.body.data && (mime === 'text/plain' || mime === 'text/html')) {
    let raw = decode64u(part.body.data);
    if (mime === 'text/html') raw = raw.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    acc[mime === 'text/plain' ? 'plain' : 'html'] += '\n' + raw;
  }
  for (const p of part.parts || []) collect(p, acc, depth + 1);
}
/** Plain-text body (falls back to stripped HTML). Always escaped by callers — never rendered as HTML. */
export function bodyText(payload) {
  const acc = { plain: '', html: '' }; collect(payload, acc);
  return (acc.plain.trim() ? acc.plain : acc.html).replace(/[ \t]+/g, ' ').trim().slice(0, 100000);
}

// ---------- user's Gmail connection ----------
export { gmailAccount } from './connection.js';
/** Access token for the user's Gmail, or null (not connected / access ended -> the connection is flagged "reconnect required" / Google unavailable). */
export async function userAccessToken(env, uid) { return (await userToken(env, uid)).token || null; }

/**
 * If the message's transaction id or UTR was already used to PAY a DIFFERENT order for this merchant (or anyone
 * else), this is a replay — never settle a second time from the same evidence.
 */
async function alreadyUsedElsewhere(env, orderId, { utr, transactionId }) {
  if (utr) { const r = await first(env, "SELECT 1 AS x FROM orders WHERE txn_ref = ? AND id <> ? AND status = 'PAID'", utr, orderId); if (r) return true; }
  if (transactionId) { const r = await first(env, "SELECT 1 AS x FROM orders WHERE transaction_id = ? AND id <> ? AND status = 'PAID'", transactionId, orderId); if (r) return true; }
  return false;
}

const ignoredIds = new Map();   // userId -> ids already looked at that are not FamApp "received" alerts (in memory only; keeps polling to ~1 call per round)
const ignoreSet = (uid) => { let s = ignoredIds.get(uid); if (!s) { s = new Set(); ignoredIds.set(uid, s); } if (s.size > 500) s.clear(); return s; };
/** Only e-mails from the allow-listed alert senders (FamApp) that say "received" (or "credited" for bank alerts) are payment alerts. */
const isAlertCandidate = (msg, conf) => senderAllowed(msg.from, conf.allowed) && /received|credited/i.test(msg.text);

/**
 * The newest not-yet-seen payment alerts, oldest first. Reads the INBOX listing directly — Gmail's search (`q=`) can take
 * 10-60 s to show a brand-new e-mail, which made payments look late. Each new message costs one fetch; everything that is
 * not a payment alert is remembered and never fetched again.
 */
async function fetchNewAlerts(env, token, userId, conf, max = 10) {
  const list = await gmailGet(token, '/messages', { labelIds: 'INBOX', maxResults: 15 });
  if (list.status !== 200) return { error: 'gmail_unavailable', msgs: [] };
  const ign = ignoreSet(userId); let ids = (list.body.messages || []).map((m) => m.id).filter((id) => !ign.has(id));
  if (ids.length) {                                          // ONE query for all of them (was one query per message); already-recorded ones are remembered in memory too
    const done = new Set((await all(env, `SELECT gmail_message_id FROM gmail_payment_messages WHERE user_id = ? AND gmail_message_id IN (${ids.map(() => '?').join(',')})`, userId, ...ids)).map((r) => r.gmail_message_id));
    done.forEach((id) => ign.add(id)); ids = ids.filter((id) => !done.has(id));
  }
  const out = [];
  await Promise.all(ids.slice(0, max).map(async (id) => {
    const r = await gmailGet(token, '/messages/' + encodeURIComponent(id), { format: 'full' });
    if (r.status !== 200 || !r.body.payload) return;
    const msg = parseGmailMessage(r.body);
    if (!isAlertCandidate(msg, conf)) { ign.add(id); return; }
    out.push({ id, r, msg });
  }));
  out.sort((a, b) => a.msg.time - b.msg.time);               // oldest first: the balance chain must follow real time
  return { msgs: out };
}

/** Parses one Gmail API message (format=full) into the fields the matcher needs. */
function parseGmailMessage(body) {
  const p = body.payload; const from = fromAddress(header(p, 'From'));
  return { from, auth: headerAll(p, 'Authentication-Results'), time: Math.floor(Number(body.internalDate || 0) / 1000), text: header(p, 'Subject') + '\n' + bodyText(p), threadId: body.threadId || null };
}
/** The running balance a TRUSTED credit alert states (sender allow-listed + DKIM when required); null otherwise. Pure. */
export function trustedCreditBalance(msg, conf) {
  if (!senderAllowed(msg.from, conf.allowed)) return null;
  if (conf.requireDkim && !dkimOk(msg.auth, msg.from)) return null;
  if (!/credited|received/i.test(msg.text) || /debited/i.test(msg.text)) return null;
  return extractBalance(msg.text);
}
/** Moves the stored balance forward only (never backwards to an older email). Mutates `user` so a loop sees the new value. */
async function syncBalance(env, user, balance, time) {
  if (balance == null) return false;
  const r = await run(env, 'UPDATE users SET last_known_balance = ?, last_balance_at = ? WHERE id = ? AND (last_balance_at IS NULL OR last_balance_at <= ?)', balance, time, user.id, time);
  if ((r.meta?.changes || 0) > 0) { user.last_known_balance = balance; user.last_balance_at = time; return true; }
  return false;
}
const hasOpenOrder = async (env, uid) => !!(await first(env, "SELECT 1 AS x FROM orders WHERE user_id = ? AND status IN ('PENDING','PROCESSING') AND expires_at > ? LIMIT 1", uid, now()));
const gmailConf = (env) => { const c = cfg(env); return { allowed: c.gmailAllowedSenders, requireDkim: c.gmailRequireDkim, requireReference: c.gmailRequireReference }; };
async function recordMessage(env, uid, id, msg, ev, outcome, providerMap) {
  const dom = msg.from ? msg.from.slice(msg.from.lastIndexOf('@') + 1) : null;
  await run(env, `INSERT INTO gmail_payment_messages(user_id,gmail_message_id,gmail_thread_id,sender,provider,amount,transaction_id,utr,received_from,purpose,updated_balance,payment_time,result,order_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (user_id, gmail_message_id) DO NOTHING`, uid, id, msg.threadId, dom, providerFromSender(msg.from, providerMap), ev.amount ?? null, ev.transactionId || null, ev.utr || null,
    ev.receivedFrom || null, ev.purpose || null, ev.updatedBalance ?? null, msg.time, outcome, null, now());
}
/** Facts of one credit alert (no order matching): amount, UTR, transaction id, payer, balance. Null unless trusted + a clear credit. */
function creditFacts(msg, conf) {
  if (!senderAllowed(msg.from, conf.allowed)) return { outcome: 'sender_not_allowed' };
  if (conf.requireDkim && !dkimOk(msg.auth, msg.from)) return { outcome: 'dkim_failed' };
  const t = msg.text; if (!/credited|received/i.test(t) || /debited/i.test(t)) return { outcome: 'not_credit' };
  const a = extractAmount(t); if (a.ambiguous) return { outcome: 'ambiguous_amount' }; if (a.amount === null) return { outcome: 'no_amount' };
  return { outcome: 'no_open_order', ev: { amount: a.amount, utr: extractUtr(t), transactionId: extractTransactionId(t), receivedFrom: extractReceivedFrom(t), purpose: extractPurpose(t), updatedBalance: extractBalance(t) } };
}

/**
 * Keeps a merchant's "FamPay balance" current from the newest trusted credit alert ("Updated Balance"), with NO order needed.
 * `backfill` (right after the user connects Gmail) reads the last 30 days. Messages are recorded (so UTR / transaction-id
 * lookups can find them) but only while the merchant has no open order — otherwise reconcile() must see them first.
 */
export async function refreshBalance(env, user, { backfill = false } = {}) {
  const conf = gmailConf(env); const providerMap = parseProviderMap(cfg(env).gmailProviderMap); const out = { checked: 0, balance: null };
  if (!conf.allowed.length) return { ...out, error: 'not_configured' };
  await run(env, 'UPDATE gmail_accounts SET last_checked = ? WHERE user_id = ?', now(), user.id);
  const token = await userAccessToken(env, user.id); if (!token) return { ...out, error: 'gmail_unavailable' };
  const fresh = await first(env, 'SELECT last_known_balance, last_balance_at FROM users WHERE id = ?', user.id) || {};
  user.last_known_balance = fresh.last_known_balance; user.last_balance_at = fresh.last_balance_at;
  const latestOnly = backfill || fresh.last_balance_at == null;       // first read: only the NEWEST alert, no history
  const { msgs: found, error } = await fetchNewAlerts(env, token, user.id, conf, latestOnly ? 3 : 10);
  if (error) return { ...out, error };
  let todo = found;
  if (latestOnly) {                                                      // newest TRUSTED credit only; everything older is recorded as skipped and never re-read
    todo = []; let chosen = false;
    for (const m of [...found].reverse()) {
      const f = creditFacts(m.msg, conf);
      if (chosen) await recordMessage(env, user.id, m.id, m.msg, {}, 'skipped_old', providerMap);
      else if (f.ev) { chosen = true; todo = [m]; }
      else await recordMessage(env, user.id, m.id, m.msg, {}, f.outcome, providerMap);
    }
  }
  for (const { id, msg } of todo) {
    if (!backfill && await hasOpenOrder(env, user.id)) break;       // an order is waiting: reconcile() must read these messages first
    const f = creditFacts(msg, conf);
    await recordMessage(env, user.id, id, msg, f.ev || {}, f.outcome === 'no_open_order' && latestOnly ? 'latest' : f.outcome, providerMap);
    out.checked++;
    if (f.ev && f.ev.updatedBalance != null && await syncBalance(env, user, f.ev.updatedBalance, msg.time)) out.balance = f.ev.updatedBalance;
  }
  return out;
}
/** Balance refresh for every approved, active merchant with Gmail connected and NO open order (accounts with open orders are handled by reconcile). */
export async function refreshIdleBalances(env, minGapSec = 4, concurrency = 5) {
  if (!cfg(env).paymentsEnabled) return 0;
  const t = now();
  const users = await all(env, `SELECT u.* FROM users u JOIN gmail_accounts g ON g.user_id = u.id AND g.status = 'active'
    WHERE u.approval = 'approved' AND u.acct_status = 'active' AND (g.last_checked IS NULL OR g.last_checked <= ?)
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status IN ('PENDING','PROCESSING') AND o.expires_at > ?)`, t - minGapSec, t);
  let updated = 0; let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, users.length) }, async () => {
    while (next < users.length) { const u = users[next++]; try { const r = await refreshBalance(env, u); if (r.balance != null) updated++; } catch (e) { console.error('balance refresh failed:', e.message); } }
  }));
  return updated;
}

/** Checks the user's own mailbox for bank/FamApp credit alerts and reconciles their own pending orders. Read-only. */
export async function reconcile(env, user) {
  const c = cfg(env); const sum = { checked: 0, matched: 0, manualReview: 0 };
  const conf = { allowed: c.gmailAllowedSenders, requireDkim: c.gmailRequireDkim, requireReference: c.gmailRequireReference };
  const providerMap = parseProviderMap(c.gmailProviderMap);
  if (!conf.allowed.length) return { ...sum, error: 'not_configured' };
  const orders = await all(env, "SELECT * FROM orders WHERE user_id = ? AND status IN ('PENDING','PROCESSING') AND expires_at > ?", user.id, now());
  await run(env, 'UPDATE gmail_accounts SET last_checked = ? WHERE user_id = ?', now(), user.id);
  if (!orders.length) return { ...sum, note: 'no_pending_orders' };
  const token = await userAccessToken(env, user.id); if (!token) return { ...sum, error: 'gmail_unavailable' };
  const { msgs: alerts, error } = await fetchNewAlerts(env, token, user.id, conf, 10);
  if (error) return { ...sum, error };
  const msgs = alerts.map(({ id, r }) => ({ id, r }));
  let open_ = orders;
  for (const { id, r } of msgs) {
    if (r.status !== 200 || !r.body.payload) continue;
    const key = `${user.id}:${id}`;
    if (!(await claimEvent(env, 'gmail', key, null, user.id))) continue;        // idempotency guard: parallel request or earlier run already claimed this message
    sum.checked++;
    const p = r.body.payload; const from = fromAddress(header(p, 'From'));
    const msg = { from, auth: headerAll(p, 'Authentication-Results'), time: Math.floor(Number(r.body.internalDate || 0) / 1000), text: header(p, 'Subject') + '\n' + bodyText(p) };
    const ev = evaluate(msg, open_, conf); const dom = from ? from.slice(from.lastIndexOf('@') + 1) : null;
    const provider = providerFromSender(from, providerMap);
    let outcome = ev.result, matchedOrderId = ev.order ? ev.order.id : (ev.candidateOrders?.[0]?.id || null);
    try {
      if (ev.result === 'match') {
        if (await alreadyUsedElsewhere(env, ev.order.id, ev)) {
          outcome = 'duplicate_reference';
        } else {
          // The running-balance check only applies when the stored balance is from BEFORE this e-mail (another job may already have applied it).
          const prevBal = user.last_known_balance; const balanceBefore = prevBal != null && (user.last_balance_at == null || user.last_balance_at < msg.time);
          const balanceOk = !balanceBefore || ev.updatedBalance == null || prevBal + ev.amount === ev.updatedBalance;
          if (!balanceOk) {
            await markManualReview(env, ev.order.id, 'reported balance does not match the expected running balance', { gmailMessageId: id, source: 'gmail_notification' });
            outcome = 'manual_review'; sum.manualReview++;
          } else {
            const s = await settleOrder(env, ev.order.id, ev.amount, 'INR', ev.utr, 'gmail_notification', {
              amount_verified: true, reference_verified: ev.referenceVerified, sender_verified: true, dkim_verified: conf.requireDkim,
              transactionId: ev.transactionId, receivedFrom: ev.receivedFrom, purpose: ev.purpose, provider, updatedBalance: ev.updatedBalance, paymentTime: msg.time,
            });
            outcome = s.ok ? 'success' : s.code;
            if (s.ok) {
              sum.matched++; open_ = open_.filter((o) => o.id !== ev.order.id);
              console.log(`gmail: order ${ev.order.id} settled ${Math.max(0, now() - msg.time)}s after the e-mail reached Gmail`);   // tells whether a delay came from Gmail delivery or from our side
              if (ev.updatedBalance != null) await syncBalance(env, user, ev.updatedBalance, msg.time);
            }
          }
        }
      } else if (ev.result === 'ambiguous_order' || ev.result === 'no_reference') {
        // There is credible evidence (authenticated sender, credit and exact
        // amount/time), but it cannot be safely assigned automatically.
        // Preserve the order for an explicit admin decision instead of letting
        // it silently expire as PENDING.
        const candidates = ev.candidateOrders || (ev.order ? [ev.order] : []);
        for (const candidate of candidates) {
          if (await markManualReview(env, candidate.id, ev.result === 'ambiguous_order' ? 'more than one open order matched the credited amount' : 'credit alert has no usable payment reference', { gmailMessageId: id, source: 'gmail_notification' })) {
            sum.manualReview++;
          }
        }
        const reviewedIds = new Set(candidates.map((candidate) => candidate.id));
        open_ = open_.filter((order) => !reviewedIds.has(order.id));
        outcome = 'manual_review';
      }
      if (outcome !== 'success') await syncBalance(env, user, trustedCreditBalance(msg, conf), msg.time);   // an unrelated credit still moves the balance forward
      await finishEvent(env, 'gmail', key, outcome, { amount: ev.amount ?? null, sender_domain: dom }, matchedOrderId);
      await run(env, `INSERT INTO gmail_payment_messages(user_id,gmail_message_id,gmail_thread_id,sender,provider,amount,transaction_id,utr,received_from,purpose,updated_balance,payment_time,result,order_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, user.id, id, r.body.threadId || null, dom, provider, ev.amount ?? null, ev.transactionId || null, ev.utr || null,
        ev.receivedFrom || null, ev.purpose || null, ev.updatedBalance ?? null, msg.time, outcome, matchedOrderId, now());
      if (matchedOrderId) {   // payment_matches is an order-scoped audit trail; results with no candidate order have nothing to attach it to
        await run(env, 'INSERT INTO payment_matches(order_id,gmail_message_id,match_result,reason,created_at) VALUES(?,?,?,?,?)',
          matchedOrderId, id, outcome === 'success' ? 'matched' : outcome === 'manual_review' ? 'manual_review' : 'rejected', outcome, now());
      }
    } catch (e) { await releaseEvent(env, 'gmail', key); throw e; }
  }
  return sum;
}
/** Reconciles every eligible merchant that has an open order. Runs from the fast background poller (every few
 * seconds, see src/server.js) and from housekeeping, so a payment is picked up even when the customer has left the
 * pay page (switching to the UPI app pauses the page's own polling). Only accounts with an OPEN order are checked, so
 * idle merchants cost no Gmail calls. Any role can be a merchant (the owner's own account included). Each account is
 * still throttled by last_checked, and claimEvent() keeps parallel checks from settling a message twice. */
export async function reconcileOpenGmailAccounts(env, minGapSec = 4, concurrency = 5) {
  if (!cfg(env).paymentsEnabled) return 0;
  const users = await all(env, `SELECT u.* FROM users u JOIN gmail_accounts g ON g.user_id = u.id AND g.status = 'active'
    WHERE u.approval = 'approved' AND u.acct_status = 'active'
      AND EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status IN ('PENDING','PROCESSING') AND o.expires_at > ?)`, now());
  let matched = 0; let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, users.length) }, async () => {
    while (next < users.length) {
      const u = users[next++];
      const result = await maybeReconcile(env, u.id, minGapSec);
      if (result) matched += result.matched || 0;
    }
  }));
  return matched;
}
/** Throttled auto-check (used while a customer watches the pay page, and by the cron sweep). */
export async function maybeReconcile(env, userId, minGapSec = 4) {
  try {
    const c = cfg(env); if (!c.paymentsEnabled || !(c.googleClientId && c.googleClientSecret)) return null;
    const a = await gmailAccount(env, userId); if (!a || now() - (a.last_checked || 0) < minGapSec) return null;
    const u = await first(env, 'SELECT * FROM users WHERE id = ?', userId); return u ? await reconcile(env, u) : null;
  } catch { return null; }                                                       // never break payment polling because of Gmail
}


/**
 * Older records were saved before the payer-name reader understood "...received ₹50.0 from NAME at 04:49 PM...", so their received_from is empty.
 * Re-reads that ONE already-recorded e-mail (by its stored message id, from the merchant's own mailbox — no search) and fills the name in
 * everywhere the same UTR / transaction id is stored. Returns the name or null. Never changes anything that already has a name.
 */
async function repairReceivedFrom(env, row) {
  if (!row || !row.gmail_message_id || !row.user_id) return null;
  const token = await userAccessToken(env, row.user_id); if (!token) return null;
  const r = await gmailGet(token, '/messages/' + encodeURIComponent(row.gmail_message_id), { format: 'full' });
  if (r.status !== 200 || !r.body.payload) return null;
  const name = extractReceivedFrom(parseGmailMessage(r.body).text); if (!name) return null;
  await run(env, 'UPDATE gmail_payment_messages SET received_from = ? WHERE user_id = ? AND gmail_message_id = ? AND received_from IS NULL', name, row.user_id, row.gmail_message_id);
  for (const [table, refCol] of [['orders', 'txn_ref'], ['payments', 'utr']]) {
    if (row.utr) await run(env, `UPDATE ${table} SET received_from = ? WHERE user_id = ? AND received_from IS NULL AND LOWER(${refCol}) = LOWER(?)`, name, row.user_id, row.utr);
    if (row.transaction_id) await run(env, `UPDATE ${table} SET received_from = ? WHERE user_id = ? AND received_from IS NULL AND LOWER(transaction_id) = LOWER(?)`, name, row.user_id, row.transaction_id);
  }
  return name;
}

/**
 * Payment details for a UTR OR a transaction id (the two references a payer / the provider can quote), straight from the
 * merchant's own FamApp-style alert e-mails: first the e-mails already read, otherwise a live search of the connected mailbox.
 * Read-only: it never settles an order (that stays with reconcile()'s checks). Returns null when nothing trustworthy is found.
 */
export async function lookupPaymentByReference(env, user, ref) {
  ref = String(ref || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(ref)) return null;
  const shape = (row) => ({ amount: row.amount, utr: row.utr, transaction_id: row.transaction_id, received_from: row.received_from, purpose: row.purpose,
    updated_balance: row.updated_balance, payment_time: row.payment_time, provider: row.provider, order_id: row.order_id || null });
  const known = await first(env, `SELECT * FROM gmail_payment_messages WHERE user_id = ? AND (LOWER(utr) = LOWER(?) OR LOWER(transaction_id) = LOWER(?))
    AND amount IS NOT NULL AND result NOT IN ('sender_not_allowed','dkim_failed','not_credit','no_amount','ambiguous_amount') ORDER BY payment_time DESC LIMIT 1`, user.id, ref, ref);
  if (known) { if (!known.received_from) known.received_from = await repairReceivedFrom(env, known).catch(() => null); return shape(known); }
  const conf = gmailConf(env); if (!conf.allowed.length) return null;
  const token = await userAccessToken(env, user.id); if (!token) return null;
  const q = 'from:(' + conf.allowed.map((a) => a.replace(/[^a-z0-9@._-]/gi, '')).join(' OR ') + ') "' + ref + '" newer_than:90d';
  const list = await gmailGet(token, '/messages', { q, maxResults: 3 });
  if (list.status !== 200) return null;
  const providerMap = parseProviderMap(cfg(env).gmailProviderMap);
  for (const m of list.body.messages || []) {
    const r = await gmailGet(token, '/messages/' + encodeURIComponent(m.id), { format: 'full' });
    if (r.status !== 200 || !r.body.payload) continue;
    const msg = parseGmailMessage(r.body); const f = creditFacts(msg, conf);
    if (!f.ev) continue;
    const same = (v) => v && v.toLowerCase() === ref.toLowerCase();
    if (!same(f.ev.utr) && !same(f.ev.transactionId)) continue;           // the reference must really be THIS payment's UTR / transaction id, not just mentioned
    await recordMessage(env, user.id, m.id, msg, f.ev, 'lookup', providerMap);
    await syncBalance(env, user, f.ev.updatedBalance, msg.time);
    return shape({ ...f.ev, transaction_id: f.ev.transactionId, received_from: f.ev.receivedFrom, updated_balance: f.ev.updatedBalance, payment_time: msg.time, provider: providerFromSender(msg.from, providerMap), order_id: null });
  }
  return null;
}

/**
 * Look a payment up by UTR or transaction id across ALL merchants (database only — nothing is searched in anyone's mailbox).
 * Only UTR / transaction-id references match (never order or payment ids). Orders win over bare e-mail records.
 */
export async function lookupPaymentGlobal(env, ref) {
  ref = String(ref || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(ref)) return null;
  const order = await first(env, `SELECT * FROM orders WHERE LOWER(txn_ref) = LOWER(?) OR LOWER(transaction_id) = LOWER(?)
    ORDER BY CASE status WHEN 'PAID' THEN 0 ELSE 1 END, COALESCE(paid_at, created_at) DESC LIMIT 1`, ref, ref);
  const valid = `(LOWER(utr) = LOWER(?) OR LOWER(transaction_id) = LOWER(?))
    AND amount IS NOT NULL AND result NOT IN ('sender_not_allowed','dkim_failed','not_credit','no_amount','ambiguous_amount')`;
  if (order) {
    if (order.status === 'PAID' && !order.received_from) {
      const src = await first(env, `SELECT * FROM gmail_payment_messages WHERE user_id = ? AND ${valid} ORDER BY payment_time DESC LIMIT 1`, order.user_id, ref, ref);
      order.received_from = (src && (src.received_from || await repairReceivedFrom(env, src).catch(() => null))) || null;
    }
    return { order };
  }
  const row = await first(env, `SELECT * FROM gmail_payment_messages WHERE ${valid} ORDER BY payment_time DESC LIMIT 1`, ref, ref);
  if (row && !row.received_from) row.received_from = await repairReceivedFrom(env, row).catch(() => null);
  return row ? { row } : null;
}

/** Is this inbox row (From + Subject only) a payment alert from an allow-listed sender? Used to highlight payment e-mails on the live inbox. */
export function isPaymentAlertHeaders(env, from, subject) {
  return senderAllowed(fromAddress(from), cfg(env).gmailAllowedSenders) && /received|credited/i.test(subject || '');
}
/**
 * "Check this merchant's mailbox NOW" (throttled): reconciles their open orders, or — with none open — refreshes their balance.
 * Called by the live inbox page and anything else that wants verification without waiting for the background round.
 */
export async function pollNow(env, userId, minGapSec = 3) {
  const u = await first(env, 'SELECT * FROM users WHERE id = ?', userId);
  if (!u || u.approval !== 'approved' || u.acct_status !== 'active') return null;
  if (await hasOpenOrder(env, u.id)) return maybeReconcile(env, u.id, minGapSec);
  const g = await first(env, 'SELECT last_checked, status FROM gmail_accounts WHERE user_id = ?', u.id);
  if (!g || g.status !== 'active' || (g.last_checked && g.last_checked > now() - minGapSec)) return null;
  return refreshBalance(env, u);
}
