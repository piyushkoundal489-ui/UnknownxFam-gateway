// Server-side admin actions. Every function re-checks authorize() itself — never trust the caller already checked.
import { first, all, run, now, changes, isUnique, batch, stmt } from '../lib/db.js';
import { authorize, RANK } from './rbac.js';
import { audit } from './audit.js';
import { forceLogout } from '../auth/session.js';
import { issueApiKey, revokeApiKey, getUser, setApiKey, KeyError } from '../auth/accounts.js';
import { randomInt, sha256Hex, open, seal } from '../lib/crypto.js';
import { releaseGrant } from '../gmail/connection.js';
import { cfg } from '../lib/config.js';
import { settleOrder } from '../payments/core.js';
import { getMailSettings, mailConfigured } from '../services/mail.js';
import { otpIssue, otpIssueManual } from '../services/otp.js';
import { fmtIST } from '../lib/time.js';
import { visibleOrdersSql } from '../lib/order-visibility.js';

const STATUSES = ['active', 'frozen', 'suspended', 'banned'];

export async function listUsers(env, { q = '', status = '', role = '', approval = '', verifiedOnly = false, hideUnverifiedPending = false, page = 1, pageSize = 25 } = {}) {
  const where = ['1=1']; const args = [];   // always-true base clause simplifies concatenation below
  if (q) { where.push('(name ILIKE ? OR email ILIKE ? OR upi ILIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('acct_status = ?'); args.push(status); }
  if (role) { where.push('role = ?'); args.push(role); }
  if (approval) { where.push('approval = ?'); args.push(approval); }
  if (hideUnverifiedPending) where.push("(approval <> 'pending' OR email_verified = 1)");   // Users list: sign-ups that never confirmed their e-mail code stay out of sight
  if (verifiedOnly) where.push('email_verified = 1');   // Pending approvals: only accounts that confirmed their e-mail code
  const offset = Math.max(0, (page - 1) * pageSize);
  const rows = await all(env, `SELECT id,name,email,role,acct_status,approval,email_verified,api_enabled,upi,last_known_balance,last_balance_at,suspended_until,created_at,last_login_at FROM users WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset);
  const cnt = await first(env, `SELECT COUNT(*) AS n FROM users WHERE ${where.join(' AND ')}`, ...args);
  return { rows, total: cnt.n, page, pageSize };
}
export const userDetail = (env, id) => first(env, 'SELECT * FROM users WHERE id = ?', id);
export const userOrders = (env, id, limit = 50) => all(env, `SELECT * FROM orders WHERE user_id = ? AND ${visibleOrdersSql()} ORDER BY created_at DESC LIMIT ?`, id, now(), limit);   // paid / needs-review / QR still valid
export const userApiActivity = (env, id, limit = 50) => all(env, 'SELECT * FROM api_activity WHERE user_id = ? ORDER BY id DESC LIMIT ?', id, limit);
export const userSecurityEvents = (env, id, limit = 50) => all(env, 'SELECT * FROM security_events WHERE user_id = ? ORDER BY id DESC LIMIT ?', id, limit);
export const auditForTarget = (env, id, limit = 50) => all(env, 'SELECT * FROM audit_log WHERE target_user_id = ? ORDER BY id DESC LIMIT ?', id, limit);
export const auditLog = (env, { limit = 100 } = {}) => all(env, 'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit);

/** @returns {{ok:true}|{ok:false,reason:string}} — every mutating action funnels through here. */
async function guarded(env, actor, perm, targetId, fn) {
  const target = targetId ? await getUser(env, targetId) : null;
  if (targetId && !target) return { ok: false, reason: 'user not found' };
  const a = authorize(actor, perm, target);
  if (!a.ok) return a;
  return fn(target);
}

export async function setStatus(env, actor, targetId, status, reason, ip, suspendMinutes = null) {
  return guarded(env, actor, 'users.status', targetId, async (target) => {
    if (!STATUSES.includes(status)) return { ok: false, reason: 'bad status' };
    const until = status === 'suspended' ? now() + Math.max(1, Number(suspendMinutes) || 60) * 60 : null;
    await run(env, 'UPDATE users SET acct_status=?, suspended_until=?, status_reason=?, status_changed_at=? WHERE id=?', status, until, reason || null, now(), target.id);
    // A freeze intentionally leaves the website session alive, but suspension and ban
    // must invalidate every open session immediately.
    if (status === 'banned' || status === 'suspended') await forceLogout(env, target.id);
    const action = { active: 'USER_UNFROZEN', frozen: 'USER_FROZEN', suspended: 'USER_SUSPENDED', banned: 'USER_BANNED' }[status];
    await audit(env, { adminId: actor.id, targetUserId: target.id, action, reason, ip, metadata: { until } });
    return { ok: true };
  });
}
export async function forceLogoutUser(env, actor, targetId, reason, ip) {
  return guarded(env, actor, 'users.force_logout', targetId, async (target) => {
    await forceLogout(env, target.id);
    await audit(env, { adminId: actor.id, targetUserId: target.id, action: 'USER_FORCE_LOGOUT', reason, ip });
    return { ok: true };
  });
}
export async function setApiEnabled(env, actor, targetId, enabled, reason, ip) {
  return guarded(env, actor, 'users.api', targetId, async (target) => {
    await run(env, 'UPDATE users SET api_enabled = ? WHERE id = ?', enabled ? 1 : 0, target.id);
    await audit(env, { adminId: actor.id, targetUserId: target.id, action: enabled ? 'API_ACCESS_ENABLED' : 'API_ACCESS_DISABLED', reason, ip });
    return { ok: true };
  });
}
export async function revokeUserApiKey(env, actor, targetId, reason, ip) {
  return guarded(env, actor, 'users.api', targetId, async (target) => {
    await revokeApiKey(env, target.id);
    await audit(env, { adminId: actor.id, targetUserId: target.id, action: 'API_KEY_REVOKED', reason, ip });
    return { ok: true };
  });
}
/** E-mails a freshly issued API key (the key value is IN the mail, as the owner asked). Best effort: returns true if it was sent. The key is never written to the audit log. */
async function emailIssuedKey(env, actor, target, key, { replaced = false, reason = '' } = {}) {
  try {
    const { sendMail, mailConfigured } = await import('../services/mail.js');
    if (!(await mailConfigured(env))) return false;
    const { buildEmail } = await import('../services/email-templates.js');
    const row = await first(env, 'SELECT api_key_expires_at AS exp, upi FROM users WHERE id = ?', target.id);
    const site = String(cfg(env).appUrl || '').replace(/\/$/, '');
    const by = actor && actor.role === 'SUPER_ADMIN' ? 'the owner' : 'an administrator';
    const { html, text } = buildEmail(env, { emoji: '🔑', title: replaced ? 'Your new API key is ready' : 'Your API key is ready', name: (target.name || '').split(' ')[0], accent: '#2fbf8f',
      preheader: 'Your UnknownXfam Gateway API key is inside.',
      paragraphs: [replaced ? `Your API key was replaced by ${by}. The old key no longer works, so please update your integration with the new key below.` : `An API key has been issued to you by ${by}. Here it is:`],
      rows: [['Your API key', key, { mono: true }], ['Valid until', row?.exp ? fmtIST(row.exp) : 'Never expires ♾️'], ...(row?.upi ? [['Your UPI ID', row.upi]] : []),
        ...(String(reason || '').trim() ? [['Note', String(reason).trim()]] : []), ['Issued on', fmtIST(now())]],
      cta: site ? { label: 'Open your Settings', url: site + '/settings' } : null,
      note: 'Keep this key private: anyone who has it can create orders and check payments on your account. If it ever leaks, contact support and we will replace it.' });
    return (await sendMail(env, target.email, replaced ? '🔑 Your new API key' : '🔑 Your API key was issued', text, { htmlBody: html, fromName: 'UnknownXfam Support' })).ok;
  } catch { return false; }
}
export async function reissueUserApiKey(env, actor, targetId, reason, ip) {
  return guarded(env, actor, 'users.api', targetId, async (target) => {
    const key = await issueApiKey(env, target.id);
    await audit(env, { adminId: actor.id, targetUserId: target.id, action: 'API_KEY_REISSUED', reason, ip });
    const emailed = await emailIssuedKey(env, actor, target, key, { replaced: true, reason });
    return { ok: true, key, emailed };              // shown once to the admin doing the reissue; never stored in the log
  });
}
/**
 * Full "Create API key" tool: an admin may set a random 7-digit key (default) OR a custom value, with either no
 * expiry ("infinite") or a custom duration. Works for ANY approved user, replacing whatever key they had — the new
 * key is what then shows up in that user's own Settings page. The raw key value is returned once for the admin to
 * copy/hand over, and is never written to the audit log (only that the action happened, and whether it was custom
 * and/or time-limited).
 * @param {object} opts
 * @param {string} [opts.customKey] - literal key value to use; omit/blank for a random 7-digit key
 * @param {number} [opts.durationSeconds] - omit/0 for infinite (never expires)
 */
export async function createApiKeyForUser(env, actor, targetId, opts, reason, ip) {
  return guarded(env, actor, 'users.api', targetId, async (target) => {
    let result;
    try { result = await setApiKey(env, target.id, { customKey: opts.customKey || undefined, expiresInSeconds: opts.durationSeconds > 0 ? opts.durationSeconds : null }); }
    catch (e) { if (e instanceof KeyError) return { ok: false, reason: e.message }; throw e; }
    await audit(env, { adminId: actor.id, targetUserId: target.id, action: 'API_KEY_CREATED', reason, ip,
      metadata: { custom: !!opts.customKey, infinite: result.expiresAt == null, expires_at: result.expiresAt } });
    const emailed = await emailIssuedKey(env, actor, target, result.key, { reason });
    return { ok: true, key: result.key, expiresAt: result.expiresAt, emailed };
  });
}

export const SHARED_CUSTOM_KEY_RE = /^[A-Za-z0-9_-]{2,49}$/;   // custom shared keys: 2-49 letters/digits/_/- (short ones are easy to guess — the admin form warns about it)
export async function createSharedApiKey(env, actor, durationDays, reason, ip, customKey = '') {
  const permission = authorize(actor, 'shared_api.manage');
  if (!permission.ok) return permission;
  const auditReason = String(reason || '').trim();
  if (!auditReason) return { ok: false, reason: 'A reason is required to create a shared key.' };
  const days = Number(durationDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, reason: 'Choose an expiry between 1 and 365 days.' };
  const expiresAt = now() + days * 86400;

  const custom = String(customKey || '').trim();
  if (custom) {
    if (!SHARED_CUSTOM_KEY_RE.test(custom)) return { ok: false, reason: 'A custom shared key must be 2-49 letters, numbers, "_" or "-".' };
    const customHash = await sha256Hex(custom);
    if (await first(env, 'SELECT id FROM users WHERE api_key_hash = ?', customHash) || await first(env, 'SELECT id FROM shared_api_keys WHERE key_hash = ?', customHash)) {
      return { ok: false, reason: 'That key value is already in use (or was used before). Choose a different one.' };
    }
    try {
      await run(env, 'INSERT INTO shared_api_keys(key_hash,key_enc,created_by,created_at,expires_at) VALUES(?,?,?,?,?)',
        customHash, await seal(cfg(env).encryptionKey, custom), actor.id, now(), expiresAt);
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: 'That key value is already in use. Choose a different one.' };
      throw e;
    }
    await audit(env, { adminId: actor.id, targetUserId: null, action: 'SHARED_API_KEY_CREATED', reason: auditReason, ip, metadata: { expires_at: expiresAt, custom: true } });
    return { ok: true, key: custom, expiresAt, custom: true };
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const key = String(1_000_000 + randomInt(9_000_000));
    const keyHash = await sha256Hex(key);
    if (await first(env, 'SELECT id FROM users WHERE api_key_hash = ?', keyHash)) continue;
    try {
      await run(env, 'INSERT INTO shared_api_keys(key_hash,key_enc,created_by,created_at,expires_at) VALUES(?,?,?,?,?)',
        keyHash, await seal(cfg(env).encryptionKey, key), actor.id, now(), expiresAt);
    } catch (e) {
      if (isUnique(e)) continue;
      throw e;
    }
    await audit(env, { adminId: actor.id, targetUserId: null, action: 'SHARED_API_KEY_CREATED', reason: auditReason, ip,
      metadata: { expires_at: expiresAt } });
    return { ok: true, key, expiresAt };
  }
  return { ok: false, reason: 'Could not generate a unique shared key. Try again.' };
}

export async function revokeSharedApiKey(env, actor, keyId, reason, ip) {
  const permission = authorize(actor, 'shared_api.manage');
  if (!permission.ok) return permission;
  const auditReason = String(reason || '').trim();
  if (!auditReason) return { ok: false, reason: 'A reason is required to revoke a shared key.' };
  const id = Number(keyId);
  if (!Number.isSafeInteger(id) || id < 1) return { ok: false, reason: 'Invalid shared key.' };
  const existing = await first(env, 'SELECT id, revoked_at FROM shared_api_keys WHERE id = ?', id);
  if (!existing || existing.revoked_at != null) return { ok: false, reason: 'Shared key not found or already revoked.' };
  await run(env, 'UPDATE shared_api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), id);
  await audit(env, { adminId: actor.id, targetUserId: null, action: 'SHARED_API_KEY_REVOKED', reason: auditReason, ip,
    metadata: { shared_api_key_id: id } });
  return { ok: true };
}
export async function listSharedApiKeys(env) {
  const rows = await all(env, 'SELECT id, created_at, expires_at, last_used_at, key_enc FROM shared_api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 50');
  const k = cfg(env).encryptionKey;
  return Promise.all(rows.map(async ({ key_enc, ...r }) => {            // the key itself is shown in the admin table (admin-only page)
    let value = null; if (key_enc) { try { value = await open(k, key_enc); } catch { value = null; } }
    return { ...r, can_show: value != null, value };
  }));
}

/** Shows an active shared key again (SUPER_ADMIN only, audited). Keys made before key storage existed cannot be shown. */
export async function revealSharedApiKey(env, actor, keyId, ip) {
  const permission = authorize(actor, 'shared_api.manage');
  if (!permission.ok) return permission;
  const id = Number(keyId);
  if (!Number.isSafeInteger(id) || id < 1) return { ok: false, reason: 'Invalid shared key.' };
  const row = await first(env, 'SELECT id, key_enc, expires_at, revoked_at FROM shared_api_keys WHERE id = ?', id);
  if (!row || row.revoked_at != null) return { ok: false, reason: 'Shared key not found or revoked.' };
  if (!row.key_enc) return { ok: false, reason: 'This key was created before keys could be shown again, so its value cannot be recovered. Generate a new key.' };
  const key = await open(cfg(env).encryptionKey, row.key_enc);
  await audit(env, { adminId: actor.id, targetUserId: null, action: 'SHARED_API_KEY_VIEWED', ip, metadata: { shared_api_key_id: id } });
  return { ok: true, key, expiresAt: row.expires_at };
}

export async function setEmailVerified(env, actor, targetId, verified, reason, ip) {
  return guarded(env, actor, 'users.email_verify', targetId, async (target) => {
    await run(env, 'UPDATE users SET email_verified = ? WHERE id = ?', verified ? 1 : 0, target.id);
    await audit(env, { adminId: actor.id, targetUserId: target.id, action: verified ? 'EMAIL_VERIFIED_BY_ADMIN' : 'EMAIL_UNVERIFIED_BY_ADMIN', reason, ip });
    return { ok: true };
  });
}
export async function decideApproval(env, actor, targetId, approve, reason, ip) {
  return guarded(env, actor, 'users.approve', targetId, async (target) => {
    if (approve) {
      const settings = await getMailSettings(env);
      if (target.role === 'USER' && settings.otp_signup === '1' && !target.email_verified)
        return { ok: false, reason: 'verify the user email before approving this account' };
      // API keys are NEVER created automatically: an admin issues one from the user's admin page and hands it over manually.
      const { issueWebhookSecret: mkw } = await import('../auth/accounts.js');
      if (!target.webhook_secret_hash) await mkw(env, target.id);
      await run(env, "UPDATE users SET approval='approved', decided_at=? WHERE id=?", now(), target.id);
    } else await run(env, "UPDATE users SET approval='rejected', decided_at=? WHERE id=?", now(), target.id);
    await audit(env, { adminId: actor.id, targetUserId: target.id, action: approve ? 'USER_APPROVED' : 'USER_REJECTED', reason, ip });
    return { ok: true };
  });
}
/** Admin-initiated password reset: sets a random password and force-logs-out; the admin never learns the password. */
export async function adminResetPassword(env, actor, targetId, reason, ip) {
  return guarded(env, actor, 'users.password_reset', targetId, async (target) => {
    // Do not create an unknown password that leaves the user locked out. Instead,
    // issue a short-lived reset code for the admin to hand to the user. The code
    // is stored only as a salted HMAC and can be used at /reset-password?email=...
    const reset = await otpIssueManual(env, 'reset', target.email, target.id);
    await forceLogout(env, target.id);
    await audit(env, { adminId: actor.id, targetUserId: target.id, action: 'USER_PASSWORD_RESET', reason, ip });
    return { ok: true, note: `Reset code for ${target.email}: ${reset.code} (valid for 10 minutes; give it to the user with /reset-password?email=${encodeURIComponent(target.email)})` };
  });
}
export async function resendVerification(env, actor, targetId, reason, ip) {
  return guarded(env, actor, 'support.resend_verification', targetId, async (target) => {
    if (target.role !== 'USER') return { ok: false, reason: 'verification codes are only for user accounts' };
    if (target.email_verified) return { ok: false, reason: 'this email is already verified' };
    const settings = await getMailSettings(env);
    if (settings.otp_signup !== '1') return { ok: false, reason: 'sign-up email verification is switched off' };
    if (!(await mailConfigured(env))) return { ok: false, reason: 'sender Gmail is not connected' };
    const result = await otpIssue(env, 'signup', target.email, target.id);
    if (!result.ok) return { ok: false, reason: result.code === 'cooldown' ? `please wait ${result.wait || 60} seconds before resending` : result.code === 'rate_limited' ? 'too many codes were requested for this address' : 'the verification email could not be sent' };
    await audit(env, { adminId: actor.id, targetUserId: target.id, action: 'EMAIL_VERIFICATION_RESENT', reason, ip });
    return { ok: true, note: 'Verification email sent.' };
  });
}
/**
 * Permanently deletes a user and everything tied to them (orders, payments, Gmail link, sessions, logs) so the same
 * email / UPI ID can register again from scratch. Admin audit entries are kept (they only reference the numeric id).
 */
export async function deleteUserAccount(env, actor, targetId, reason, ip) {
  return guarded(env, actor, 'users.delete', targetId, async (target) => {
    const c = cfg(env);
    if (c.adminEmail && String(target.email).toLowerCase() === String(c.adminEmail).toLowerCase()) return { ok: false, reason: 'the super admin account cannot be deleted' };
    // Revoke the user's Gmail access at Google first (best effort — never blocks the deletion).
    try {
      const g = await first(env, 'SELECT email, refresh_token_enc FROM gmail_accounts WHERE user_id = ?', target.id);
      if (g) { const rt = await open(c.encryptionKey, g.refresh_token_enc); if (rt) await releaseGrant(env, { email: g.email, refreshToken: rt, exceptUserId: target.id }); }
    } catch (e) { console.error('gmail revoke during account delete failed:', e.message); }
    const own = 'SELECT id FROM orders WHERE user_id = ?';
    const id = target.id;
    await batch(env, [
      stmt(env, `DELETE FROM payment_matches WHERE order_id IN (${own})`, id),
      stmt(env, `DELETE FROM order_events WHERE order_id IN (${own})`, id),
      stmt(env, `DELETE FROM payment_events WHERE user_id = ? OR order_id IN (${own})`, id, id),
      stmt(env, 'DELETE FROM payments WHERE user_id = ?', id),
      stmt(env, 'DELETE FROM gmail_payment_messages WHERE user_id = ?', id),
      stmt(env, 'DELETE FROM api_activity WHERE user_id = ?', id),
      stmt(env, 'DELETE FROM security_events WHERE user_id = ?', id),
      stmt(env, 'DELETE FROM email_otps WHERE user_id = ? OR LOWER(email) = LOWER(?)', id, target.email),
      stmt(env, 'DELETE FROM oauth_states WHERE user_id = ?', id),
      stmt(env, 'DELETE FROM orders WHERE user_id = ?', id),
      stmt(env, 'DELETE FROM users WHERE id = ?', id),   // sessions + gmail_accounts cascade; shared key ownership is set to NULL
    ]);
    await audit(env, { adminId: actor.id, targetUserId: id, action: 'USER_ACCOUNT_DELETED', reason, ip, metadata: { email: target.email, role: target.role } });
    return { ok: true, note: `Account ${target.email} was permanently deleted. They can register again from scratch.` };
  });
}
export async function setRole(env, actor, targetId, role, reason, ip) {
  return guarded(env, actor, 'roles.manage', targetId, async (target) => {
    if (!['USER', 'SUPPORT', 'ADMIN'].includes(role)) return { ok: false, reason: 'cannot assign that role here' };
    if (target.role === 'SUPER_ADMIN') return { ok: false, reason: 'cannot change the super admin role' };
    await run(env, 'UPDATE users SET role = ? WHERE id = ?', role, target.id);
    await forceLogout(env, target.id);
    await audit(env, { adminId: actor.id, targetUserId: target.id, action: 'ROLE_CHANGED', reason, ip, metadata: { role } });
    return { ok: true };
  });
}
/** SUPER_ADMIN only: manual payment confirmation. Requires an explicit reason and is fully audited. */
export async function manualConfirmPayment(env, actor, orderId, reason, ip) {
  const a = authorize(actor, 'payments.manual_confirm'); if (!a.ok) return a;
  if (!reason || !reason.trim()) return { ok: false, reason: 'a reason is required' };
  const o = await first(env, 'SELECT * FROM orders WHERE id = ?', orderId); if (!o) return { ok: false, reason: 'order not found' };
  const r = await settleOrder(env, o.id, o.pay_amount, o.currency, null, 'manual_confirm', { confirmed_by_admin: actor.id, reason: reason.trim().slice(0, 300) });
  await audit(env, { adminId: actor.id, targetUserId: o.user_id, action: 'PAYMENT_MANUALLY_CONFIRMED', reason, ip, metadata: { order_id: o.id, result: r.code } });
  return r;
}

/**
 * Renew (extend) a user's API key WITHOUT changing its value: +N days (counted from the current expiry, or from now if it
 * already expired) or "never expires". Works on expired keys too. The user is e-mailed best-effort and the daily
 * expiry reminders start over. The owner may renew their own key.
 */
export async function renewApiKeyForUser(env, actor, targetId, { days, infinite = false }, reason, ip) {
  return guarded(env, actor, 'users.api', targetId, async (target) => {
    if (!target.api_key_hash) return { ok: false, reason: 'This user has no API key. Use "Create / replace API key" first.' };
    let expiresAt = null;
    if (!infinite) {
      const d = Math.floor(Number(days));
      if (!Number.isFinite(d) || d < 1 || d > 3650) return { ok: false, reason: 'Renew by 1 to 3650 days, or tick "never expires".' };
      const base = Math.max(now(), target.api_key_expires_at || 0);
      expiresAt = base + d * 86400;
    }
    await run(env, 'UPDATE users SET api_key_expires_at = ?, key_notice_at = NULL, key_notice_for = NULL, key_notice_kind = NULL WHERE id = ?', expiresAt, target.id);
    await audit(env, { adminId: actor.id, targetUserId: target.id, action: 'API_KEY_RENEWED', reason, ip, metadata: { infinite, days: infinite ? null : Math.floor(Number(days)), expires_at: expiresAt } });
    const until = expiresAt ? fmtIST(expiresAt) : null;
    let emailed = false;
    try {
      const { sendMail } = await import('../services/mail.js'); const { buildEmail } = await import('../services/email-templates.js');
      const site = String(cfg(env).appUrl || '').replace(/\/$/, '');
      const { html, text } = buildEmail(env, { emoji: '♻️', title: 'Your API key was renewed', name: (target.name || '').split(' ')[0], accent: '#2fbf8f', preheader: until ? `Your API key now works until ${until}.` : 'Your API key no longer expires.',
        paragraphs: [until ? 'Good news: your UnknownXfam Gateway API key has been renewed and keeps working.' : 'Good news: your UnknownXfam Gateway API key has been renewed and will no longer expire.'],
        rows: [['Valid until', until || 'Never expires ♾️'], ['Key value', 'Unchanged ✅'], ...(String(reason || '').trim() ? [['Note', String(reason).trim()]] : []), ['Time', fmtIST(now())]],
        cta: site ? { label: 'Open your Settings', url: site + '/settings' } : null, note: 'Your integration keeps working exactly as it is, no changes needed.' });
      emailed = (await sendMail(env, target.email, '♻️ Your API key was renewed', text, { htmlBody: html, fromName: 'UnknownXfam Support' })).ok;
    } catch { /* e-mail is best effort */ }
    return { ok: true, note: until ? `API key renewed until ${until}.${emailed ? ' The user was notified by e-mail.' : ''}` : `API key renewed — it never expires now.${emailed ? ' The user was notified by e-mail.' : ''}`, expiresAt };
  });
}

const OK_RESULTS = "('success','no_open_order','latest')";   // trusted credit alerts: matched to an order, or money received with no order
/** SUCCESSFUL payments of one merchant (newest first) for the admin profile / users tab: trusted payment e-mails plus webhook / manually confirmed PAID payments, with UTR and transaction id. */
export async function userPaymentRecords(env, userId, limit = 50) {
  const emails = await all(env, `SELECT payment_time AS at, amount, received_from, utr, transaction_id, result, order_id FROM gmail_payment_messages
    WHERE user_id = ? AND amount IS NOT NULL AND result IN ${OK_RESULTS} ORDER BY payment_time DESC LIMIT ?`, userId, limit);
  const direct = await all(env, `SELECT verified_at AS at, amount, received_from, utr, transaction_id, status AS result, order_id FROM payments
    WHERE user_id = ? AND status = 'PAID' AND verification_source <> 'GMAIL_FAMAPP' ORDER BY verified_at DESC LIMIT ?`, userId, limit);
  return [...emails, ...direct].sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, limit);
}
export async function userPaymentSummary(env, userId) {
  const r = await first(env, `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::bigint AS total FROM (
    SELECT amount FROM gmail_payment_messages WHERE user_id = ? AND amount IS NOT NULL AND result IN ${OK_RESULTS}
    UNION ALL SELECT amount FROM payments WHERE user_id = ? AND status = 'PAID' AND verification_source <> 'GMAIL_FAMAPP') s`, userId, userId);
  return { count: r?.n || 0, total: r?.total || 0 };
}
