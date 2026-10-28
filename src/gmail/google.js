// Google OAuth 2.0 (authorization code + PKCE + state) and token handling. The app never asks for, sees or stores
// a Google password, OTP, 2-step code, SMS code or number-match: Google's own consent page does all of that.
import { cfg } from '../lib/config.js';
import { gmailOk, gmailBad } from '../lib/health-state.js';
import { first, run, now } from '../lib/db.js';
import { randomToken, sha256Hex, b64u, seal, open } from '../lib/crypto.js';

export const G = { AUTH: 'https://accounts.google.com/o/oauth2/v2/auth', TOKEN: 'https://oauth2.googleapis.com/token', REVOKE: 'https://oauth2.googleapis.com/revoke', API: 'https://gmail.googleapis.com/gmail/v1/users/me' };
const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const TIMEOUT_MS = 12000;   // a hung Google call must surface as "unavailable", not hang the page

/** Only read-only Gmail (+ identity) scopes are ever requested for users, whatever the env says. */
export function userScopes() { return 'https://www.googleapis.com/auth/gmail.readonly'; }
export function scopeIsReadonly(granted) {
  if (/gmail\.(send|modify|compose|insert|labels|settings|metadata)|mail\.google\.com/.test(granted)) return false;
  return granted.includes('gmail.readonly');
}
/** Sender account: "send" is required; read-only inbox only if the admin asked; never modify/delete/full mailbox. */
export function senderScopeOk(granted, allowRead = true) {
  if (!granted.includes('gmail.send')) return false;
  if (/gmail\.(modify|compose|insert|labels|settings|metadata)|mail\.google\.com/.test(granted)) return false;
  return allowRead || !granted.includes('gmail.readonly');
}

export async function beginOAuth(env, { kind, userId, scope, redirectUri, extra = '' }) {
  const c = cfg(env); const state = randomToken(24); const verifier = randomToken(48);
  const challenge = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  await run(env, 'DELETE FROM oauth_states WHERE expires_at < ?', now());
  await run(env, 'INSERT INTO oauth_states(state_hash,user_id,kind,verifier_enc,extra,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
    await sha256Hex(state), userId, kind, await seal(c.encryptionKey, verifier), extra, now(), now() + 600);
  return `${G.AUTH}?${form({ client_id: c.googleClientId, redirect_uri: redirectUri, response_type: 'code', scope, state, code_challenge: challenge,
    code_challenge_method: 'S256', access_type: 'offline', prompt: kind === 'gmail_sender' ? 'select_account consent' : 'consent', include_granted_scopes: 'false' })}`;
}
/** Consumes the state (single use) and returns the PKCE verifier — only if it belongs to this user and kind. */
export async function consumeOAuthState(env, { kind, userId, state }) {
  if (!state) return null;
  const row = await first(env, 'DELETE FROM oauth_states WHERE state_hash = ? RETURNING *', await sha256Hex(state));
  if (!row || row.kind !== kind || row.user_id !== userId || row.expires_at < now()) return null;
  return { verifier: await open(cfg(env).encryptionKey, row.verifier_enc), extra: row.extra };
}
export async function exchangeCode(env, code, verifier, redirectUri) {
  const c = cfg(env);
  try {
    const r = await fetch(G.TOKEN, { method: 'POST', headers: FORM, signal: AbortSignal.timeout(TIMEOUT_MS), body: form({ code, client_id: c.googleClientId, client_secret: c.googleClientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch { return { status: 0, body: {} }; }
}
/**
 * Revokes a token at Google. NOTE: Google ties every token an app holds for one Google account to a single grant — revoking
 * ONE refresh token ends ALL of that app's access to that account (user inbox, admin sender, a newer reconnect...).
 * Callers must therefore use releaseGrant() in connection.js, which only revokes when nothing else still uses the account.
 */
export async function revokeToken(token) {
  try { const r = await fetch(G.REVOKE, { method: 'POST', headers: FORM, body: form({ token }), signal: AbortSignal.timeout(8000) }); return r.status === 200; } catch { return false; }
}
/** Claims from the id_token returned directly by Google's token endpoint over TLS. */
export function idTokenClaims(t) {
  try { const p = String(t).split('.')[1]; return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)))); } catch { return {}; }
}

// Short-lived access tokens are cached in process memory only (never in the database, never in logs).
// Each entry remembers WHICH refresh token it came from, so a reconnect / switch to another Gmail can never be served the old account's token.
const cache = new Map();
/**
 * Outcomes: { token } | { revoked: true } (Google says the grant is gone: invalid_grant) |
 *           { error: 'config' } (our OAuth client is wrong/disabled — not the user's fault) | { error: 'unavailable' } (network / 5xx / timeout — retry later).
 */
export async function accessTokenFromRefresh(env, cacheKey, refreshToken) {
  const fp = (await sha256Hex(refreshToken)).slice(0, 16);
  const hit = cache.get(cacheKey); if (hit && hit.fp === fp && hit.exp > Date.now() + 30000) return { token: hit.token };
  const c = cfg(env);
  let r; let j;
  try {
    r = await fetch(G.TOKEN, { method: 'POST', headers: FORM, signal: AbortSignal.timeout(TIMEOUT_MS), body: form({ client_id: c.googleClientId, client_secret: c.googleClientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }) });
    j = await r.json().catch(() => ({}));
  } catch { return { error: 'unavailable' }; }
  if (r.status === 400 && j.error === 'invalid_grant') { cache.delete(cacheKey); return { revoked: true }; }
  if ((r.status === 400 || r.status === 401) && (j.error === 'invalid_client' || j.error === 'unauthorized_client')) return { error: 'config' };
  if (r.status !== 200 || !j.access_token) return { error: 'unavailable' };
  cache.set(cacheKey, { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000, fp });
  return { token: j.access_token };
}
export const forgetCachedToken = (k) => cache.delete(k);
export const clearTokenCache = () => cache.clear();

/** Gmail REST GET. Never throws: a network failure / timeout is reported as status 0 so callers can tell it from a Google answer. */
export async function gmailGet(token, path, query = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);   // Gmail wants metadataHeaders repeated, not comma-joined
  }
  const q = params.toString();
  try {
    const r = await fetch(`${G.API}${path}${q ? '?' + q : ''}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 429 || r.status >= 500) gmailBad(`Gmail answered HTTP ${r.status}`); else gmailOk();      // feeds the "is payment checking working?" watchdog
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch { gmailBad('Gmail is not reachable (network error or timeout)'); return { status: 0, body: {} }; }
}
/** Short machine reason from a Google API error body (e.g. insufficientPermissions, accessNotConfigured, rateLimitExceeded). Never contains user data. */
export function googleReason(body) {
  const e = body && body.error; if (!e) return '';
  const first = Array.isArray(e.errors) && e.errors[0] && e.errors[0].reason;
  const det = Array.isArray(e.details) && e.details.find((d) => d && d.reason);
  return String(first || (det && det.reason) || e.status || '').slice(0, 60);
}
