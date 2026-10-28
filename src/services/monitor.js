// Watchdog for payment checking. When Gmail checks keep failing (or the check loop stalls) the owner gets a Telegram message and an e-mail;
// when it works again, another one. A merchant whose Gmail access ended (they must reconnect) is reported too. It can only report problems
// the running app can see: if the whole app is down, use the external monitor on /health (see README, "Monitoring").
import { cfg } from '../lib/config.js';
import { first } from '../lib/db.js';
import { fmtIST } from '../lib/time.js';
import { currentHealth } from '../lib/health-state.js';
import { sendMail } from './mail.js';
import { buildEmail, escapeHtml } from './email-templates.js';

export const DEFAULT_CHAT = '7642584056';                    // the owner's Telegram user id (override with ALERT_TELEGRAM_CHAT_ID, "off" disables)
export const REMIND_EVERY_SEC = 1800;
const nowSec = () => Math.floor(Date.now() / 1000);
const off = (v) => ['off', '0', 'false', 'no', 'none'].includes(String(v ?? '').trim().toLowerCase());
export const alertsOn = (env) => !off(env.PAYMENT_ALERTS ?? '1');
export const chatId = (env) => (off(env.ALERT_TELEGRAM_CHAT_ID) ? '' : String(env.ALERT_TELEGRAM_CHAT_ID || DEFAULT_CHAT).trim());
export const alertEmail = (env) => (off(env.ALERT_EMAIL) ? '' : String(env.ALERT_EMAIL || cfg(env).adminEmail || '').trim());
const code = (v) => `<code>${escapeHtml(v)}</code>`;
const bi = (v) => `<b><i>${escapeHtml(v)}</i></b>`;                      // Telegram text: bold + italic ...
const EMOJI = { Since: '🕒', Time: '🕒', 'Back at': '🕒', 'Down for': '⏳', 'Was down for': '⏳', Problem: '⚠️', 'Open orders waiting': '🧾', Merchant: '🏪', Gmail: '📧', Reason: '❓' };
const TIMES = new Set(['Since', 'Time', 'Back at', 'Down for', 'Was down for']);   // ... except times, which stay plain monospace
const tgRow = ([k, v]) => `${EMOJI[k] || '▫️'} ${bi(k)}  ${TIMES.has(k) ? code(v) : bi(v)}`;
const mins = (sec) => { const m = Math.max(1, Math.round(sec / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

// ---- message texts (pure, so they can be tested)
export function buildAlert(env, kind, d = {}) {
  const site = String(cfg(env).appUrl || '').replace(/\/$/, ''), admin = site ? site + '/admin' : '';
  const open = d.openOrders != null ? ['Open orders waiting', String(d.openOrders)] : null;
  const M = {
    down: { emoji: '🚨', title: 'Payment checking stopped', accent: '#e5484d', lead: 'Gmail checks are failing, so new payments may <b>not</b> be verified right now.', plain: 'Gmail checks are failing, so new payments may not be verified right now.',
      rows: [['Since', fmtIST(d.since)], ['Problem', d.error || 'unknown'], open].filter(Boolean), foot: 'It keeps retrying every few seconds and will message you as soon as it works again.' },
    still: { emoji: '⏳', title: 'Payment checking is still down', accent: '#e5484d', lead: 'It has <b>not</b> recovered yet.', plain: 'It has not recovered yet.',
      rows: [['Down for', mins(d.downSec)], ['Since', fmtIST(d.since)], ['Problem', d.error || 'unknown'], open].filter(Boolean), foot: 'Next reminder in 30 minutes.' },
    recovered: { emoji: '✅', title: 'Payment checking is back', accent: '#2fbf8f', lead: 'Gmail checks work again. New payments are being verified.', plain: 'Gmail checks work again. New payments are being verified.',
      rows: [['Was down for', mins(d.downSec)], ['Back at', fmtIST(d.at)]], foot: 'Orders that were waiting are checked automatically.' },
    reconnect: { emoji: '⚠️', title: "A merchant's Gmail needs reconnecting", accent: '#e3a24a', lead: 'Payments for this merchant are <b>not</b> being verified until they reconnect Gmail (Dashboard → Gmail).', plain: 'Payments for this merchant are not being verified until they reconnect Gmail (Dashboard → Gmail).',
      rows: [['Merchant', d.merchant || '—'], ['Gmail', d.gmail || '—'], ['Reason', d.reason || '—'], ['Time', fmtIST(d.at)]], foot: 'Ask them to open Dashboard → Gmail and connect again.' },
    started: { emoji: '🟩', title: 'Gateway started', accent: '#2fbf8f', lead: 'The server just (re)started and alerts are active.', plain: 'The server just (re)started and alerts are active.',
      rows: [['Time', fmtIST(d.at)]], foot: 'You will get a message here if payment checking stops.' },
  }[kind];
  const telegram = '<blockquote>' + [`${M.emoji} ${bi(M.title.toUpperCase())}`, '', bi(M.plain), '', ...M.rows.map(tgRow), '', bi(M.foot),
    ...(admin && kind !== 'started' ? ['', `🔗 <a href="${escapeHtml(admin)}">${bi('Open admin panel')}</a>`] : [])].join('\n') + '</blockquote>';
  const mail = buildEmail(env, { emoji: M.emoji, title: M.title, greet: false, accent: M.accent, preheader: M.plain, paragraphs: [M.plain], rows: M.rows,
    cta: admin ? { label: 'Open admin panel', url: admin } : null, note: M.foot });
  return { telegram, subject: `${M.emoji} UnknownXfam Gateway: ${M.title}`, text: mail.text, html: mail.html };
}

// ---- delivery (replaceable in tests)
async function sendTelegram(env, text) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim(), chat = chatId(env); if (!token || !chat) return { ok: false, skipped: true };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }), signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { console.error(`alert: Telegram refused (HTTP ${r.status})${j.description ? ': ' + j.description : ''} — open the bot in Telegram and press Start once`); return { ok: false }; }
    return { ok: true };
  } catch { console.error('alert: Telegram network error'); return { ok: false }; }
}
async function sendEmail(env, a) {
  const to = alertEmail(env); if (!to) return { ok: false, skipped: true };
  const r = await sendMail(env, to, a.subject, a.text, { htmlBody: a.html }); if (!r.ok && r.error !== 'not_configured') console.error('alert: e-mail not sent:', r.error); return r;
}
export const transport = { telegram: sendTelegram, email: sendEmail };

