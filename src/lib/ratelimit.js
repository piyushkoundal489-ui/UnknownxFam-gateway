// Fixed-window rate limiting in PostgreSQL. One atomic upsert per check; cheap enough to run BEFORE any password hashing.
// Shared by every instance because the counters live in the database. Add edge/CDN rate limiting for volumetric abuse.
import { run, first, now } from './db.js';
import { sha256Hex } from './crypto.js';

/** @returns {Promise<{ok:boolean, retryAfter:number, count:number}>} */
export async function hit(env, rule, subject, { max, windowSec }) {
  const t = now(); const win = Math.floor(t / windowSec);
  const key = `${rule}:${(await sha256Hex(String(subject))).slice(0, 24)}:${win}`;
  const exp = (win + 1) * windowSec + 60;
  const r = await first(env, 'INSERT INTO rate_limits(k,count,expires_at) VALUES(?,1,?) ON CONFLICT(k) DO UPDATE SET count = rate_limits.count + 1 RETURNING count', key, exp);
  const count = r ? r.count : 1;
  return { ok: count <= max, retryAfter: (win + 1) * windowSec - t, count };
}
/** Reads the current count WITHOUT counting this request (used to reject known-abusive callers before doing any work). */
export async function peek(env, rule, subject, { max, windowSec }) {
  const t = now(); const win = Math.floor(t / windowSec);
  const key = `${rule}:${(await sha256Hex(String(subject))).slice(0, 24)}:${win}`;
  const r = await first(env, 'SELECT count FROM rate_limits WHERE k = ?', key);
  return { blocked: !!r && r.count >= max, retryAfter: (win + 1) * windowSec - t };
}
// ---- per-ACCOUNT password lockout: LOGIN_LOCK.maxFails wrong passwords in a row -> that account cannot log in with a password for LOGIN_LOCK.lockSec.
// Counted per e-mail (existing or not, so nothing reveals which accounts exist); a correct password resets the counter; the counter also forgets
// itself after lockSec without a new failure. Rows live in rate_limits (swept automatically, never part of backups).
export const LOGIN_LOCK = { maxFails: 5, lockSec: 6 * 3600 };
const subjKey = async (kind, subject) => `${kind}:${(await sha256Hex(String(subject))).slice(0, 24)}`;
/** Seconds of lockout left for this account (0 = not locked). */
export async function loginLockRemaining(env, subject) {
  const r = await first(env, 'SELECT expires_at FROM rate_limits WHERE k = ?', await subjKey('acct_lock', subject));
  const left = r ? r.expires_at - now() : 0; return left > 0 ? left : 0;
}
/** Counts one wrong password. @returns {Promise<{locked:boolean, left:number}>} left = wrong attempts still allowed before the lock. */
export async function recordLoginFailure(env, subject) {
  const t = now(), { maxFails, lockSec } = LOGIN_LOCK, fk = await subjKey('acct_fail', subject);
  const r = await first(env, 'INSERT INTO rate_limits(k,count,expires_at) VALUES(?,1,?) ON CONFLICT(k) DO UPDATE SET count = CASE WHEN rate_limits.expires_at < ? THEN 1 ELSE rate_limits.count + 1 END, expires_at = ? RETURNING count',
    fk, t + lockSec, t, t + lockSec);
  const count = r ? r.count : 1;
  if (count < maxFails) return { locked: false, left: maxFails - count };
  await run(env, 'INSERT INTO rate_limits(k,count,expires_at) VALUES(?,1,?) ON CONFLICT(k) DO UPDATE SET count = 1, expires_at = ?', await subjKey('acct_lock', subject), t + lockSec, t + lockSec);
  await run(env, 'DELETE FROM rate_limits WHERE k = ?', fk);
  return { locked: true, left: 0 };
}
export async function clearLoginFailures(env, subject) { await run(env, 'DELETE FROM rate_limits WHERE k = ?', await subjKey('acct_fail', subject)); }
/** Lifts the lock and the counter (the owner proved who they are another way: e-mail login code or a password reset). */
export async function clearLoginLock(env, subject) { await run(env, 'DELETE FROM rate_limits WHERE k IN (?, ?)', await subjKey('acct_fail', subject), await subjKey('acct_lock', subject)); }
export async function sweepRateLimits(env) { await run(env, 'DELETE FROM rate_limits WHERE expires_at < ?', now()); }

// Named rules used across the app (max requests per window).
export const RULES = {
  login_ip:        { max: 20,  windowSec: 600 },
  login_email:     { max: 8,   windowSec: 600 },
  admin_login_ip:  { max: 6,   windowSec: 900 },
  register_ip:     { max: 10,  windowSec: 3600 },
  otp_ip:          { max: 20,  windowSec: 3600 },
  otp_verify_ip:   { max: 30,  windowSec: 600 },
  reset_ip:        { max: 10,  windowSec: 3600 },
  oauth_ip:        { max: 30,  windowSec: 600 },
  api_ip:          { max: 240, windowSec: 60 },
  api_key_create:  { max: 60,  windowSec: 60 },
  api_key_verify:  { max: 300, windowSec: 60 },
  api_bad_auth_ip: { max: 20,  windowSec: 300 },
  webhook_ip:      { max: 300, windowSec: 60 },
  webhook_bad_ip:  { max: 20,  windowSec: 600 },
  notify_user:     { max: 30,  windowSec: 60 },
  pay_poll_ip:     { max: 120, windowSec: 60 },
  admin_action:    { max: 60,  windowSec: 60 },
};
