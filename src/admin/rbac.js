// Centralised authorization. EVERY admin route calls authorize()/requirePerm() on the server —
// hiding a button is never the only control. Roles: USER < SUPPORT < ADMIN < SUPER_ADMIN.
export const ROLES = ['USER', 'SUPPORT', 'ADMIN', 'SUPER_ADMIN'];
export const RANK = { USER: 0, SUPPORT: 1, ADMIN: 2, SUPER_ADMIN: 3 };
const STAFF = ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'], ADMINS = ['ADMIN', 'SUPER_ADMIN'], SUPER = ['SUPER_ADMIN'];

export const PERMS = {
  'admin.access': STAFF,
  // SUPPORT: look, don't touch
  'users.view': STAFF, 'orders.view': STAFF, 'status.view': STAFF, 'support.resend_verification': STAFF,
  // ADMIN: user + API management, audit
  'users.approve': ADMINS, 'users.status': ADMINS, 'users.force_logout': ADMINS, 'users.api': ADMINS,
  'users.email_verify': ADMINS, 'users.password_reset': ADMINS, 'users.delete': ADMINS,
  'apiactivity.view': ADMINS, 'security.view': ADMINS, 'audit.view': ADMINS,
  'gmail.view': ADMINS, 'announcements.send': ADMINS,
  // SUPER_ADMIN only: money overrides, privileges, platform settings
  'payments.manual_confirm': SUPER, 'roles.manage': SUPER, 'settings.manage': SUPER, 'shared_api.manage': SUPER,
};
// Actions that may never be pointed at yourself.
const NOT_SELF = new Set(['users.status', 'users.force_logout', 'users.api', 'users.approve', 'roles.manage', 'users.email_verify', 'users.delete']);
// The owner (SUPER_ADMIN) may manage the API key of their OWN account (create / reissue / revoke); every other action stays blocked on yourself.
const OWNER_SELF_OK = new Set(['users.api']);

export const can = (role, perm) => (PERMS[perm] || []).includes(role);

/** @returns {{ok:true}|{ok:false,reason:string}} */
export function authorize(actor, perm, target = null) {
  if (!actor || !ROLES.includes(actor.role)) return { ok: false, reason: 'not signed in' };
  if (actor.acct_status && actor.acct_status !== 'active' && actor.acct_status !== 'frozen') return { ok: false, reason: 'account restricted' };
  if (!can(actor.role, perm)) return { ok: false, reason: 'your role cannot do this' };
  if (target) {
    if (actor.id === target.id && NOT_SELF.has(perm) && !(actor.role === 'SUPER_ADMIN' && OWNER_SELF_OK.has(perm))) return { ok: false, reason: 'you cannot do this to your own account' };
    if (actor.id !== target.id && RANK[target.role] >= RANK[actor.role]) return { ok: false, reason: 'you can only manage accounts with a lower role than yours' };
  }
  return { ok: true };
}