/** Sends one alert to every enabled channel. Never throws. */
export async function sendAlert(env, kind, data) {
  if (!alertsOn(env)) return { telegram: { skipped: true }, email: { skipped: true } };
  const a = buildAlert(env, kind, data);
  const [telegram, email] = await Promise.all([transport.telegram(env, a.telegram).catch(() => ({ ok: false })), kind === 'started' ? { skipped: true } : transport.email(env, a).catch(() => ({ ok: false }))]);
  return { telegram, email };
}
const openOrders = async (env) => { try { return Number((await first(env, "SELECT COUNT(*) AS n FROM orders WHERE status IN ('PENDING','PROCESSING') AND expires_at > ?", nowSec())).n); } catch { return null; } };

// ---- the watchdog
const W = { down: false, since: 0, lastAlertAt: 0, reconnect: new Map(), timer: null };
/** One look at the health record; sends "down" / "still down" / "recovered" when needed. Called every 30 s. */
export async function evaluate(env, t = nowSec()) {
  const h = currentHealth(t);
  if (h.state === 'degraded' || h.state === 'stalled') {
    if (!W.down) { W.down = true; W.since = h.since; W.lastAlertAt = t; await sendAlert(env, 'down', { since: h.since, error: h.error, openOrders: await openOrders(env) }); return 'down'; }
    if (t - W.lastAlertAt >= REMIND_EVERY_SEC) { W.lastAlertAt = t; await sendAlert(env, 'still', { since: W.since, downSec: t - W.since, error: h.error, openOrders: await openOrders(env) }); return 'still'; }
    return 'waiting';
  }
  if (W.down) { const downSec = t - W.since; W.down = false; await sendAlert(env, 'recovered', { downSec, at: t }); return 'recovered'; }
  return 'ok';
}
/** A merchant's Gmail access ended (token revoked / expired at Google): tell the owner once per merchant per 6 hours. */
export async function notifyReconnect(env, userId, reason, t = nowSec()) {
  try {
    if (!alertsOn(env) || (W.reconnect.get(userId) || 0) > t - 6 * 3600) return false; W.reconnect.set(userId, t);
    const u = await first(env, 'SELECT u.name, u.email, g.email AS gmail FROM users u LEFT JOIN gmail_accounts g ON g.user_id = u.id WHERE u.id = ?', userId);
    await sendAlert(env, 'reconnect', { merchant: u ? `${u.name || 'User'} (${u.email})` : `user #${userId}`, gmail: u?.gmail, reason, at: t }); return true;
  } catch { return false; }
}
export function startMonitor(env, { announce = true } = {}) {
  W.timer = setInterval(() => evaluate(env).catch((e) => console.error('watchdog failed:', e.message)), 30000); W.timer.unref();
  if (announce && !off(env.ALERT_STARTUP ?? '1')) { const t = setTimeout(() => sendAlert(env, 'started', { at: nowSec() }).catch(() => {}), 8000); t.unref(); }
  return () => clearInterval(W.timer);
}
export const _watch = W;
