// A user's Gmail connection: who owns which address, saving/replacing/removing credentials, token health, and the mini-inbox loader.
//
// Rules enforced here (and by ux_gmail_email, the unique index on LOWER(email)):
//  * one Gmail address belongs to at most ONE gateway user at a time;
//  * ownership is only released by a successful disconnect (or account deletion) — never by another user's attempt;
//  * credentials are only saved after Google itself told us which address the token belongs to (Gmail profile of THIS token);
//  * a refresh token is only ever kept for the SAME verified address — never carried across to a different Gmail;
//  * Google ties all of an app's tokens for one Google account to one grant, so a token is only revoked when nothing else uses that account.
import { cfg } from '../lib/config.js';
import { first, run, now, withTx, isUnique } from '../lib/db.js';
import { seal, open } from '../lib/crypto.js';
import { accessTokenFromRefresh, forgetCachedToken, gmailGet, googleReason, revokeToken, scopeIsReadonly } from './google.js';

const norm = (e) => String(e || '').trim().toLowerCase();
const cacheKey = (uid) => 'user:' + uid;

export const gmailAccount = (env, uid) => first(env, 'SELECT * FROM gmail_accounts WHERE user_id = ?', uid);

/** Is this Google account still used by another stored credential (another gateway user or the admin sender Gmail)? */
async function inUseElsewhere(env, email, exceptUserId, ignoreSender = false) {
  const e = norm(email); if (!e) return true;                       // unknown address: assume shared, never revoke blindly
  const other = await first(env, 'SELECT 1 AS x FROM gmail_accounts WHERE LOWER(email) = ? AND user_id <> ?', e, exceptUserId);
  if (other) return true;
  if (ignoreSender) return false;
  const s = await first(env, "SELECT v FROM app_settings WHERE k = 'sender_email'");
  const t = await first(env, "SELECT v FROM app_settings WHERE k = 'sender_refresh_enc'");
  return !!(s && norm(s.v) === e && t && t.v);
}
/** Revokes `refreshToken` at Google ONLY when no other connection depends on the same Google account. Returns 'revoked' | 'kept' | 'failed'. */
export async function releaseGrant(env, { email, refreshToken, exceptUserId = 0, ignoreSender = false }) {
  if (!refreshToken) return 'kept';
  if (await inUseElsewhere(env, email, exceptUserId, ignoreSender)) return 'kept';
  return (await revokeToken(refreshToken)) ? 'revoked' : 'failed';
}

