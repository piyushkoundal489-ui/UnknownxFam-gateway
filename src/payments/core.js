// Orders and the ONLY places an order can move to PAID/UNSUCCESSFUL/MANUAL_REVIEW/CANCELLED. Callers must already
// have authenticated the source (provider signature, merchant secret, Gmail sender+DKIM, super-admin). settleOrder
// re-checks the money facts itself. A UPI QR is never proof of payment — only these functions record a verified result.
import { first, all, run, now, changes, isUnique } from '../lib/db.js';
import { randomHex, safeEqual, hmacHex } from '../lib/crypto.js';
import { ORDER_TTL, paymentsEnabled } from '../lib/config.js';
import { effectiveStatus } from '../auth/session.js';
import { fmtISTEmail } from '../lib/time.js';

export const ST = { PENDING: 'PENDING', PROCESSING: 'PROCESSING', PAID: 'PAID', UNSUCCESSFUL: 'UNSUCCESSFUL', EXPIRED: 'EXPIRED', CANCELLED: 'CANCELLED', MANUAL_REVIEW: 'MANUAL_REVIEW', NOT_FOUND: 'NOT_FOUND' };
export const VERIFY_METHODS = ['provider_webhook', 'provider_api', 'gmail_notification', 'manual_confirm'];
export const VERIFICATION_SOURCE = { provider_webhook: 'PROVIDER_WEBHOOK', provider_api: 'PROVIDER_API', gmail_notification: 'GMAIL_FAMAPP', manual_confirm: 'MANUAL_ADMIN' };
export const OPEN_STATES = ['PENDING', 'PROCESSING'];

