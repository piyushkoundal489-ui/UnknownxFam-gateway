// API-key expiry e-mails: a daily reminder from 3 days before a user's key expires until it expires, then one
// "expired" notice. Runs from the 5-minute maintenance job; safe on several instances (a conditional UPDATE claims each
// notice before it is sent, and is rolled back if the e-mail could not be sent so it is retried on the next run).
import { all, run, now, changes } from '../lib/db.js';
import { cfg } from '../lib/config.js';
import { sendMail, mailConfigured } from './mail.js';
import { buildEmail } from './email-templates.js';
import { fmtIST } from '../lib/time.js';

export const NOTICE_WINDOW = 3 * 86400;      // start 3 days before expiry
export const NOTICE_GAP = 23.5 * 3600;       // at most one reminder per day (tolerates the 5-minute tick drift)
const EXPIRED_GRACE = 7 * 86400;             // no "expired" mail for keys that lapsed more than a week ago (e.g. right after this feature is deployed)
const SUPPORT = 'https://t.me/UnknownNvrDie';
export const SUPPORT_NAME = 'UnknownXfam Support';   // display name; the address is the Gmail connected under Admin → Support email
const when = fmtIST;

export function remainingText(secondsLeft) {
  if (secondsLeft < 3600) return 'in less than an hour';
  if (secondsLeft < 86400) { const h = Math.ceil(secondsLeft / 3600); return `in about ${h} hour${h === 1 ? '' : 's'}`; }
  const d = Math.ceil(secondsLeft / 86400); return `in ${d} day${d === 1 ? '' : 's'}`;
}
export function noticeMail(user, kind, expiresAt, t = now(), env = {}) {
  const name = (user.name || '').split(' ')[0] || '';
  const site = String(cfg(env).appUrl || '').replace(/\/$/, '');
  if (kind === 'expired') {
    const { html, text } = buildEmail(env, { emoji: '⚠️', title: 'Your API key has expired', name, accent: '#e5484d', preheader: 'API requests with your key are now refused.',
      paragraphs: ['Your UnknownXfam Gateway API key has expired, so API requests with it are now refused.', 'To keep accepting payments through the API, ask the admin to renew it.'],
      rows: [['Status', 'Expired ❌'], ['Expired on', when(expiresAt)]], cta: { label: 'Ask support to renew', url: SUPPORT },
      note: 'The key value stays the same after a renewal, so you do not need to change anything in your integration.' });
    return { subject: '⚠️ Your API key has expired', body: text, html };
  }
  const left = remainingText(expiresAt - t);
  const { html, text } = buildEmail(env, { emoji: '⏰', title: `Your API key expires ${left}`, name, preheader: `Renew it before ${when(expiresAt)} to keep your API working.`,
    paragraphs: ['Your UnknownXfam Gateway API key is about to expire. Ask the admin to renew it before then so your payment API keeps working without interruption.'],
    rows: [['Expires', when(expiresAt)], ['Time left', left.replace(/^in /, '')], ['Reminders', 'Once a day until it expires']], cta: { label: 'Contact support to renew', url: SUPPORT },
    note: 'After a renewal the key value stays the same, so you do not need to change anything in your integration.' });
  return { subject: `⏰ Your API key expires ${left}`, body: text, html };
}

/** Sends every notice that is due. Returns how many e-mails were sent. */
export async function sendKeyExpiryNotices(env, limit = 50) {
  if (!(await mailConfigured(env))) return 0;
  const t = now();
  const users = await all(env, `SELECT id, name, email, api_key_expires_at AS exp, key_notice_at, key_notice_for, key_notice_kind FROM users
    WHERE api_key_hash IS NOT NULL AND api_key_expires_at IS NOT NULL AND api_enabled = 1 AND approval = 'approved' AND acct_status = 'active' AND email_verified = 1
      AND api_key_expires_at <= ? AND api_key_expires_at > ? ORDER BY api_key_expires_at LIMIT ?`, t + NOTICE_WINDOW, t - EXPIRED_GRACE, limit);
  let sent = 0;
  for (const u of users) {
    const kind = u.exp > t ? 'reminder' : 'expired';
    const same = u.key_notice_for === u.exp;       // false after a renewal / replacement -> start over
    const due = kind === 'reminder' ? (!same || u.key_notice_at == null || t - u.key_notice_at >= NOTICE_GAP) : (!same || u.key_notice_kind !== 'expired');
    if (!due) continue;
    // claim first (another instance may be running), restore if the mail fails
    const claim = await run(env, `UPDATE users SET key_notice_at = ?, key_notice_for = ?, key_notice_kind = ?
      WHERE id = ? AND api_key_expires_at = ? AND key_notice_at IS NOT DISTINCT FROM ? AND key_notice_for IS NOT DISTINCT FROM ? AND key_notice_kind IS NOT DISTINCT FROM ?`,
      t, u.exp, kind, u.id, u.exp, u.key_notice_at, u.key_notice_for, u.key_notice_kind);
    if (!changes(claim)) continue;
    const m = noticeMail(u, kind, u.exp, t, env);
    const r = await sendMail(env, u.email, m.subject, m.body, { htmlBody: m.html, fromName: SUPPORT_NAME });
    if (r.ok) sent++;
    else {
      await run(env, 'UPDATE users SET key_notice_at = ?, key_notice_for = ?, key_notice_kind = ? WHERE id = ? AND key_notice_at = ?', u.key_notice_at, u.key_notice_for, u.key_notice_kind, u.id, t);
      if (r.error === 'not_configured') break;
    }
  }
  return sent;
}
