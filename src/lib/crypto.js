// Web Crypto helpers (globalThis.crypto, available in Node 20+).
const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

export function b64(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
export function unb64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
export const b64u = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
export const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

export function randomBytes(n) { return globalThis.crypto.getRandomValues(new Uint8Array(n)); }
export const randomToken = (n = 32) => b64u(randomBytes(n));
export const randomHex = (n = 16) => hex(randomBytes(n));
/** Uniform integer in [0, max) without modulo bias. */
export function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max; const a = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(a); } while (a[0] >= limit);
  return a[0] % max;
}

export async function sha256Hex(s) { return hex(await subtle().digest('SHA-256', enc.encode(s))); }
export async function hmacHex(secret, msg) {
  const k = await subtle().importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await subtle().sign('HMAC', k, enc.encode(msg)));
}
/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const A = enc.encode(String(a ?? '')), B = enc.encode(String(b ?? ''));
  let d = A.length ^ B.length; const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) d |= (A[i] ?? 0) ^ (B[i] ?? 0);
  return d === 0;
}

// ---- passwords: PBKDF2-SHA256 (iterations capped at 100,000; existing hashes keep verifying) ----
export const PBKDF2_MAX = 100000;
async function pbkdf2(pw, salt, iter) {
  const k = await subtle().importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256));
}
export async function hashPassword(pw, iter = PBKDF2_MAX) {
  const salt = randomBytes(16); iter = Math.min(iter, PBKDF2_MAX);
  return `pbkdf2$${iter}$${b64u(salt)}$${b64u(await pbkdf2(pw, salt, iter))}`;
}
export async function verifyPassword(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
  const iter = Number(p[1]); if (!Number.isInteger(iter) || iter < 1 || iter > PBKDF2_MAX) return false;
  return safeEqual(b64u(await pbkdf2(pw, unb64u(p[2]), iter)), p[3]);
}
/** A fixed valid-looking hash, verified when the user does not exist so timing does not reveal it. */
export const DUMMY_HASH = 'pbkdf2$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// ---- secrets at rest: AES-256-GCM, key = SHA-256(ENCRYPTION_KEY) ----
async function aesKey(secret) {
  if (!secret) throw new Error('ENCRYPTION_KEY is not set');
  return subtle().importKey('raw', await subtle().digest('SHA-256', enc.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(secret, plain) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plain));
  const out = new Uint8Array(12 + ct.byteLength); out.set(iv); out.set(new Uint8Array(ct), 12);
  return b64u(out);
}
export async function open(secret, sealed) {
  try {
    const raw = unb64u(sealed); if (raw.length < 29) return null;
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(secret), raw.slice(12));
    return new TextDecoder().decode(pt);
  } catch { return null; }
}
