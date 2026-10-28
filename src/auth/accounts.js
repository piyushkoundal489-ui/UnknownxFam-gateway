import { cfg } from '../lib/config.js';
import { first, run, now, isUnique } from '../lib/db.js';
import { hashPassword, verifyPassword, DUMMY_HASH, randomHex, randomToken, sha256Hex, seal, open, safeEqual } from '../lib/crypto.js';
import { emailCanonical, isGmailAddress } from './email-check.js';

export const getUser = (env, id) => first(env, 'SELECT * FROM users WHERE id = ?', id);
export async function findUserByEmail(env, email) {
  email = String(email).trim().toLowerCase();
  return first(env, 'SELECT * FROM users WHERE email_canon = ? OR LOWER(email) = LOWER(?) LIMIT 1', emailCanonical(email), email);
}
/** Gmail-only sign-in: a Gmail address, or the owner (ADMIN_EMAIL / SUPER_ADMIN) so the owner can never be locked out. */
export const gmailOnlyOk = (env, user) => !!user && (isGmailAddress(user.email) || user.role === 'SUPER_ADMIN' || isReservedEmail(env, user.email));
export const isReservedEmail = (env, email) => { const a = cfg(env).adminEmail; return !!a && emailCanonical(email) === emailCanonical(a); };

/** ADMIN_EMAIL is the one SUPER_ADMIN. Its password is the ADMIN_PASSWORD secret (never stored). */
export async function ensureSuperAdmin(env) {
  const c = cfg(env); if (!c.adminEmail) return null;
  let u = await first(env, 'SELECT * FROM users WHERE LOWER(email) = LOWER(?)', c.adminEmail);
  if (!u) {
    await run(env, "INSERT INTO users(name,email,email_canon,pass_hash,approval,email_verified,role,created_at,decided_at) VALUES(?,?,?,?,'approved',1,'SUPER_ADMIN',?,?) ON CONFLICT DO NOTHING",
      'Owner', c.adminEmail, emailCanonical(c.adminEmail), await hashPassword(randomToken(24), 1000), now(), now());
    u = await first(env, 'SELECT * FROM users WHERE LOWER(email) = LOWER(?)', c.adminEmail);
  } else if (u.role !== 'SUPER_ADMIN' || u.approval !== 'approved') {
    await run(env, "UPDATE users SET role='SUPER_ADMIN', approval='approved', email_verified=1 WHERE id = ?", u.id);
    u = await getUser(env, u.id);
  }
  if (u.name === 'Admin') { await run(env, "UPDATE users SET name='Owner' WHERE id = ? AND name = 'Admin'", u.id); u = await getUser(env, u.id); }   // old default name only; a name the owner chose is never touched
  await run(env, "UPDATE users SET role='ADMIN' WHERE role='SUPER_ADMIN' AND id <> ?", u.id);   // only one SUPER_ADMIN, ever
  if (!u.webhook_secret_hash) await issueWebhookSecret(env, u.id);
  return getUser(env, u.id);
}

export async function createUser(env, { name, email, password }) {
  const c = cfg(env); email = email.trim().toLowerCase();
  try {
    await run(env, "INSERT INTO users(name,email,email_canon,pass_hash,approval,created_at) VALUES(?,?,?,?,'pending',?)",
      name.trim().slice(0, 80), email, emailCanonical(email), await hashPassword(password, c.pbkdf2), now());
  } catch (e) { if (isUnique(e)) return null; throw e; }
  return findUserByEmail(env, email);
}
export async function setPassword(env, userId, password) {
  await run(env, 'UPDATE users SET pass_hash = ? WHERE id = ?', await hashPassword(password, cfg(env).pbkdf2), userId);
}

/** Verifies credentials. Always does comparable work whether or not the account exists. */
export async function authenticate(env, email, password) {
  const c = cfg(env); const u = await findUserByEmail(env, email);
  if (!u) { await verifyPassword(password, DUMMY_HASH); return { ok: false, user: null }; }
  if (u.role === 'SUPER_ADMIN' && c.adminEmail && u.email.toLowerCase() === c.adminEmail) {
    if (!c.adminPassword) return { ok: false, user: u, disabled: true };
    return { ok: safeEqual(await sha256Hex(c.adminPassword), await sha256Hex(password)), user: u };
  }
  return { ok: await verifyPassword(password, u.pass_hash), user: u };
}

