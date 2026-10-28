import { cfg, SESSION_TTL } from '../lib/config.js';
import { first, all, run, now, changes, stmt, batch } from '../lib/db.js';
import { randomToken, hmacHex, safeEqual } from '../lib/crypto.js';
import { parseCookies, setCookie, clientIp, userAgent } from '../lib/http.js';
import { audit } from '../admin/audit.js';

export const sessionCookieName = (env) => (cfg(env).isProd ? '__Host-gw_session' : 'gw_session');
export const csrfCookieName = (env) => (cfg(env).isProd ? '__Host-gw_csrf' : 'gw_csrf');

/**
 * Account state machine: active | frozen | suspended | banned.
 * A suspension whose end time has passed is lifted here (lazily, on every check) and by the cron sweep.
 */
export async function effectiveStatus(env, u) {
  if (u.acct_status === 'suspended' && u.suspended_until && u.suspended_until <= now()) {
    const r = await run(env, "UPDATE users SET acct_status='active', suspended_until=NULL, status_reason=NULL, status_changed_at=? WHERE id=? AND acct_status='suspended' AND suspended_until <= ?", now(), u.id, now());
    if (changes(r)) await audit(env, { adminId: null, targetUserId: u.id, action: 'USER_SUSPENSION_EXPIRED', reason: 'suspension period ended' });
    u.acct_status = 'active'; u.suspended_until = null;
  }
  return u.acct_status;
}
export async function sweepSuspensions(env) {
  const rows = await all(env, "SELECT * FROM users WHERE acct_status='suspended' AND suspended_until IS NOT NULL AND suspended_until <= ?", now());
  for (const u of rows) await effectiveStatus(env, u);
  return rows.length;
}

export async function createSession(env, request, user) {
  const c = cfg(env); const token = randomToken(32); const id = await hmacHex(c.sessionSecret, 'sess:' + token); const t = now();
  await run(env, 'INSERT INTO sessions(id,user_id,created_at,expires_at,last_seen,ip,ua,session_version) VALUES(?,?,?,?,?,?,?,?)',
    id, user.id, t, t + SESSION_TTL, t, clientIp(request, env), userAgent(request), user.session_version);
  await run(env, 'UPDATE users SET last_login_at = ? WHERE id = ?', t, user.id);
  return setCookie(sessionCookieName(env), token, { maxAge: SESSION_TTL, secure: c.isProd });
}
export const clearSessionCookie = (env) => setCookie(sessionCookieName(env), '', { maxAge: 0, secure: cfg(env).isProd });

/** Returns the signed-in user, or null. Old sessions die on: expiry, force-logout (version bump), ban, active suspension. */
export async function loadSession(env, request) {
  const token = parseCookies(request)[sessionCookieName(env)];
  if (!token || token.length > 100) return null;
  const c = cfg(env); const id = await hmacHex(c.sessionSecret, 'sess:' + token);
  const row = await first(env, 'SELECT u.*, s.expires_at AS s_exp, s.session_version AS s_ver, s.last_seen AS s_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?', id);
  if (!row) return null;
  const t = now();
  if (row.s_exp <= t || row.s_ver !== row.session_version) { await run(env, 'DELETE FROM sessions WHERE id = ?', id); return null; }
  const st = await effectiveStatus(env, row);
  if (st === 'banned' || st === 'suspended') { await run(env, 'DELETE FROM sessions WHERE id = ?', id); return null; }
  if (t - row.s_seen > 300) await run(env, 'UPDATE sessions SET last_seen = ? WHERE id = ?', t, id);
  return { user: row, sessionId: id };
}
export async function destroySession(env, request) {
  const token = parseCookies(request)[sessionCookieName(env)]; if (!token) return;
  await run(env, 'DELETE FROM sessions WHERE id = ?', await hmacHex(cfg(env).sessionSecret, 'sess:' + token));
}
/** "Force logout": bump the version (kills any cached/parallel session) and delete all rows. */
export async function forceLogout(env, userId) {
  await batch(env, [
    stmt(env, 'UPDATE users SET session_version = session_version + 1 WHERE id = ?', userId),
    stmt(env, 'DELETE FROM sessions WHERE user_id = ?', userId),
  ]);
}
export async function sweepSessions(env) { await run(env, 'DELETE FROM sessions WHERE expires_at < ?', now()); }

// ---- CSRF: signed double-submit token (cookie + hidden field) plus an Origin check ----
export async function csrfIssue(env, request) {
  const c = cfg(env); const name = csrfCookieName(env); const existing = parseCookies(request)[name];
  if (existing && await csrfSigOk(c, existing)) return { token: existing, cookie: null };
  const raw = randomToken(24); const sig = (await hmacHex(c.sessionSecret, 'csrf:' + raw)).slice(0, 32); const token = `${raw}.${sig}`;
  return { token, cookie: setCookie(name, token, { maxAge: 7 * 86400, secure: c.isProd }) };
}
async function csrfSigOk(c, token) {
  const [raw, sig] = String(token).split('.'); if (!raw || !sig) return false;
  return safeEqual((await hmacHex(c.sessionSecret, 'csrf:' + raw)).slice(0, 32), sig);
}
export async function csrfValid(env, request, formToken) {
  const cookie = parseCookies(request)[csrfCookieName(env)];
  if (!cookie || !formToken || !(await csrfSigOk(cfg(env), cookie))) return false;
  return safeEqual(cookie, formToken);
}
/** State-changing browser requests must come from our own origin. */
export function originOk(env, request) {
  const origin = request.headers.get('Origin'); const site = request.headers.get('Sec-Fetch-Site');
  if (origin) return origin === cfg(env).origin;
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return true;
}
