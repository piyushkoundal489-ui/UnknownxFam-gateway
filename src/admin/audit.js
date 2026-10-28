import { first, run, now } from '../lib/db.js';
import { fmtIST } from '../lib/time.js';
import { cfg } from '../lib/config.js';
import { buildEmail } from '../services/email-templates.js';

const SECRETISH = /pass(word)?|secret|token|api[_-]?key|otp|credential|authorization|cookie|refresh|encryption/i;
const SECRET_VALUE = /^(xfam_|whsec_|ya29\.|1\/\/|eyJ)/;
/** Deep-copies metadata, dropping anything that looks like a credential. Keys ending in "prefix" are allowed. */
export function scrub(v, depth = 0) {
  if (depth > 4 || v == null) return v ?? null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRETISH.test(k) && !/prefix$/i.test(k)) continue;
      o[k] = /prefix$/i.test(k) && typeof x === 'string' ? x.slice(0, 300) : scrub(x, depth + 1);   // *_prefix is safe to show even if it looks secret-shaped
    }
    return o;
  }
  if (typeof v === 'string') return SECRET_VALUE.test(v) ? '[redacted]' : v.slice(0, 300);
  return v;
}

/** Admin/system action log. adminId null = automatic system action. */
export async function audit(env, { adminId = null, targetUserId = null, action, reason = '', ip = '', metadata = {}, notify = true }) {
  await run(env, 'INSERT INTO audit_log(admin_id,target_user_id,action,reason,ip,metadata,created_at) VALUES(?,?,?,?,?,?,?)',
    adminId, targetUserId, action, String(reason || '').slice(0, 500), String(ip || ''), JSON.stringify(scrub(metadata) || {}), now());
  // Every admin / owner action on a user account also emails that user, with the reason (best effort, never blocks or breaks the action).
  if (notify && adminId && targetUserId && adminId !== targetUserId && NOTICES[action]) notifyUser(env, { targetUserId, action, reason, metadata }).catch(() => {});
}

/** What the user is told, per audited action. (API_KEY_CREATED / REISSUED / RENEWED have their own richer e-mails in actions.js, one of them carries the key itself.) */
const G = '#2fbf8f', R = '#e5484d', Y = '#e3a24a';
const NOTICES = {
  USER_APPROVED: { emoji: '🎉', subject: 'Your account was approved', title: 'Your account was approved!', status: 'Approved ✅', accent: G, cta: 'login',
    lines: ['Great news: your UnknownXfam Gateway account has been approved ✅', 'You can now log in with your Gmail address and start using your dashboard and API.'] },
  USER_REJECTED: { emoji: '😔', subject: 'Your account request was not approved', title: 'Your account request was not approved', status: 'Rejected ❌', accent: R,
    lines: ['We reviewed your account request and unfortunately it was not approved.'], note: 'If you think this is a mistake, message support and we will take another look.' },
  USER_FROZEN: { emoji: '🧊', subject: 'Your account was frozen', title: 'Your account was frozen', status: 'Frozen 🧊', accent: Y,
    lines: ['An administrator has frozen your account for now.'], note: 'Contact support if you would like this reviewed.' },
  USER_UNFROZEN: { emoji: '✅', subject: 'Your account is active again', title: 'Your account is active again', status: 'Active ✅', accent: G, cta: 'login',
    lines: ['Good news: your account has been restored and is active again.'] },
  USER_SUSPENDED: { emoji: '⏸️', subject: 'Your account was suspended', title: 'Your account was suspended', status: 'Suspended ⏸️', accent: Y,
    lines: ['An administrator has temporarily suspended your account.'], note: 'You can log in again once the suspension ends.' },
  USER_BANNED: { emoji: '🚫', subject: 'Your account was banned', title: 'Your account was banned', status: 'Banned 🚫', accent: R,
    lines: ['An administrator has banned your account.'], note: 'If you think this is a mistake, contact support.' },
  USER_FORCE_LOGOUT: { emoji: '🔒', subject: 'You were signed out', title: 'You were signed out', status: 'Signed out of all sessions 🔒', accent: Y, cta: 'login',
    lines: ['An administrator signed you out of all your sessions.'], note: 'You can log in again any time with your Gmail address.' },
  API_ACCESS_ENABLED: { emoji: '🟢', subject: 'API access enabled', title: 'API access is enabled', status: 'API access: ON 🟢', accent: G, cta: 'settings',
    lines: ['An administrator enabled API access on your account.'] },
  API_ACCESS_DISABLED: { emoji: '🔴', subject: 'API access disabled', title: 'API access is disabled', status: 'API access: OFF 🔴', accent: R,
    lines: ['An administrator disabled API access on your account. API requests will be refused until it is enabled again.'] },
  API_KEY_REVOKED: { emoji: '🗝️', subject: 'Your API key was revoked', title: 'Your API key was revoked', status: 'Key revoked 🗝️', accent: R,
    lines: ['An administrator revoked your API key. API requests with it are now refused.'] },
  EMAIL_VERIFIED_BY_ADMIN: { emoji: '✉️', subject: 'Your email was marked verified', title: 'Your email is verified', status: 'Email verified ✅', accent: G,
    lines: ['An administrator marked your email address as verified.'] },
  EMAIL_UNVERIFIED_BY_ADMIN: { emoji: '✉️', subject: 'Your email was marked unverified', title: 'Your email needs verifying', status: 'Email unverified ⚠️', accent: Y,
    lines: ['An administrator marked your email address as unverified.'] },
  USER_PASSWORD_RESET: { emoji: '🔐', subject: 'Your password was reset', title: 'Your password was reset', status: 'Password reset 🔐', accent: Y,
    lines: ['An administrator reset the password of your account.'], note: 'If you did not expect this, contact support right away.' },
  ROLE_CHANGED: { emoji: '👤', subject: 'Your account role was changed', title: 'Your account role was changed', status: 'Role updated 👤', accent: Y,
    lines: ['An administrator changed the role of your account.'] },
  PAYMENT_MANUALLY_CONFIRMED: { emoji: '💸', subject: 'A payment was confirmed manually', title: 'A payment was confirmed', status: 'Payment confirmed 💸', accent: G,
    lines: ['An administrator manually confirmed a payment on one of your orders.'] },
  USER_ACCOUNT_DELETED: { emoji: '🗑️', subject: 'Your account was deleted', title: 'Your account was deleted', status: 'Deleted 🗑️', accent: R,
    lines: ['An administrator deleted your account.'], note: 'If you think this is a mistake, contact support.' },
};
export const NOTICE_ACTIONS = Object.keys(NOTICES);