export const newOrderId = () => 'ORDER_' + randomHex(6).toUpperCase();
export const newPaymentId = () => 'PAY_' + randomHex(6).toUpperCase();
export const money = (paise) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const asRupees = (paise) => Math.round((paise / 100) * 100) / 100;   // plain number, e.g. 499.01 (for JSON, not a locale string)
export const isoTime = (unixSec) => new Date(unixSec * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

export function parseAmount(s) {
  s = String(s ?? '').trim().replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const p = Math.round(parseFloat(s) * 100);
  return p >= 100 && p <= 10000000 ? p : null;                       // Rs 1 .. Rs 1,00,000
}
export const validUpi = (u) => /^[a-z0-9._-]{2,64}@[a-z][a-z0-9]{1,31}$/i.test(u);

/** Real UPI deep-link built from the order row — nothing hard-coded. */
export function upiUri({ upi, name, paise, orderId, currency = 'INR' }) {
  return 'upi://pay?pa=' + encodeURIComponent(upi) + '&pn=' + encodeURIComponent(name) + '&am=' + (paise / 100).toFixed(2) + '&cu=' + encodeURIComponent(currency) + '&tn=' + encodeURIComponent(orderId);
}
export const orderUpiUri = (o, fallbackName = '') => upiUri({ upi: o.upi, name: o.payee_name || fallbackName, paise: o.pay_amount, orderId: o.id, currency: o.currency || 'INR' });

export async function orderEvent(env, orderId, type, source = '', detail = {}) {
  await run(env, 'INSERT INTO order_events(order_id,type,source,detail,created_at) VALUES(?,?,?,?,?)', orderId, type, source, JSON.stringify(detail).slice(0, 1000), now());
}
/** Server-side authoritative expiry: PENDING/PROCESSING past expires_at become EXPIRED and can never become PAID afterwards. */
export async function expireOrders(env) {
  const rows = await all(env, "UPDATE orders SET status='EXPIRED', updated_at=? WHERE status IN ('PENDING','PROCESSING') AND expires_at <= ? RETURNING id", now(), now());
  for (const r of rows) await orderEvent(env, r.id, 'EXPIRED', 'system');
  return rows.length;
}

/** Merchant-scoped lookup — matches order id, payment id, UTR, or transaction id. Prevents IDOR: never cross-user. */
export const findUserOrder = (env, userId, ref) =>
  first(env, 'SELECT * FROM orders WHERE user_id = ? AND (LOWER(id) = LOWER(?) OR LOWER(payment_id) = LOWER(?) OR txn_ref = ? OR transaction_id = ?) ORDER BY created_at DESC LIMIT 1', userId, ref, ref, ref, ref);

/** Creates a PENDING order at the exact requested amount; an open same-amount order is rejected, never altered. */
export async function createPayment(env, user, amt) {
  if (!paymentsEnabled(env)) return { ok: false, http: 503, message: 'Payments are disabled on this temporary testing site.' };
  await expireOrders(env);
  const existing = await first(env, "SELECT id FROM orders WHERE user_id = ? AND pay_amount = ? AND status IN ('PENDING','PROCESSING') LIMIT 1", user.id, amt);
  if (existing) {
    return { ok: false, http: 409, message: 'A payment order for this exact amount is already open. Complete it or wait for it to expire before creating another.', existingOrderId: existing.id };
  }
  for (let i = 0; i < 5; i++) {
    const t = now(); const id = newOrderId(); const pid = newPaymentId();
    try {
      await run(env, "INSERT INTO orders(id,payment_id,user_id,upi,payee_name,amount,pay_amount,currency,status,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,'INR','PENDING',?,?,?)",
        id, pid, user.id, user.upi, user.name, amt, amt, t, t + ORDER_TTL, t);
      await orderEvent(env, id, 'CREATED', 'api', { pay_amount: amt });
      return { ok: true, order: await first(env, 'SELECT * FROM orders WHERE id = ?', id) };
    } catch (e) {
      if (!isUnique(e)) throw e;
      const conflict = await first(env, "SELECT id FROM orders WHERE user_id = ? AND pay_amount = ? AND status IN ('PENDING','PROCESSING') LIMIT 1", user.id, amt);
      if (conflict) {
        return { ok: false, http: 409, message: 'A payment order for this exact amount is already open. Complete it or wait for it to expire before creating another.', existingOrderId: conflict.id };
      }
    }
  }
  return { ok: false, http: 503, message: 'Could not allocate a unique order ID. Please try again.' };
}

/**
 * Moves an order to PAID. Idempotent; the conditional UPDATE (status IN open states, still time-valid, exact
 * pay_amount) makes double-processing impossible even under concurrent callers.
 * meta may include: transactionId, receivedFrom, purpose, provider, updatedBalance (paise), paymentTime (unix sec).
 */
export async function settleOrder(env, orderId, paise, currency, ref, method, meta = {}) {
  if (!paymentsEnabled(env)) return { ok: false, code: 'payments_disabled' };
  if (!VERIFY_METHODS.includes(method)) return { ok: false, code: 'bad_method' };
  const o = await first(env, 'SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) return { ok: false, code: 'order_not_found' };
  const reject = async (code) => { await orderEvent(env, orderId, 'VERIFY_REJECTED', method, { reason: code }); return { ok: false, code }; };
  if (o.status === 'PAID') return { ok: true, code: 'already_paid', order: o };
  if (!OPEN_STATES.includes(o.status)) return reject(o.status === 'EXPIRED' ? 'expired' : 'not_pending');
  if (o.expires_at <= now()) { await expireOrders(env); return reject('expired'); }
  if (String(currency).toUpperCase() !== String(o.currency).toUpperCase()) return reject('currency_mismatch');
  if (paise !== o.pay_amount) return reject('amount_mismatch');
  const refv = ref ? String(ref) : null;
  if (refv) {
    // duplicate/replay protection: the SAME reference can never settle two orders, for this merchant OR globally.
    const dLocal = await first(env, 'SELECT 1 AS x FROM orders WHERE user_id = ? AND txn_ref = ? AND id <> ?', o.user_id, refv, orderId);
    if (dLocal) return reject('duplicate_reference');
    const dGlobal = await first(env, 'SELECT 1 AS x FROM orders WHERE txn_ref = ? AND user_id <> ? AND status = ?', refv, o.user_id, 'PAID');
    if (dGlobal) return reject('duplicate_reference');
  }
  const txnId = meta.transactionId ? String(meta.transactionId).slice(0, 64) : null;
  const full = { ...meta, verification_method: method, verified_at: new Date().toISOString() };
  let r;
  try {
    r = await run(env, `UPDATE orders SET status='PAID', paid_at=?, updated_at=?, txn_ref=COALESCE(?, txn_ref), transaction_id=COALESCE(?, transaction_id),
        received_from=COALESCE(?, received_from), purpose=COALESCE(?, purpose), provider=COALESCE(?, provider), updated_balance=COALESCE(?, updated_balance),
        payment_time=COALESCE(?, payment_time), verification_method=?, verification_meta=?
        WHERE id=? AND status IN ('PENDING','PROCESSING') AND expires_at > ? AND pay_amount = ?`,
      now(), now(), refv, txnId, meta.receivedFrom || null, meta.purpose || null, meta.provider || null, meta.updatedBalance ?? null, meta.paymentTime ?? null,
      method, JSON.stringify(full), orderId, now(), paise);
  } catch (e) { if (isUnique(e)) return reject('duplicate_reference'); throw e; }
  if (changes(r) !== 1) {
    const cur = await first(env, 'SELECT status FROM orders WHERE id = ?', orderId);
    return cur && cur.status === 'PAID' ? { ok: true, code: 'already_paid' } : reject('not_pending');
  }
  await recordPayment(env, orderId, o.user_id, paise, o.currency, 'PAID', method, { ...meta, transactionId: txnId, txn_ref: refv });
  await orderEvent(env, orderId, 'PAID', method, { amount: paise, reference: refv ? '[set]' : null });
  return { ok: true, code: 'settled' };
}
/** A trusted provider reported failure. Only open orders can fail; PAID is never overwritten. */
export async function failOrder(env, orderId, method, meta = {}) {
  if (!paymentsEnabled(env)) return false;
  const ok = changes(await run(env, "UPDATE orders SET status='UNSUCCESSFUL', updated_at=?, verification_method=? WHERE id=? AND status IN ('PENDING','PROCESSING')", now(), method, orderId)) === 1;
  if (ok) { await orderEvent(env, orderId, 'UNSUCCESSFUL', method, meta); await recordPayment(env, orderId, null, null, null, 'UNSUCCESSFUL', method, meta); }
  return ok;
}
/** Evidence exists (an amount/sender matched something) but it cannot be safely tied to exactly one order. */
export async function markManualReview(env, orderId, reason, meta = {}) {
  if (!paymentsEnabled(env)) return false;
  const ok = changes(await run(env, "UPDATE orders SET status='MANUAL_REVIEW', updated_at=? WHERE id=? AND status IN ('PENDING','PROCESSING')", now(), orderId)) === 1;
  if (ok) { await orderEvent(env, orderId, 'MANUAL_REVIEW', meta.source || 'gmail_notification', { reason, ...meta }); await recordPayment(env, orderId, null, null, null, 'MANUAL_REVIEW', meta.source || 'gmail_notification', meta); }
  await run(env, 'INSERT INTO payment_matches(order_id,gmail_message_id,match_result,reason,created_at) VALUES(?,?,?,?,?)', orderId, meta.gmailMessageId || null, 'manual_review', reason, now());
  return ok;
}
/** User/admin cancels a still-open order (e.g. abandoned checkout). Never overwrites PAID. */
export async function cancelOrder(env, orderId, actor = 'user') {
  if (!paymentsEnabled(env)) return false;
  const ok = changes(await run(env, "UPDATE orders SET status='CANCELLED', updated_at=? WHERE id=? AND status IN ('PENDING','PROCESSING')", now(), orderId)) === 1;
  if (ok) await orderEvent(env, orderId, 'CANCELLED', actor);
  return ok;
}
export async function markProcessing(env, orderId, method) {
  if (!paymentsEnabled(env)) return false;
  const ok = changes(await run(env, "UPDATE orders SET status='PROCESSING', updated_at=? WHERE id=? AND status='PENDING' AND expires_at > ?", now(), orderId, now())) === 1;
  if (ok) await orderEvent(env, orderId, 'PROCESSING', method);
  return ok;
}
async function recordPayment(env, orderId, userId, paise, currency, status, method, meta = {}) {
  if (userId === null || paise === null) {
    const o = await first(env, 'SELECT user_id, pay_amount, currency FROM orders WHERE id = ?', orderId);
    if (userId === null) userId = o ? o.user_id : null;
    if (paise === null) { paise = o ? o.pay_amount : 0; currency = currency || (o ? o.currency : 'INR'); }
  }
  await run(env, `INSERT INTO payments(order_id,user_id,amount,currency,status,provider,transaction_id,utr,received_from,purpose,payment_time,updated_balance,verification_source,verified_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, orderId, userId, paise, currency || 'INR', status, meta.provider || null, meta.transactionId || null, meta.txn_ref || meta.utr || null,
    meta.receivedFrom || null, meta.purpose || null, meta.paymentTime ?? null, meta.updatedBalance ?? null, VERIFICATION_SOURCE[method] || method, now(), now());
}

// ---- idempotency / audit log for webhooks and Gmail messages ----
export async function claimEvent(env, source, key, orderId = null, userId = null) {
  return changes(await run(env, "INSERT INTO payment_events(source,event_key,order_id,user_id,result,detail,created_at) VALUES(?,?,?,?,'received','{}',?) ON CONFLICT (source, event_key) DO NOTHING", source, key, orderId, userId, now())) === 1;
}
export const finishEvent = (env, source, key, result, detail = {}, orderId = null) =>
  run(env, 'UPDATE payment_events SET result = ?, detail = ?, order_id = COALESCE(?, order_id) WHERE source = ? AND event_key = ?', result, JSON.stringify(detail).slice(0, 500), orderId, source, key);
export const releaseEvent = (env, source, key) => run(env, "DELETE FROM payment_events WHERE source = ? AND event_key = ? AND result = 'received'", source, key);
export async function eventSeen(env, source, key) { return !!(await first(env, 'SELECT 1 AS x FROM payment_events WHERE source = ? AND event_key = ?', source, key)); }

// ---- the documented API envelope: Portal_Owner first, Powered_By last, every response (success or error) ----
export const STATUS_MESSAGES = {
  PAID: 'Payment received.', PENDING: 'Payment has not been verified yet.', PROCESSING: 'Payment verification is in progress.',
  UNSUCCESSFUL: 'Payment was not successful.', EXPIRED: 'This payment order has expired.', CANCELLED: 'This payment order was cancelled.',
  MANUAL_REVIEW: 'Payment evidence was found but needs manual review.', NOT_FOUND: 'Payment not found.',
};
export const PORTAL_OWNER = '@UnknownNvrDie 👾';
// Human-readable result with a tick or a cross (the machine fields `success` / `status` stay exactly as they were, so integrations keep working).
const DISPLAY = { PAID: ['Payment Received ✅', 'true ✅'], RECEIVED: ['Payment Received ✅', 'true ✅'], PENDING: ['Pending ⏳', 'pending ⏳'], PROCESSING: ['Processing ⏳', 'pending ⏳'], MANUAL_REVIEW: ['Under review ⏳', 'pending ⏳'],
  UNSUCCESSFUL: ['Failed ❌', 'false ❌'], EXPIRED: ['Expired ❌', 'false ❌'], CANCELLED: ['Cancelled ❌', 'false ❌'], NOT_FOUND: ['Not found ❌', 'false ❌'] };
export const statusDecor = (status) => { const d = DISPLAY[status] || [`${status} ❌`, 'false ❌']; return { status_display: d[0], successful: d[1] }; };
const rupeeText = (paise) => '₹' + (Number(paise) / 100).toFixed(2);
export function paymentResponse(o, status, requested = null) {
  const base = { Portal_Owner: PORTAL_OWNER, success: status === 'PAID', payment_received: status === 'PAID', status, ...statusDecor(status) };
  if (status === 'PAID' && o) {
    const when = o.payment_time || o.paid_at;
    return { ...base, message: `You have successfully received ${rupeeText(o.pay_amount)}${o.received_from ? ' from ' + o.received_from : ''}`,
      provider: o.provider || null, amount: asRupees(o.pay_amount), currency: o.currency || 'INR',
      order_id: o.id, payment_id: o.payment_id, transaction_id: o.transaction_id || null, utr: o.txn_ref || null,
      received_from: o.received_from || null, purpose: o.purpose || null, updated_balance: o.updated_balance != null ? asRupees(o.updated_balance) : null,
      date: fmtISTEmail(when), payment_time: when ? isoTime(when) : null,
      verification_source: VERIFICATION_SOURCE[o.verification_method] || o.verification_method || null,
      verified_at: o.paid_at ? isoTime(o.paid_at) : null, Powered_By: 'UnknownxGateway' };
  }
  return { ...base, order_id: o ? o.id : requested, payment_id: o ? o.payment_id : null, message: STATUS_MESSAGES[status] || 'Payment not found.', Powered_By: 'UnknownxGateway' };
}

/** A payment found in the merchant's alert e-mails by UTR / transaction id that is not (yet) tied to an order. status RECEIVED never equals PAID. */
export function receivedResponse(d) {
  return { Portal_Owner: PORTAL_OWNER, success: true, payment_received: true, status: 'RECEIVED', ...statusDecor('RECEIVED'),
    message: `You have successfully received ${rupeeText(d.amount)}${d.received_from ? ' from ' + d.received_from : ''}`, order_linked: !!d.order_id, order_id: d.order_id || null,
    provider: d.provider || null, amount: asRupees(d.amount), currency: 'INR', transaction_id: d.transaction_id || null, utr: d.utr || null,
    received_from: d.received_from || null, purpose: d.purpose || null, updated_balance: d.updated_balance != null ? asRupees(d.updated_balance) : null,
    date: fmtISTEmail(d.payment_time), payment_time: d.payment_time ? isoTime(d.payment_time) : null, verification_source: 'GMAIL_FAMAPP', Powered_By: 'UnknownxGateway' };
}
/** Lookup by UTR / transaction id with any valid key (see globalCheckPaymentApi).
 *  Envelope: Portal_Owner, success, payment_received, status, status_display (the only place with an emoji), then `details`.
 *  Order ids of merchants are never exposed: a found payment has NO order_id key at all (it is left out instead of being null); for NOT_FOUND it echoes the id the caller sent. */
export const LOOKUP_POWERED_BY = 'UnknownxFamGateway 🕊️';
const plainFlag = (v) => String(v).replace(/\s*[✅❌⏳]\s*/gu, '').trim();
export function lookupFailure(message, status = 'NOT_FOUND', extra = {}) {
  const d = statusDecor(status); const { searched_utr, ...rest } = extra;
  return { Portal_Owner: PORTAL_OWNER, success: false, payment_received: false, status, status_display: d.status_display,
    details: { ...(searched_utr !== undefined ? { searched_utr } : {}), successful: plainFlag(d.successful), ...rest, message, Powered_By: LOOKUP_POWERED_BY } };
}
/** details block of a found payment (same keys, same order, for every lookup endpoint). */
function lookupSuccess(r, orderId, keepPaid = false, searched = null) {
  const status = r.status === 'PAID' && !keepPaid ? 'RECEIVED' : r.status;   // a payment found by UTR / transaction id is "RECEIVED" (PAID only when asked by order id)
  return { Portal_Owner: PORTAL_OWNER, success: true, payment_received: true, status, status_display: statusDecor(status).status_display,
    details: { searched_utr: searched, successful: plainFlag(r.successful), message: r.message, ...(orderId != null ? { order_id: orderId } : {}), provider: r.provider, amount: r.amount, currency: r.currency,
      transaction_id: r.transaction_id, utr: r.utr, received_from: r.received_from, updated_balance: r.updated_balance,
      date: r.date, payment_time: r.payment_time, verification_source: r.verification_source, Powered_By: LOOKUP_POWERED_BY } };
}
export function publicLookupResponse(hit, ref) {
  if (!hit) return lookupFailure(STATUS_MESSAGES.NOT_FOUND, 'NOT_FOUND', { searched_utr: ref, order_id: ref, payment_id: null });
  const r = hit.order ? paymentResponse(hit.order, hit.order.status) : receivedResponse(hit.row);
  return r.success ? lookupSuccess(r, null, false, ref) : lookupFailure(r.message, r.status, { searched_utr: ref });
}
/** The merchant's own lookup (/gateway-api/{upi}/check_payment.php): same format, but it is THEIR order so the real order_id is shown.
 *  `status` stays PAID / PENDING / EXPIRED ... (integrations rely on it); only the layout of the rest moved into `details`. */
export function merchantLookupResponse(o, status, requested = null) {
  const r = paymentResponse(o, status, requested);
  const byOrderRef = !!o && (o.id === requested || o.payment_id === requested);   // asked by order id / payment id (e.g. the status_url) -> keep PAID
  return r.success ? lookupSuccess(r, r.order_id, byOrderRef, requested) : lookupFailure(r.message, r.status, { searched_utr: requested, order_id: r.order_id, payment_id: r.payment_id });
}
/** A payment found in the merchant's e-mails by UTR / transaction id (status RECEIVED; order_id only if it is tied to one of their orders). */
export const merchantReceivedResponse = (found, requested = null) => lookupSuccess(receivedResponse(found), found.order_id || null, false, requested);

// ---- merchant API-key authentication (personal keys stay UPI-scoped; shared keys resolve an eligible UPI owner) ----
// All randomly generated personal, admin-issued and shared keys are 7-digit numeric values. Explicit custom
// personal keys (4-40) and custom shared keys (2-49 letters/digits/_/-) remain supported.
const KEY_FORMAT_RE = /^[A-Za-z0-9_-]{2,49}$/;
export async function merchantByKey(env, key, upi = null) {
  if (!key || !KEY_FORMAT_RE.test(key)) return { user: null };
  const { sha256Hex } = await import('../lib/crypto.js');
  const keyHash = await sha256Hex(key);
  const u = await first(env, 'SELECT * FROM users WHERE api_key_hash = ?', keyHash);
  if (u) {
    if (upi !== null && String(u.upi || '').toLowerCase() !== upi.toLowerCase()) return { user: null };   // never let key A + UPI B through
    if (u.api_key_expires_at != null && u.api_key_expires_at <= now()) return { user: u, blocked: 'key_expired' };
    const st = await effectiveStatus(env, u);
    if (u.approval !== 'approved') return { user: null };
    if (st !== 'active') return { user: u, blocked: 'account_' + st };
    if (!u.api_enabled) return { user: u, blocked: 'api_disabled' };
    return { user: u, shared: false };
  }

  const sharedKey = await first(env, 'SELECT id, expires_at, revoked_at FROM shared_api_keys WHERE key_hash = ?', keyHash);
  if (!sharedKey || sharedKey.revoked_at != null) return { user: null };
  if (sharedKey.expires_at <= now()) return { user: null, blocked: 'key_expired' };
  if (upi == null || !String(upi).trim()) return { user: null, needsUpi: true, shared: true, sharedKeyId: sharedKey.id };

  const target = await first(env, 'SELECT * FROM users WHERE LOWER(upi) = LOWER(?)', String(upi).trim());
  if (!target) return { user: null };
  const st = await effectiveStatus(env, target);
  if (target.approval !== 'approved') return { user: null };
  if (st !== 'active') return { user: target, blocked: 'account_' + st, shared: true, sharedKeyId: sharedKey.id };
  if (!target.api_enabled) return { user: target, blocked: 'api_disabled', shared: true, sharedKeyId: sharedKey.id };
  await run(env, 'UPDATE shared_api_keys SET last_used_at = ? WHERE id = ?', now(), sharedKey.id);
  return { user: target, shared: true, sharedKeyId: sharedKey.id };
}

// ---- webhook signature: hex HMAC-SHA256 over "<timestamp>.<raw body>", timestamp within 5 minutes ----
export const webhookSignature = (secret, ts, raw) => hmacHex(secret, `${ts}.${raw}`);
export async function webhookSignatureOk(secret, ts, raw, sig, nowSec = now()) {
  if (!secret || !sig || !/^\d{9,12}$/.test(String(ts))) return false;
  if (Math.abs(nowSec - Number(ts)) > 300) return false;
  return safeEqual(await webhookSignature(secret, ts, raw), String(sig).toLowerCase());
}
