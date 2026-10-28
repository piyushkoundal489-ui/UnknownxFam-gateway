// Per-request context: response helpers that carry cookies, lazy session/CSRF, and rate-limit shortcuts.
import { cfg } from './lib/config.js';
import { mkResponse, htmlBody, clientIp, userAgent, readForm } from './lib/http.js';
import { loadSession, csrfIssue, csrfValid, originOk } from './auth/session.js';
import { hit, peek } from './lib/ratelimit.js';
import { first } from './lib/db.js';
import { gmailOnlyOk } from './auth/accounts.js';

export function makeCtx(request, env, exec, url, path) {
  const ctx = {
    env, request, url, path, method: request.method, exec, params: {}, c: cfg(env), ip: clientIp(request, env), ua: userAgent(request),
    cookies: [], _user: undefined, _csrf: undefined, form: {},
    defer(p) { try { exec.waitUntil(Promise.resolve(p).catch((e) => console.error('deferred task failed:', e && e.message))); } catch { /* ignore */ } },
    page(body, status = 200, headers = {}) { return mkResponse(htmlBody(body), { status, headers, cookies: ctx.cookies }); },
    json(obj, status = 200, headers = {}) { return mkResponse(JSON.stringify(obj), { status, type: 'application/json; charset=utf-8', headers, cookies: ctx.cookies }); },
    text(s, status = 200) { return mkResponse(s, { status, type: 'text/plain; charset=utf-8', cookies: ctx.cookies }); },
    redirect(to, status = 303) { return mkResponse('', { status, headers: { Location: to }, cookies: ctx.cookies }); },
    /** Signed-in user or null (loads the session once). */
    async user() {
      if (ctx._user === undefined) {
        const s = await loadSession(env, request);
        ctx._user = s && gmailOnlyOk(env, s.user) ? s.user : null;     // Gmail-only: a signed-in non-Gmail account (other than the owner) is treated as signed out
        // staff see the number of waiting account requests on the "Pending approvals" tab (read by pages/admin-tabs.js)
        if (ctx._user && ['SUPPORT', 'ADMIN', 'SUPER_ADMIN'].includes(ctx._user.role)) {
          try {
            const needVerified = (await first(env, "SELECT v FROM app_settings WHERE k = 'otp_signup'"))?.v === '1';   // same rule as the Pending approvals list
            const r = await first(env, `SELECT COUNT(*) AS n FROM users WHERE approval = 'pending'${needVerified ? ' AND email_verified = 1' : ''}`);
            ctx._user.pending_approvals = Number(r?.n) || 0;
          } catch { ctx._user.pending_approvals = 0; }
        }
      }
      return ctx._user;
    },
    /** CSRF token to embed in forms (sets the cookie if it does not exist yet). */
    async csrf() { if (ctx._csrf === undefined) { const r = await csrfIssue(env, request); ctx._csrf = r.token; if (r.cookie) ctx.cookies.push(r.cookie); } return ctx._csrf; },
    /** Parses the form and verifies Origin + CSRF token. Returns an error Response or null. */
    async checkCsrf() {
      ctx.form = await readForm(request);
      if (!originOk(env, request) || !(await csrfValid(env, request, ctx.form._csrf))) return ctx.page(errorPage('Your session expired or the request was blocked. Go back, reload the page and try again.'), 403);
      return null;
    },
    /** Applies a rate-limit rule; returns a 429 Response when exceeded, else null. */
    async limit(rule, subject, r, { json = false } = {}) {
      const res = await hit(env, rule, subject, r);
      if (res.ok) return null; return tooMany(ctx, res.retryAfter, json);
    },
    async blocked(rule, subject, r, { json = false } = {}) {
      const res = await peek(env, rule, subject, r); return res.blocked ? tooMany(ctx, res.retryAfter, json) : null;
    },
  };
  return ctx;
}
export function tooMany(ctx, retryAfter, json = false) {
  const h = { 'Retry-After': String(Math.max(1, retryAfter)) };
  return json ? ctx.json({ status: 'error', message: 'Too many requests. Please slow down.' }, 429, h) : ctx.page(errorPage('Too many attempts. Please wait a little and try again.'), 429, h);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const errorPage = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notice</title><link rel="stylesheet" href="/assets/style.css"><div class="wrap narrow"><div class="card" style="margin-top:60px"><h2>Notice</h2><p>${esc(msg)}</p><p><a class="btn" href="/">Home</a></p></div></div>`;
