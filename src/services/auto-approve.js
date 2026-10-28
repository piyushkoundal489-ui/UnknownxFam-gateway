// Auto Approve: when ON every pending account request is approved without manual review, both the ones already waiting
// (approved the moment the switch is turned on) and every new one. When OFF it is manual again, as before.
// With "Email code at sign-up" on, an account is approved as soon as its email is verified (the same rule as manual approval).
import { first, all, run, now, getSetting, setSetting } from '../lib/db.js';
import { getMailSettings } from './mail.js';
import { audit, notifyUser } from '../admin/audit.js';
import { can } from '../admin/rbac.js';

export async function autoApproveState(env) {
  return { on: (await getSetting(env, 'auto_approve', '0')) === '1', by: Number(await getSetting(env, 'auto_approve_by', '0')) || null };
}

/** Approves one pending USER account (same effects as a manual approval). Returns true when it was approved. */
async function approveRow(env, userId, byId, { notify = true } = {}) {
  const u = await first(env, 'SELECT id, role, approval, email_verified, webhook_secret_hash FROM users WHERE id = ?', userId);
  if (!u || u.approval !== 'pending' || u.role !== 'USER') return false;
  if ((await getMailSettings(env)).otp_signup === '1' && !u.email_verified) return false;   // approved later, right after the email is verified
  if (!u.webhook_secret_hash) { const { issueWebhookSecret } = await import('../auth/accounts.js'); await issueWebhookSecret(env, u.id); }
  const r = await run(env, "UPDATE users SET approval = 'approved', decided_at = ? WHERE id = ? AND approval = 'pending'", now(), u.id);
  if (!r.meta.changes) return false;
  await audit(env, { adminId: byId, targetUserId: u.id, action: 'USER_APPROVED', reason: 'Auto Approve is on', metadata: { auto: true }, notify });
  return true;
}

/** Called after a sign-up and after an email gets verified: approves the account at once if Auto Approve is on. */
export async function maybeAutoApprove(env, userId) {
  const s = await autoApproveState(env);
  return s.on ? approveRow(env, userId, s.by) : false;
}

/** Turns Auto Approve on / off. Turning it ON also approves everything already waiting. */
export async function setAutoApprove(env, actor, on, ip) {
  if (!can(actor.role, 'users.approve')) return { ok: false, reason: 'You cannot change approval settings.' };
  await setSetting(env, 'auto_approve', on ? '1' : '0');
  if (on) await setSetting(env, 'auto_approve_by', String(actor.id));
  await audit(env, { adminId: actor.id, targetUserId: null, action: on ? 'AUTO_APPROVE_ON' : 'AUTO_APPROVE_OFF', ip });
  let approved = [];
  if (on) {
    const waiting = await all(env, "SELECT id FROM users WHERE approval = 'pending' AND role = 'USER' ORDER BY id");
    for (const w of waiting) if (await approveRow(env, w.id, actor.id, { notify: false })) approved.push(w.id);
    sendNoticesSlowly(env, approved, actor.id);       // one email at a time, so Gmail's sending limit is never hit
  }
  return { ok: true, approved: approved.length };
}

function sendNoticesSlowly(env, ids, adminId) {
  (async () => {
    for (const id of ids) {
      try { await notifyUser(env, { targetUserId: id, action: 'USER_APPROVED', reason: 'Auto Approve is on', metadata: { auto: true } }); } catch { /* best effort */ }
      await new Promise((r) => setTimeout(r, 700));
    }
  })().catch(() => {});
}