/** What Google says this token is for. Returns the lower-cased address, or null when it cannot be proven. */
export async function verifiedAddress(accessToken) {
  const r = await gmailGet(accessToken, '/profile');
  const email = norm(r.body && r.body.emailAddress);
  return r.status === 200 && /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

/**
 * Saves a verified connection inside ONE transaction (serialised per address with an advisory lock).
 *  - another user owns the address            -> { conflict: true } and NOTHING is written;
 *  - same user, same address, no new refresh token -> the existing token is kept (only if it is still the same verified address);
 *  - same user, different address (switch)    -> the row is replaced; the old account's token is returned so it can be released;
 *  - no refresh token and nothing safe to keep -> { needRefreshToken: true }.
 */
export async function saveConnection(env, { userId, email, refreshToken, scope }) {
  const e = norm(email); const c = cfg(env);
  const sealed = refreshToken ? await seal(c.encryptionKey, refreshToken) : null;
  const out = await withTx(env, async (tx) => {
    await tx.run('SELECT pg_advisory_xact_lock(hashtext(?))', 'gmail:' + e);
    const owner = await tx.first('SELECT user_id FROM gmail_accounts WHERE LOWER(email) = ?', e);
    if (owner && owner.user_id !== userId) return { conflict: true };
    const mine = await tx.first('SELECT * FROM gmail_accounts WHERE user_id = ? FOR UPDATE', userId);
    const sameAddress = !!mine && norm(mine.email) === e;
    let enc = sealed;
    if (!enc) {
      if (sameAddress && mine.refresh_token_enc && await open(c.encryptionKey, mine.refresh_token_enc)) enc = mine.refresh_token_enc;   // same verified Gmail only
      else return { needRefreshToken: true };
    }
    await tx.run(`INSERT INTO gmail_accounts(user_id,email,refresh_token_enc,scope,connected_at,last_checked,status,last_error,last_error_at) VALUES(?,?,?,?,?,NULL,'active',NULL,NULL)
      ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, refresh_token_enc = excluded.refresh_token_enc, scope = excluded.scope, connected_at = excluded.connected_at,
      last_checked = NULL, status = 'active', last_error = NULL, last_error_at = NULL`, userId, e, enc, scope || '', now());
    return { ok: true, previous: mine && !sameAddress ? { email: mine.email, refresh_token_enc: mine.refresh_token_enc } : null, kept: !sealed };
  }).catch((err) => { if (isUnique(err)) return { conflict: true }; throw err; });
  forgetCachedToken(cacheKey(userId));      // never serve the previous account's access token
  return out;
}

/**
 * Finishes the OAuth callback. `exchange` is the Google token response. Returns { ok, email } or { error: <code> }.
 * Codes: not_readonly | no_identity | conflict | need_refresh_token | unavailable
 */
export async function completeConnect(env, { userId, exchange }) {
  const granted = String(exchange.scope || '');
  const email = await verifiedAddress(exchange.access_token);
  if (!scopeIsReadonly(granted)) {                                    // never store broader access; drop the extra grant unless that Google account is already in use here
    if (email) await releaseGrant(env, { email, refreshToken: exchange.refresh_token, exceptUserId: 0 });
    return { error: 'not_readonly' };
  }
  if (!email) return { error: 'no_identity' };
  const saved = await saveConnection(env, { userId, email, refreshToken: exchange.refresh_token || null, scope: granted });
  if (saved.conflict) return { error: 'conflict', email };            // do NOT revoke: that would end the legitimate owner's access
  if (saved.needRefreshToken) return { error: 'need_refresh_token' };
  if (saved.previous) {                                               // switched accounts: release the old Gmail (different address, so the new token is untouched)
    const old = await open(cfg(env).encryptionKey, saved.previous.refresh_token_enc);
    if (old) await releaseGrant(env, { email: saved.previous.email, refreshToken: old, exceptUserId: userId });
  }
  return { ok: true, email };
}

/** Disconnects the user's own Gmail. The row (and the address claim) is only removed after the Google side was handled. */
export async function disconnectGmail(env, userId) {
  const a = await gmailAccount(env, userId); if (!a) return { ok: true, had: false };
  const rt = await open(cfg(env).encryptionKey, a.refresh_token_enc);
  const rel = await releaseGrant(env, { email: a.email, refreshToken: rt, exceptUserId: userId });   // awaited: a quick reconnect can never race a late revoke
  const del = await run(env, 'DELETE FROM gmail_accounts WHERE user_id = ? AND LOWER(email) = ?', userId, norm(a.email));   // only this user's own row
  forgetCachedToken(cacheKey(userId));
  return { ok: true, had: true, email: a.email, google: rel, removed: del.meta.changes > 0 };
}

export async function markReconnect(env, userId, code) {
  await run(env, "UPDATE gmail_accounts SET status = 'reconnect_required', last_error = ?, last_error_at = ? WHERE user_id = ?", String(code).slice(0, 40), now(), userId);
  forgetCachedToken(cacheKey(userId));
  import('../services/monitor.js').then((m) => m.notifyReconnect(env, userId, String(code).slice(0, 40))).catch(() => {});   // tell the owner (Telegram + e-mail); fire and forget
}

/**
 * Access token for a user's Gmail, with the reason when there is none.
 *  { token, account } | { state: 'none' | 'reconnect' | 'unavailable' | 'config', account? }
 */
export async function userToken(env, uid) {
  const account = await gmailAccount(env, uid); if (!account) return { state: 'none' };
  if (account.status !== 'active') return { state: 'reconnect', account };
  const rt = await open(cfg(env).encryptionKey, account.refresh_token_enc);
  if (!rt) { await markReconnect(env, uid, 'token_unreadable'); return { state: 'reconnect', account }; }   // stored with a different ENCRYPTION_KEY
  const r = await accessTokenFromRefresh(env, cacheKey(uid), rt);
  if (r.revoked) { await markReconnect(env, uid, 'invalid_grant'); return { state: 'reconnect', account }; }
  if (r.token) return { token: r.token, account };
  return { state: r.error === 'config' ? 'config' : 'unavailable', account };
}

/**
 * The latest `max` inbox messages for the mini inbox.
 * state: 'ok' | 'empty' | 'none' | 'reconnect' | 'unavailable' | 'config'  (+ email, messages, code for server logs)
 * Only a definitive "access ended" answer asks the user to reconnect; a timeout / 5xx / quota problem says "try again".
 */
export async function loadMiniInbox(env, uid, max = 6) {
  let t = await userToken(env, uid);
  if (!t.token) return { state: t.state, email: t.account?.email || '', messages: [] };
  const email = t.account.email;
  const call = async (path, q) => {
    let r = await gmailGet(t.token, path, q);
    if (r.status === 401) {                                            // cached access token went stale early: drop it, refresh once, retry
      forgetCachedToken(cacheKey(uid)); t = await userToken(env, uid); if (!t.token) return { status: -1, body: {}, why: t.state };
      r = await gmailGet(t.token, path, q);
    }
    return r;
  };
  const classify = async (r) => {
    if (r.why) return { state: r.why, email, messages: [] };
    const reason = googleReason(r.body);
    if (r.status === 401 || (r.status === 403 && /insufficient|scope/i.test(reason))) { await markReconnect(env, uid, 'gmail_' + (reason || r.status)); return { state: 'reconnect', email, messages: [], code: reason }; }
    if (r.status === 403 && /accessNotConfigured|SERVICE_DISABLED|PERMISSION_DENIED/i.test(reason)) return { state: 'config', email, messages: [], code: reason };
    return { state: 'unavailable', email, messages: [], code: reason || String(r.status) };   // 0 (network), 429, 5xx, rate limits, ...
  };
  const list = await call('/messages', { maxResults: max, labelIds: 'INBOX' });
  if (list.status !== 200) return classify(list);
  const ids = (list.body.messages || []).slice(0, max);
  if (!ids.length) return { state: 'empty', email, messages: [] };
  const got = await Promise.all(ids.map((m) => call('/messages/' + encodeURIComponent(m.id), { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })));
  const ok = got.filter((r) => r.status === 200).map((r) => r.body);
  if (!ok.length) return classify(got[0]);
  return { state: 'ok', email, messages: ok.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0))};
}
