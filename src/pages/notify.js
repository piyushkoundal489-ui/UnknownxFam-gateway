// GET /notify/feed — what just happened to THIS signed-in merchant, for the bottom pop-ups (toast.js polls it every few seconds while a page is open).
// Real backend events only, with the real amounts: orders that became PAID, QR codes (orders) generated through the gateway, and payment e-mails that
// arrived but matched no open order. Nothing here changes any state.
import { all, now } from '../lib/db.js';
import { RULES } from '../lib/ratelimit.js';

/** 500 -> "₹500", 499.01 -> "₹499.01" (paise in). */
export const rupees = (paise) => { const v = Number(paise) / 100; return '₹' + (Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })); };
const WINDOW = 300;      // never look further back than 5 minutes (a long-idle tab must not replay history)
const OVERLAP = 5;       // re-read a few seconds the client already saw; the client de-duplicates by id, so nothing is missed at a second boundary

export async function notifyFeed(ctx) {
  const user = await ctx.user();
  if (!user || user.approval !== 'approved') return ctx.json({ error: 'login' }, 401);
  const lim = await ctx.limit('notify_user', String(user.id), RULES.notify_user); if (lim) return lim;
  const t = now(); const since = Math.floor(Number(ctx.url.searchParams.get('since')) || 0);
  if (!since) return ctx.json({ now: t, events: [] });                   // first call: just establish the starting point
  const from = Math.max(since - OVERLAP, t - WINDOW); const ev = [];
  const paid = await all(ctx.env, `SELECT id, pay_amount, paid_at, received_from FROM orders WHERE user_id = ? AND status = 'PAID' AND created_at > ? AND paid_at >= ? ORDER BY paid_at LIMIT 10`, user.id, from - 1800, from);
  for (const o of paid) ev.push({ id: 'paid:' + o.id, at: o.paid_at, kind: 'pay', text: `💸 Payment Received: You received ${rupees(o.pay_amount)} via QR generated from Gateway 🕊️` });
  const made = await all(ctx.env, `SELECT id, pay_amount, created_at FROM orders WHERE user_id = ? AND created_at >= ? ORDER BY created_at LIMIT 10`, user.id, from);
  for (const o of made) ev.push({ id: 'qr:' + o.id, at: o.created_at, kind: 'ok', text: `🔳 QR Generated: ${rupees(o.pay_amount)} payment QR is ready` });
  const loose = await all(ctx.env, `SELECT id, amount, received_from, created_at FROM gmail_payment_messages WHERE user_id = ? AND created_at >= ? AND order_id IS NULL AND amount IS NOT NULL
      AND result NOT IN ('sender_not_allowed','dkim_failed','not_credit','no_amount','ambiguous_amount') ORDER BY created_at LIMIT 10`, user.id, from);
  for (const m of loose) ev.push({ id: 'mail:' + m.id, at: m.created_at, kind: 'pay', text: `💸 Payment Received: You received ${rupees(m.amount)}${m.received_from ? ' from ' + m.received_from : ''} 🕊️` });
  ev.sort((a, b) => a.at - b.at);
  return ctx.json({ now: t, events: ev.slice(-10).map(({ id, kind, text }) => ({ id, kind, text })) });
}
