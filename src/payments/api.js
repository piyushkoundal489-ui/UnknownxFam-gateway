// Public merchant API. Every handler: rate limit -> authenticate (personal or shared API key) -> authorize -> act.
import { first, run, now } from '../lib/db.js';
import { sha256Hex, safeEqual } from '../lib/crypto.js';
import { readJson, readForm } from '../lib/http.js';
import { RULES, hit } from '../lib/ratelimit.js';
import { PORTAL_OWNER, ST, OPEN_STATES, parseAmount, createPayment, orderUpiUri, expireOrders, findUserOrder, paymentResponse, merchantByKey, claimEvent, finishEvent, releaseEvent, settleOrder, failOrder, markProcessing, markManualReview, webhookSignatureOk, orderEvent, isoTime, asRupees, receivedResponse, publicLookupResponse, lookupFailure, merchantLookupResponse, merchantReceivedResponse } from './core.js';
import { maybeReconcile, lookupPaymentByReference, lookupPaymentGlobal } from '../gmail/reconcile.js';
import { qrCodePng, placeholderPng } from '../lib/qr-png.js';

/** Prefers X-API-Key, then Authorization: Bearer, then ?key= (documented compatibility fallback). */
const apiKeyOf = (ctx) => {
  const h = ctx.request.headers; const b = (h.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return h.get('X-API-Key') || b || ctx.url.searchParams.get('key') || '';
};
const logApi = (ctx, userId, endpoint, status, orderId = null) =>
  ctx.defer(run(ctx.env, 'INSERT INTO api_activity(user_id,endpoint,method,status_code,ip,order_id,created_at) VALUES(?,?,?,?,?,?,?)', userId, endpoint, ctx.method, status, ctx.ip, orderId, now()));
const withHeaders = (ctx, res, o) => {
  if (!o) return res;
  if (o.status) res.headers.set('X-Payment-Status', o.status);
  if (o.transaction_id) res.headers.set('X-Transaction-ID', o.transaction_id);
  if (o.txn_ref) res.headers.set('X-UTR', o.txn_ref);
  if (o.pay_amount != null) res.headers.set('X-Amount', String(asRupees(o.pay_amount)));
  if (o.provider) res.headers.set('X-Provider', o.provider);
  return res;
};
function payResp(ctx, o, status, requested, http) {
  const res = ctx.json(paymentResponse(o, status, requested), http ?? (status === ST.NOT_FOUND ? 404 : 200));
  return withHeaders(ctx, res, o);
}
/** check_payment.php answers (lookup format: envelope + details). */
const lookupErr = (ctx) => (message, http) => ctx.json({ ...lookupFailure(message, 'NOT_FOUND', { searched_utr: (ctx.url.searchParams.get('id') || '').trim().slice(0, 64) || null }), status_display: 'Failed ❌' }, http);
function lookupResp(ctx, o, status, requested) {
  const res = ctx.json(merchantLookupResponse(o, status, requested), status === ST.NOT_FOUND ? 404 : 200);
  return withHeaders(ctx, res, o);
}
const paymentsDisabled = (ctx) => ctx.json({
  Portal_Owner: PORTAL_OWNER,
  success: false,
  payment_received: false,
  status: 'DISABLED',
  message: 'Payment actions are disabled on this temporary testing site.',
  Powered_By: 'UnknownxGateway',
}, 503);

/** Shared front door: IP limits + random 7-digit or explicit custom-key auth for the requested UPI ID. */
async function apiAuth(ctx, upi = null, err = null) {
  const E = (message, http) => (err ? err(message, http) : ctx.json({ Portal_Owner: PORTAL_OWNER, success: false, message, Powered_By: 'UnknownxGateway' }, http));
  const gate = (await ctx.blocked('api_bad_auth_ip', ctx.ip, RULES.api_bad_auth_ip, { json: true })) || (await ctx.limit('api_ip', ctx.ip, RULES.api_ip, { json: true }));
  if (gate) return { res: gate };
  const key = apiKeyOf(ctx);
  const { user, blocked, shared, needsUpi } = await merchantByKey(ctx.env, key, upi);
  if (needsUpi) {
    return { res: E('A UPI ID query parameter is required when using a shared API key', 400) };
  }
  if (blocked === 'key_expired') {
    return { res: E('This API key has expired', 403), user };
  }
  if (!user) { await hit(ctx.env, 'api_bad_auth_ip', ctx.ip, RULES.api_bad_auth_ip); return { res: null, invalid: true }; }
  if (blocked) {
    return { res: E('API access is disabled for this account', 403), user };
  }
  return { user, shared };
}
const badKeyResponse = (ctx, http) => ctx.json({ Portal_Owner: PORTAL_OWNER, success: false, payment_received: false, status: 'PENDING', message: apiKeyOf(ctx) ? 'Invalid UPI ID or API key' : 'Missing UPI ID or key', Powered_By: 'UnknownxGateway' }, http);

export async function createOrderApi(ctx) {
  if (!['GET', 'POST'].includes(ctx.method)) return ctx.json({ Portal_Owner: PORTAL_OWNER, success: false, message: 'Method not allowed', Powered_By: 'UnknownxGateway' }, 405);
  if (!ctx.c.paymentsEnabled) return paymentsDisabled(ctx);
  const upi = decodeURIComponent(ctx.params.upi || '').trim().toLowerCase();
  let amountRaw = ctx.url.searchParams.get('amount');
  if (ctx.method === 'POST' && !amountRaw) { const ct = ctx.request.headers.get('Content-Type') || ''; const b = ct.includes('json') ? await readJson(ctx.request) : await readForm(ctx.request); amountRaw = b.amount; }
  const a = await apiAuth(ctx, upi);
  if (a.invalid) return badKeyResponse(ctx, apiKeyOf(ctx) ? 401 : 400);
  if (a.res) { logApi(ctx, a.user?.id ?? 0, 'create_order', a.res.status); return a.res; }
  const u = a.user;
  const lim = await ctx.limit('api_key_create', 'u' + u.id, RULES.api_key_create, { json: true }); if (lim) return lim;
  const amt = parseAmount(amountRaw);
  if (amt === null) return ctx.json({ Portal_Owner: PORTAL_OWNER, success: false, message: 'Invalid amount (1 to 100000, max 2 decimals)', Powered_By: 'UnknownxGateway' }, 400);
  if (!u.upi) return badKeyResponse(ctx, 401);
  const r = await createPayment(ctx.env, u, amt);
  if (!r.ok) return ctx.json({
    Portal_Owner: PORTAL_OWNER, success: false, message: r.message,
    ...(r.existingOrderId ? { existing_order_id: r.existingOrderId } : {}),
    Powered_By: 'UnknownxGateway',
  }, r.http);
  const o = r.order; logApi(ctx, u.id, 'create_order', 200, o.id);
  return ctx.json({
    Portal_Owner: PORTAL_OWNER, success: true, status: ST.PENDING, payment_received: false,
    order_id: o.id, payment_id: o.payment_id, amount: asRupees(o.pay_amount),
    currency: o.currency, upi_id: o.upi, upi_link: orderUpiUri(o),
    qr_url: `${ctx.c.appUrl}/temporary/qr/${o.id}.png`,
    status_url: `${ctx.c.appUrl}/gateway-api/${encodeURIComponent(o.upi)}/key=${encodeURIComponent(apiKeyOf(ctx))}?id=${o.id}`,
    expires_in: o.expires_at - o.created_at, expires_at: isoTime(o.expires_at), Powered_By: 'UnknownxGateway',
  });
}

/** GET /api/payment/status?order_id= — read-only; another merchant's order looks like NOT_FOUND. */
export async function paymentStatusApi(ctx) {
  if (ctx.method !== 'GET') return ctx.json({ Portal_Owner: PORTAL_OWNER, success: false, message: 'GET only', Powered_By: 'UnknownxGateway' }, 405);
  const a = await apiAuth(ctx, ctx.url.searchParams.get('upi') || null);
  if (a.invalid) return badKeyResponse(ctx, 401);
  if (a.res) return a.res;
  const lim = await ctx.limit('api_key_verify', 'u' + a.user.id, RULES.api_key_verify, { json: true }); if (lim) return lim;
  await expireOrders(ctx.env);
  const ref = (ctx.url.searchParams.get('order_id') || ctx.url.searchParams.get('id') || '').trim();
  if (!ref || ref.length > 64) return payResp(ctx, null, ST.NOT_FOUND, ref || null);
  const o = await findUserOrder(ctx.env, a.user.id, ref);
  if (o && OPEN_STATES.includes(o.status)) ctx.defer(maybeReconcile(ctx.env, a.user.id));
  logApi(ctx, a.user.id, 'payment_status', o ? 200 : 404, o?.id ?? null);
  return o ? payResp(ctx, o, o.status) : payResp(ctx, null, ST.NOT_FOUND, ref);
}

/** /api/{upi}/check_payment.php?key=&id=   and   /api/{upi}/key=KEY?id=   — id may be UTR, transaction ID, or order ID. */
export async function checkPaymentApi(ctx) {
  const upi = decodeURIComponent(ctx.params.upi || '').trim().toLowerCase();
  const id = (ctx.url.searchParams.get('id') || '').trim();
  if (ctx.params.key) ctx.url.searchParams.set('key', decodeURIComponent(ctx.params.key));
  if (!id || id.length > 64 || !apiKeyOf(ctx)) return lookupErr(ctx)(apiKeyOf(ctx) ? 'Invalid UPI ID or API key' : 'Missing UPI ID or key', 400);
  const a = await apiAuth(ctx, upi, lookupErr(ctx));
  if (a.invalid) return lookupErr(ctx)('Invalid UPI ID or API key', 401);
  if (a.res) return a.res;
  const lim = await ctx.limit('api_key_verify', 'u' + a.user.id, RULES.api_key_verify, { json: true }); if (lim) return lim;
  await expireOrders(ctx.env);
  const o = await findUserOrder(ctx.env, a.user.id, id);
  if (o && OPEN_STATES.includes(o.status)) ctx.defer(maybeReconcile(ctx.env, a.user.id));
  if (!o) {   // not one of this merchant's orders: look the UTR / transaction id up in their payment e-mails
    const found = await lookupPaymentByReference(ctx.env, a.user, id).catch(() => null);
    logApi(ctx, a.user.id, 'check_payment', found ? 200 : 404, found?.order_id ?? null);
    if (found) return withHeaders(ctx, ctx.json(merchantReceivedResponse(found, id), 200), null);
    return lookupResp(ctx, null, ST.NOT_FOUND, id);
  }
  logApi(ctx, a.user.id, 'check_payment', 200, o.id);
  return lookupResp(ctx, o, o.status, id);
}

/** Public poll used by the pay page (order ids are unguessable). State only — no merchant data. */
export async function orderStatusApi(ctx) {
  const lim = await ctx.limit('pay_poll_ip', ctx.ip, RULES.pay_poll_ip, { json: true }); if (lim) return lim;
  await expireOrders(ctx.env);
  const id = (ctx.url.searchParams.get('order_id') || '').trim();
  const o = id && id.length <= 64 ? await first(ctx.env, 'SELECT * FROM orders WHERE LOWER(id) = LOWER(?)', id) : null;
  if (!o) return ctx.json({ status: 'error', state: ST.NOT_FOUND, message: 'Order not found' }, 404);
  if (o.status === 'PENDING' || o.status === 'PROCESSING') ctx.defer(maybeReconcile(ctx.env, o.user_id, 2));
  return ctx.json({ state: o.status, order_id: o.id, paid_at: o.paid_at, expires_in: Math.max(0, o.expires_at - now()) });
}

/** GET /temporary/qr/{order_id}.png — real PNG bytes, always (never JSON/HTML/redirect). Blocked once not open. */
export async function qrPngRoute(ctx) {
  if (!ctx.c.paymentsEnabled) return new Response(placeholderPng(), { status: 503, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
  const lim = await ctx.limit('pay_poll_ip', ctx.ip, RULES.pay_poll_ip); if (lim) return new Response(placeholderPng(), { status: 429, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
  await expireOrders(ctx.env);
  const id = String(ctx.params.order || '').replace(/\.png$/i, '');
  const o = /^ORDER_[A-F0-9]{12}$/i.test(id) ? await first(ctx.env, 'SELECT * FROM orders WHERE LOWER(id) = LOWER(?)', id) : null;
  const png = (bytes, status) => new Response(bytes, { status, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
  if (!o) return png(placeholderPng(), 404);
  if (!['PENDING', 'PROCESSING'].includes(o.status)) return png(placeholderPng(), 410);   // expired/paid/etc: never re-serve the active QR
  return png(qrCodePng(orderUpiUri(o)), 200);
}

/** Signed provider webhook (HMAC-SHA256 over "<timestamp>.<body>" with WEBHOOK_SECRET). Idempotent per event_id. */
export async function webhookApi(ctx) {
  if (!ctx.c.paymentsEnabled) return paymentsDisabled(ctx);
  if (ctx.method !== 'POST') return ctx.json({ status: 'error', message: 'POST only' }, 405);
  const gate = (await ctx.blocked('webhook_bad_ip', ctx.ip, RULES.webhook_bad_ip, { json: true })) || (await ctx.limit('webhook_ip', ctx.ip, RULES.webhook_ip, { json: true }));
  if (gate) return gate;
  if (!ctx.c.webhookSecret) return ctx.json({ status: 'error', message: 'Webhook not configured' }, 503);
  const raw = (await ctx.request.text()).slice(0, 65536);
  const ok = await webhookSignatureOk(ctx.c.webhookSecret, ctx.request.headers.get('X-Timestamp') || '', raw, ctx.request.headers.get('X-Signature') || '');
  if (!ok) { await hit(ctx.env, 'webhook_bad_ip', ctx.ip, RULES.webhook_bad_ip); return ctx.json({ status: 'error', message: 'Invalid signature' }, 401); }
  let j; try { j = JSON.parse(raw); } catch { j = null; }
  const eventId = String(j?.event_id || '').slice(0, 96), orderId = String(j?.order_id || ''), status = String(j?.status || '').toUpperCase();
  const amount = parseAmount(String(j?.amount ?? '')), currency = String(j?.currency || '').toUpperCase();
  const reference = j?.reference ? String(j.reference).trim().slice(0, 64) || null : null;
  if (!eventId || !/^ORDER_[A-F0-9]{12}$/i.test(orderId) || amount === null || !currency) return ctx.json({ status: 'error', message: 'event_id, order_id, amount and currency are required' }, 400);

  const o = await first(ctx.env, 'SELECT * FROM orders WHERE LOWER(id) = LOWER(?)', orderId);
  if (!(await claimEvent(ctx.env, 'provider', eventId, o?.id ?? null, o?.user_id ?? null))) return ctx.json({ status: 'duplicate', message: 'event already processed' });
  try {
    if (!o) { await finishEvent(ctx.env, 'provider', eventId, 'unknown_order'); return ctx.json({ status: 'error', message: 'order not found' }, 404); }
    await orderEvent(ctx.env, o.id, 'WEBHOOK', 'provider_webhook', { event_id: eventId, status });
    const meta = { transactionId: j?.transaction_id, receivedFrom: j?.received_from, purpose: j?.purpose, provider: j?.provider, updatedBalance: j?.updated_balance != null ? Math.round(Number(j.updated_balance) * 100) : null };
    if (status === 'PAID' || status === 'SUCCESS') {
      const r = await settleOrder(ctx.env, o.id, amount, currency, reference, 'provider_webhook', { reference_verified: reference !== null, amount_verified: true, ...meta });
      await finishEvent(ctx.env, 'provider', eventId, r.ok ? 'success' : r.code);
      if (r.ok) return ctx.json({ status: 'ok', order_id: o.id, result: r.code });
      return ctx.json({ status: 'rejected', reason: r.code }, ['amount_mismatch', 'currency_mismatch', 'duplicate_reference'].includes(r.code) ? 422 : 409);
    }
    if (status === 'UNSUCCESSFUL' || status === 'FAILED') { const ch = await failOrder(ctx.env, o.id, 'provider_webhook'); await finishEvent(ctx.env, 'provider', eventId, ch ? 'failed' : 'ignored'); return ctx.json({ status: 'ok', order_id: o.id, result: ch ? 'unsuccessful' : 'ignored' }); }
    if (status === 'PROCESSING' || status === 'PENDING') { const ch = await markProcessing(ctx.env, o.id, 'provider_webhook'); await finishEvent(ctx.env, 'provider', eventId, ch ? 'processing' : 'ignored'); return ctx.json({ status: 'ok', order_id: o.id, result: ch ? 'processing' : 'ignored' }); }
    await finishEvent(ctx.env, 'provider', eventId, 'ignored_status'); return ctx.json({ status: 'ok', result: 'ignored' });
  } catch (e) { await releaseEvent(ctx.env, 'provider', eventId); throw e; }
}

/** Merchant payment-alert receiver (e.g. a bank SMS/notification forwarder), authenticated by the merchant's secret. */
export async function verifyApi(ctx) {
  if (!ctx.c.paymentsEnabled) return paymentsDisabled(ctx);
  if (ctx.method !== 'POST') return ctx.json({ status: 'error', message: 'POST only' }, 405);
  const gate = (await ctx.blocked('webhook_bad_ip', ctx.ip, RULES.webhook_bad_ip, { json: true })) || (await ctx.limit('webhook_ip', ctx.ip, RULES.webhook_ip, { json: true }));
  if (gate) return gate;
  const ct = ctx.request.headers.get('Content-Type') || ''; const b = ct.includes('json') ? await readJson(ctx.request) : await readForm(ctx.request);
  const secret = String(b.secret || ''); const amt = parseAmount(String(b.amount ?? '')); let ref = String(b.txn_ref || b.utr || '').trim().slice(0, 64) || null; const oid = String(b.order_id || '').trim();
  if (!secret || amt === null) return ctx.json({ status: 'error', message: 'secret and a valid amount are required' }, 400);
  const { sha256Hex: h } = await import('../lib/crypto.js');
  const u = await first(ctx.env, 'SELECT * FROM users WHERE webhook_secret_hash = ?', await h(secret));
  if (!u || u.approval !== 'approved' || u.acct_status !== 'active' || !u.api_enabled) { await hit(ctx.env, 'webhook_bad_ip', ctx.ip, RULES.webhook_bad_ip); return ctx.json({ status: 'error', message: 'Invalid secret' }, 401); }
  await expireOrders(ctx.env);
  const { all } = await import('../lib/db.js');
  let cand;
  if (oid) { const o = await findUserOrder(ctx.env, u.id, oid); cand = o ? [o] : []; }
  else cand = await all(ctx.env, "SELECT * FROM orders WHERE user_id = ? AND status IN ('PENDING','PROCESSING') AND pay_amount = ? ORDER BY created_at ASC", u.id, amt);
  const key = ref ? `${u.id}:${ref}` : null;
  if (key && !(await claimEvent(ctx.env, 'forwarder', key, cand[0]?.id ?? null, u.id))) return ctx.json({ status: 'duplicate', message: 'txn_ref already used' });
  const meta = { transactionId: b.transaction_id, receivedFrom: b.received_from, purpose: b.purpose, provider: b.provider, updatedBalance: b.updated_balance != null ? Math.round(Number(b.updated_balance) * 100) : null };
  try {
    if (!cand.length) { if (key) await finishEvent(ctx.env, 'forwarder', key, 'no_match', { amount: amt }); logApi(ctx, u.id, 'verify', 200); return ctx.json({ status: 'no_match', message: 'No open order matches' }); }
    if (cand.length > 1) { if (key) await releaseEvent(ctx.env, 'forwarder', key); await markManualReview(ctx.env, cand[0].id, 'multiple open orders matched this amount', { source: 'merchant_forwarder' }); return ctx.json({ status: 'ambiguous', message: 'More than one open order matches; send order_id' }, 409); }
    const r = await settleOrder(ctx.env, cand[0].id, amt, 'INR', ref, 'provider_webhook', { amount_verified: true, reference_verified: !!(oid || ref), source: 'merchant_forwarder', ...meta });
    if (key) await finishEvent(ctx.env, 'forwarder', key, r.ok ? 'success' : r.code);
    logApi(ctx, u.id, 'verify', r.ok ? 200 : 422, cand[0].id);
    return r.ok ? ctx.json({ status: 'credited', order_id: cand[0].id }) : ctx.json({ status: 'rejected', reason: r.code }, 422);
  } catch (e) { if (key) await releaseEvent(ctx.env, 'forwarder', key); throw e; }
}

/**
 * GET /gateway-api/check_payment.php?id={UTR or transaction id}&key={any valid key}
 * No UPI id: anyone holding a valid key — a user's assigned key or a shared/public key — and a payment's UTR / transaction id can
 * read that payment's details. It never reveals order ids or the merchant's balance, and shows ✅ / ❌ for the result.
 */
export async function globalCheckPaymentApi(ctx) {
  const gate = (await ctx.blocked('api_bad_auth_ip', ctx.ip, RULES.api_bad_auth_ip, { json: true })) || (await ctx.limit('api_ip', ctx.ip, RULES.api_ip, { json: true }));
  if (gate) return gate;
  const id = (ctx.url.searchParams.get('id') || ctx.url.searchParams.get('utr') || ctx.url.searchParams.get('transaction_id') || '').trim();
  const key = apiKeyOf(ctx);
  const fail = (status, message) => ctx.json({ ...lookupFailure(message, 'NOT_FOUND', { searched_utr: id || null }), status_display: 'Failed ❌' }, status);
  if (!id || id.length > 64) return fail(400, 'Missing id (UTR or transaction ID)');
  if (!key) return fail(400, 'Missing API key');
  const k = await merchantByKey(ctx.env, key, null);            // personal key (no UPI needed) or shared key (needsUpi = a valid shared key)
  const validShared = !!k.needsUpi && !!k.sharedKeyId;
  const validPersonal = !!k.user && !k.blocked && !k.shared;
  if (k.blocked === 'key_expired') return fail(403, 'This API key has expired');
  if (!validShared && !validPersonal) {
    if (!k.user) await hit(ctx.env, 'api_bad_auth_ip', ctx.ip, RULES.api_bad_auth_ip);
    return k.user ? fail(403, 'API access is disabled for this key') : fail(401, 'Invalid API key');
  }
  if (validShared) await run(ctx.env, 'UPDATE shared_api_keys SET last_used_at = ? WHERE id = ?', now(), k.sharedKeyId);
  const found = await lookupPaymentGlobal(ctx.env, id);
  return ctx.json(publicLookupResponse(found, id), found ? 200 : 404);
}
