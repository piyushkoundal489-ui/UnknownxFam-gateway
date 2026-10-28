import { html, raw, jsonBlock } from '../lib/html.js';
import { INSTAGRAM_URL } from '../lib/social.js';
import { first, all } from '../lib/db.js';
import { money, orderUpiUri, expireOrders } from '../payments/core.js';
import { RULES } from '../lib/ratelimit.js';

export async function payPage(ctx) {
  if (!ctx.c.paymentsEnabled) return ctx.page(payShell(false, null, true), 503);
  const lim = await ctx.blocked('pay_poll_ip', ctx.ip, RULES.pay_poll_ip); if (lim) return lim;
  await expireOrders(ctx.env);
  const id = ctx.url.searchParams.get('o') || '';
  const o = id ? await first(ctx.env, 'SELECT o.*, u.name AS uname FROM orders o JOIN users u ON u.id = o.user_id WHERE LOWER(o.id) = LOWER(?)', id) : null;
  if (!o) return ctx.page(payShell(false, null), 404);
  const payee = o.payee_name || o.uname; const sym = (o.currency || 'INR') === 'INR' ? '₹' : o.currency + ' ';
  const data = { id: o.id, state: o.status, left: Math.max(0, o.expires_at - Math.floor(Date.now() / 1000)), upi: orderUpiUri(o, o.uname), amount: money(o.pay_amount), currency: o.currency || 'INR' };
  return ctx.page(payShell(true, { o, payee, sym, data }));
}

function payShell(found, d, disabled = false) {
  const cls = !found ? '' : { PAID: 'success', EXPIRED: 'expired', UNSUCCESSFUL: 'failed', CANCELLED: 'expired', MANUAL_REVIEW: 'review' }[d.o.status] || 'pending';
  return html`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${disabled ? 'Payments disabled for testing' : found ? `Pay ${d.sym}${money(d.o.pay_amount)}` : 'Payment not found'} — UnknownXfam Gateway</title>
<meta name="robots" content="noindex, nofollow"><link rel="icon" href="/assets/logo.webp">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/pay.css"><link rel="stylesheet" href="/assets/toast.css"><script src="/assets/toast.js" defer></script><script src="/assets/nopress.js" defer></script></head><body>
${!found ? html`<div class="card"><img class="logo" src="/assets/logo.webp" alt="Gateway logo"><h1>${disabled ? 'Payments are disabled' : 'Payment not found'}</h1><p class="payee">${disabled ? 'This temporary public test site does not create UPI payment links or process payments.' : 'This payment link is invalid.'}</p></div>` : html`
<main class="card ${cls}" id="card">
  <img class="logo" src="/assets/logo.webp" alt="UnknownXfam Gateway logo">
  <div class="payee">Paying ${d.payee}</div>
  <div class="amount">${d.sym}${money(d.o.pay_amount)}</div>
  <div role="note" style="margin:14px 0;padding:10px 12px;border:1px solid #e3b341;border-radius:10px;background:#fff8e5;color:#654b14;font-size:13px;line-height:1.45;">Temporary public test site: this UPI payment transfers real money directly to the merchant. Pay only if you intend to make this payment.</div>
  <div class="status"><span class="dot"></span><span id="stText">Payment Pending</span></div>
  <div class="live">
    <canvas id="qr" aria-label="UPI payment QR code"></canvas>
    <div class="scan">UPI<b>Scan &amp; Pay</b></div>
    <a class="btn" href="${d.data.upi}">Open in UPI app</a>
    <div class="meta">Expires in <span id="timer" class="timer">${String(Math.floor(d.data.left / 60)).padStart(1, '0')}:${String(d.data.left % 60).padStart(2, '0')}</span></div>
  </div>
  <div class="final ok"><b>Payment received</b><br>Thank you! You can close this page.</div>
  <div class="final exp"><b>Payment expired</b><br>This QR is no longer valid. Please start a new payment.</div>
  <div class="final bad"><b>Payment failed</b><br>The payment was not completed. Please try again.</div>
  <div class="final review"><b>Verifying your payment</b><br>We found a matching payment and are double-checking it. This page will update automatically.</div>
  <div class="meta">Order:<br><span class="mono">${d.o.id}</span><br>Status: <span id="stLine">● Waiting for payment</span><br><button class="btn" id="refresh" type="button">Refresh status</button></div>
  <ol class="steps live"><li>Open any UPI app (GPay, PhonePe, Paytm, BHIM…).</li><li>Scan this QR code.</li><li>Pay exactly <b style="color:var(--ink)">${d.sym}${money(d.o.pay_amount)}</b>.</li><li>Keep this page open — it updates automatically.</li></ol>
  <footer>Powered by <b>UnknownXFamgateway</b><br>Made By - <b>@UnknownNvrDie</b></footer>
  <div class="support-row"><a class="support-strip" href="https://t.me/UnknownNvrDie" target="_blank" rel="noopener noreferrer"><span class="ss-ic"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.5 3.6 2.9 10.8c-1.3.5-1.2 1.3-.2 1.6l4.7 1.5 1.8 5.6c.2.6.4.8.9.8s.7-.2 1-.5l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8L22.9 5c.3-1.2-.4-1.7-1.4-1.4zM9 13.6l9.3-5.9c.4-.3.8-.1.5.2l-7.6 6.9-.3 3.2z"/></svg></span><span>Support - <b>@UnknownNvrDie</b></span></a><a class="support-strip follow-strip" href="${INSTAGRAM_URL}" target="_blank" rel="noopener noreferrer" aria-label="Follow us on Instagram"><span class="ss-ic"><img src="/assets/instagram.webp" alt="" width="20" height="20" loading="lazy"></span><span><b>Follow us</b></span></a><span class="ss-break"></span><a class="support-strip designed-strip" href="https://www.instagram.com/myslf_kavyaa?exln=bGpoZGRjNXA0YTFm" target="_blank" rel="noopener noreferrer"><span class="ss-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14"/></svg></span><span>Designed By</span></a></div>
</main>
<script type="application/json" id="pay-data">${jsonBlock(d.data)}</script>
<script src="/assets/qr.js"></script><script src="/assets/qr-style.js"></script><script src="/assets/pay.js"></script>`}
</body></html>`;
}