/** { subject, body (plain text), html } for one notice, in the shared e-mail layout (logo on top, emoji, details box, support footer). */
export function noticeText({ env = {}, name, action, reason, metadata = {} }) {
  const n = { ...NOTICES[action] }; const site = String(cfg(env).appUrl || '').replace(/\/$/, '');
  if (action === 'USER_APPROVED' && metadata.auto) n.lines = ['Great news: your UnknownXfam Gateway account was approved automatically ✅', 'You can now log in with your Gmail address and start using your dashboard and API.'];
  const rows = [['What happened', n.status], ['Reason', String(reason || '').trim() || 'No reason was provided.']];
  if (action === 'USER_SUSPENDED' && metadata.until) rows.push(['Suspended until', fmtIST(metadata.until)]);
  if (action === 'PAYMENT_MANUALLY_CONFIRMED' && metadata.order_id) rows.push(['Order', metadata.order_id]);
  if (action === 'ROLE_CHANGED' && metadata.role) rows.push(['New role', metadata.role]);
  rows.push(['Time', fmtIST(now())]);
  const cta = !site || !n.cta ? null : n.cta === 'login' ? { label: 'Log in to your dashboard', url: site + '/login' } : { label: 'Open your Settings', url: site + '/settings' };
  const { html, text } = buildEmail(env, { emoji: n.emoji, title: n.title, name, paragraphs: n.lines, rows, cta, note: n.note || '', accent: n.accent, preheader: n.lines[0] });
  return { subject: `${n.emoji} ${n.subject}`, body: text, html };
}

export async function notifyUser(env, { targetUserId, action, reason, metadata }) {
  const u = await first(env, 'SELECT name, email FROM users WHERE id = ?', targetUserId);
  const email = u?.email || (action === 'USER_ACCOUNT_DELETED' ? metadata?.email : null);   // a deleted account is no longer in the table
  if (!email) return;
  const { sendMail } = await import('../services/mail.js');                                   // lazy: avoids a load-time import cycle
  const { subject, body, html } = noticeText({ env, name: (u?.name || '').split(' ')[0], action, reason, metadata });
  await sendMail(env, email, subject, body, { htmlBody: html });
}
/** Per-user security activity (logins, resets, key changes). Never store secrets here. */
export async function securityEvent(env, { userId = null, type, ip = '', ua = '', meta = {} }) {
  await run(env, 'INSERT INTO security_events(user_id,type,ip,ua,meta,created_at) VALUES(?,?,?,?,?,?)',
    userId, type, String(ip || ''), String(ua || '').slice(0, 200), JSON.stringify(scrub(meta) || {}), now());
}
