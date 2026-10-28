import { versionAssets } from '../static.js';
import { Safe } from './html.js';

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  // No inline scripts anywhere: scripts load only from our own /assets. Inline styles are allowed for style="" attributes.
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function mkResponse(body, { status = 200, type = 'text/html; charset=utf-8', headers = {}, cookies = [] } = {}) {
  const h = new Headers({ 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(body, { status, headers: h });
}
export const htmlBody = (x) => versionAssets(x instanceof Safe ? x.s : String(x));

export function parseCookies(request) {
  const out = {}; const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
export function setCookie(name, value, { maxAge, secure = true, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${value}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (secure) c += '; Secure';
  if (httpOnly) c += '; HttpOnly';
  return c;
}

/** Reads an urlencoded form body (max 64 KB). */
export async function readForm(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > 65536) return {};
  const text = (await request.text()).slice(0, 65536);
  const out = {}; for (const [k, v] of new URLSearchParams(text)) out[k] = v; return out;
}
export async function readJson(request) {
  try { const t = (await request.text()).slice(0, 65536); const j = JSON.parse(t); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
/**
 * Client IP behind Render's proxy chain. Render appends to (and does not reset) X-Forwarded-For, so its left-most
 * entries can be forged by the caller. Order used: CLIENT_IP_HEADER (if set) -> CF-Connecting-IP / True-Client-IP
 * (set by the CDN edge in front of Render, not by the caller) -> the entry TRUSTED_PROXY_HOPS from the right of X-Forwarded-For.
 */
export function clientIp(request, env = (globalThis.process && globalThis.process.env) || {}) {
  const h = request.headers; const pick = (name) => (h.get(name) || '').split(',')[0].trim();
  const custom = String(env.CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (custom) return pick(custom).slice(0, 64) || 'unknown';
  const edge = pick('cf-connecting-ip') || pick('true-client-ip'); if (edge) return edge.slice(0, 64);
  const xff = (h.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const hops = Math.max(1, Number(env.TRUSTED_PROXY_HOPS) || 1);
  return (xff[xff.length - hops] || 'unknown').slice(0, 64);
}
export const userAgent = (request) => (request.headers.get('User-Agent') || '').slice(0, 200);