// ---- API key: every randomly generated personal or admin-issued key is a 7-digit numeric value. Owners and
// admins may explicitly choose a custom value from Settings/admin; admins can set custom durations. Only a hash
// is used for lookup (matches the merchantByKey() check); the owner can view a sealed copy of their own key;
// admins cannot — not even a masked prefix, since revealing any part of a short key shrinks the guessing space. ----
import { randomInt } from '../lib/crypto.js';
function generate7DigitKey() { return String(randomInt(10000000)).padStart(7, '0'); }
export const CUSTOM_KEY_RE = /^[A-Za-z0-9_-]{4,40}$/;

export async function issueApiKey(env, userId) {
  const { key } = await setApiKey(env, userId, {});
  return key;
}
/**
 * Sets (creates or replaces) a user's API key in one place, used by admin actions and owner Settings:
 * a key is never issued automatically. Random-or-custom value, infinite-or-timed expiry.
 * @param {object} opts
 * @param {string} [opts.customKey] - exact key value to use instead of generating a random 7-digit key
 * @param {number} [opts.expiresInSeconds] - null/undefined/omitted = never expires ("infinite")
 * @returns {{key:string, expiresAt:number|null}}
 */
export async function setApiKey(env, userId, { customKey, expiresInSeconds } = {}) {
  const c = cfg(env); const t = now();
  const expiresAt = expiresInSeconds != null && expiresInSeconds > 0 ? t + Math.floor(expiresInSeconds) : null;
  if (customKey) {
    const key = String(customKey).trim();
    if (!CUSTOM_KEY_RE.test(key)) throw new KeyError('A custom key must be 4-40 letters, numbers, "_" or "-".');
    const keyHash = await sha256Hex(key);
    if (await first(env, 'SELECT id FROM shared_api_keys WHERE key_hash = ?', keyHash))
      throw new KeyError('That key is reserved for a shared API key. Choose a different value.');
    try {
      await run(env, 'UPDATE users SET api_key_hash=?, api_key_enc=?, api_key_prefix=NULL, api_key_expires_at=?, api_key_issued_at=?, api_key_custom=? WHERE id=?',
        keyHash, await seal(c.encryptionKey, key), expiresAt, t, 1, userId);
    } catch (e) { if (isUnique(e)) throw new KeyError('That key is already in use by another account. Choose a different one.'); throw e; }
    return { key, expiresAt };
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = generate7DigitKey();
    const keyHash = await sha256Hex(key);
    if (await first(env, 'SELECT id FROM shared_api_keys WHERE key_hash = ?', keyHash)) continue;
    try {
      await run(env, 'UPDATE users SET api_key_hash=?, api_key_enc=?, api_key_prefix=NULL, api_key_expires_at=?, api_key_issued_at=?, api_key_custom=0 WHERE id=?',
        keyHash, await seal(c.encryptionKey, key), expiresAt, t, userId);
      return { key, expiresAt };
    } catch (e) { if (!isUnique(e)) throw e; }   // extremely rare 7-digit collision — draw again
  }
  throw new Error('Could not allocate a unique 7-digit API key');
}
export class KeyError extends Error {}
export async function revokeApiKey(env, userId) { await run(env, 'UPDATE users SET api_key_hash=NULL, api_key_enc=NULL, api_key_prefix=NULL, api_key_expires_at=NULL, api_key_issued_at=NULL, api_key_custom=0 WHERE id=?', userId); }
export async function issueWebhookSecret(env, userId) {
  const c = cfg(env); const s = 'whsec_' + randomHex(16);
  await run(env, 'UPDATE users SET webhook_secret_hash=?, webhook_secret_enc=? WHERE id=?', await sha256Hex(s), await seal(c.encryptionKey, s), userId);
  return s;
}
export const revealSecret = (env, sealed) => (sealed ? open(cfg(env).encryptionKey, sealed) : null);
