// Application entry point (runtime-agnostic Fetch API: Request in, Response out). src/server.js adapts Node's HTTP server to it.
// Every request: build ctx -> route -> handler -> attach cookies -> flash cookie roundtrip.
import { createHash } from 'node:crypto';
import { currentHealth } from './lib/health-state.js';
import { cfg, missingSecrets, gmailConfigured } from './lib/config.js';
import { mkResponse, SECURITY_HEADERS, parseCookies, setCookie } from './lib/http.js';
import { makeCtx, errorPage } from './context.js';
import { makeRouter } from './router.js';
import { ensureSuperAdmin } from './auth/accounts.js';
import { sweepSuspensions, sweepSessions } from './auth/session.js';
import { sweepOtps } from './services/otp.js';
import { sweepRateLimits } from './lib/ratelimit.js';
import { expireOrders } from './payments/core.js';
import { telegramWelcomeRoute } from './services/telegram-welcome.js';

import { registerPage, loginPage, loginCodePage, loginVerifyPage, forgotPasswordPage, resetPasswordPage, verifyEmailPage, logoutPage } from './pages/auth.js';
import { notifyFeed } from './pages/notify.js';
import { settingsPasswordPage } from './pages/settings-password.js';
import { dashboardPage, settingsPage, gmailConnectRoute, gmailCallbackRoute, gmailInboxPage, gmailInboxLive, gmailMessagePage, gmailMiniFragment, dashboardLive } from './pages/dashboard.js';
import { adminHome, adminUsersPage, adminApprovalsPage, adminUsersEmailsCsv, adminUserDetailPage, adminPaymentsPage, adminAuditPage, adminGmailPage } from './pages/admin.js';
import { adminBackupPage } from './pages/admin-backup.js';
import { adminKeysPage } from './pages/admin-keys.js';
import { adminAnnouncementsPage } from './pages/admin-announcements.js';
import { adminMailPage, adminMailConnectRoute, adminMailCallbackRoute, adminInboxPage } from './pages/admin-mail.js';
import { payPage } from './pages/pay.js';
import { privacyPage } from './pages/privacy.js';
import { termsPage } from './pages/terms.js';
import { createOrderApi, paymentStatusApi, checkPaymentApi, globalCheckPaymentApi, orderStatusApi, webhookApi, verifyApi, qrPngRoute } from './payments/api.js';
import { STATIC_ASSETS, versionAssets } from './static.js';
import { first } from './lib/db.js';

const router = makeRouter();
router.get('/', (ctx) => serveHome(ctx));
router.get('/index.html', (ctx) => serveHome(ctx));
router.get('/robots.txt', (ctx) => robotsTxt(ctx));
router.get('/sitemap.xml', (ctx) => sitemapXml(ctx));
router.any('/register', registerPage); router.any('/login', loginPage); router.any('/login-code', loginCodePage); router.any('/login-verify', loginVerifyPage);
router.any('/forgot-password', forgotPasswordPage); router.any('/reset-password', resetPasswordPage); router.any('/verify-email', verifyEmailPage); router.get('/logout', logoutPage);
router.any('/dashboard', dashboardPage); router.get('/dashboard/live', dashboardLive); router.any('/settings', settingsPage); router.any('/settings/password', settingsPasswordPage);
router.get('/gmail-connect', gmailConnectRoute); router.get('/gmail-callback', gmailCallbackRoute); router.get('/gmail-inbox', gmailInboxPage); router.get('/gmail-inbox/live', gmailInboxLive); router.get('/gmail-inbox/mini', gmailMiniFragment); router.get('/notify/feed', notifyFeed); router.get('/gmail-message', gmailMessagePage);
router.get('/admin', adminHome); router.get('/admin/users/emails.csv', adminUsersEmailsCsv); router.any('/admin/approvals', adminApprovalsPage); router.any('/admin/users', adminUsersPage); router.any('/admin/users/:id', adminUserDetailPage); router.any('/admin/payments', adminPaymentsPage); router.get('/admin/audit', adminAuditPage); router.get('/admin/gmail', adminGmailPage);
router.any('/admin/backup', adminBackupPage); router.any('/admin/keys', adminKeysPage); router.any('/admin/announcements', adminAnnouncementsPage); router.any('/admin/mail', adminMailPage); router.get('/admin/mail-connect', adminMailConnectRoute); router.get('/admin/mail-callback', adminMailCallbackRoute); router.get('/admin/inbox', adminInboxPage);
router.post('/telegram/welcome-forward', telegramWelcomeRoute);
router.get('/pay', payPage);
router.get('/privacy', privacyPage);
router.get('/terms', termsPage);
router.any('/api/:upi/create_order.php', createOrderApi);
router.get('/api/payment/status', paymentStatusApi);
router.any('/api/check_payment.php', globalCheckPaymentApi);
router.any('/api/:upi/check_payment.php', checkPaymentApi);
router.any('/api/:upi/key=:key', checkPaymentApi);
router.get('/api/order_status.php', orderStatusApi);
router.get('/temporary/qr/:order', qrPngRoute);
router.post('/api/webhook.php', webhookApi);
router.post('/api/verify.php', verifyApi);
// The Replit workspace reserves /api for its separate API Server artifact.
// Keep the legacy routes above, and expose the same gateway handlers on an unclaimed prefix.
router.any('/gateway-api/:upi/create_order.php', createOrderApi);
router.get('/gateway-api/payment/status', paymentStatusApi);
router.any('/gateway-api/check_payment.php', globalCheckPaymentApi);
router.any('/gateway-api/:upi/check_payment.php', checkPaymentApi);
router.any('/gateway-api/:upi/key=:key', checkPaymentApi);
router.get('/gateway-api/order_status.php', orderStatusApi);
router.post('/gateway-api/webhook.php', webhookApi);
router.post('/gateway-api/verify.php', verifyApi);
router.get('/health', async (ctx) => {
  const t0 = Date.now();   // database = the PostgreSQL server (Aiven): "Running correctly" / "Running slowly" (answer took 2 s or more) / "Not responding" (HTTP 503)
  try { await first(ctx.env, 'SELECT 1 AS ok'); return ctx.json({ status: 'ok', database: Date.now() - t0 >= 2000 ? 'Running slowly' : 'Running correctly', payment_checking: currentHealth().state }); }   // HTTP stays 200 unless the database is down, so Render never restarts the app because of Gmail
  catch (e) { console.error('health check failed:', e.message); return ctx.json({ status: 'error', database: 'Not responding' }, 503); }
});

// Public origin used in SEO files: APP_URL when set, otherwise the origin of this request (proxy headers are honoured by server.js).
const siteOrigin = (ctx) => (ctx.c && ctx.c.origin) || (ctx.url && ctx.url.origin) || '';
const PUBLIC_PAGES = ['/', '/privacy', '/terms'];

/** The landing page, with the canonical/Open Graph URLs pointing at THIS site (the file ships with a placeholder domain). */
async function serveHome(ctx) {
  const asset = STATIC_ASSETS['/index.html']; if (!asset) return null;
  const origin = siteOrigin(ctx);
  const body = versionAssets(origin ? asset.body.toString('utf8').replaceAll('https://YOUR-DOMAIN.com', origin) : asset.body.toString('utf8'));
  return new Response(body, { headers: { 'Content-Type': asset.type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS } });
}
/** robots.txt: public pages crawlable, private/app areas not, and the sitemap location (needed by Google Search Console). */
function robotsTxt(ctx) {
  const origin = siteOrigin(ctx);
  const lines = ['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /dashboard', 'Disallow: /settings', 'Disallow: /api/', 'Disallow: /gateway-api/', 'Disallow: /pay', 'Disallow: /temporary/', 'Disallow: /health', origin ? `Sitemap: ${origin}/sitemap.xml` : ''].filter(Boolean);
  return new Response(lines.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...SECURITY_HEADERS } });
}
function sitemapXml(ctx) {
  const origin = siteOrigin(ctx);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PUBLIC_PAGES.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...SECURITY_HEADERS } });
}

// CSS / JS are revalidated on every load (ETag -> a tiny 304 when unchanged) so a deploy shows up immediately instead of after a stale
// 1-hour browser cache; images and other files keep the 1-hour cache.
const etags = new Map();
const etagOf = (path, body) => { let t = etags.get(path); if (!t) { t = '"' + createHash('sha1').update(body).digest('hex').slice(0, 20) + '"'; etags.set(path, t); } return t; };
async function serveStatic(ctx, path) {
  const asset = STATIC_ASSETS[path]; if (!asset) return null;
  const live = path.startsWith('/assets/') && /\.(css|js)$/.test(path);
  if (live) {
    const tag = etagOf(path, asset.body);
    const h = { ETag: tag, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS };
    if (ctx.request && ctx.request.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers: h });
    return new Response(asset.body, { headers: { 'Content-Type': asset.type, ...h } });
  }
  return new Response(asset.body, { headers: { 'Content-Type': asset.type, 'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=3600' : 'no-store', ...SECURITY_HEADERS } });
}

// Re-checks the SUPER_ADMIN row at most once a minute per environment (it also runs once at boot).
const adminChecked = new WeakMap();
function ensureAdminSoon(ctx) {
  const last = adminChecked.get(ctx.env) || 0; if (Date.now() - last < 60000) return;
  adminChecked.set(ctx.env, Date.now());
  ctx.defer(ensureSuperAdmin(ctx.env).catch((e) => console.error('ensureSuperAdmin failed:', e.message)));
}

/** Periodic housekeeping (was the Cloudflare cron trigger, every 5 minutes). Idempotent, so it is safe on several instances. */
export async function runMaintenance(env) {
  const names = ['expireOrders', 'sweepSuspensions', 'sweepSessions', 'sweepOtps', 'sweepRateLimits'];
  const jobs = [expireOrders(env), sweepSuspensions(env), sweepSessions(env), sweepOtps(env), sweepRateLimits(env)];
  if (cfg(env).paymentsEnabled) {
    const { reconcileOpenGmailAccounts } = await import('./gmail/reconcile.js');
    jobs.push(reconcileOpenGmailAccounts(env));
    names.push('reconcileOpenGmailAccounts');
  }
  jobs.push(import('./services/keynotice.js').then((m) => m.sendKeyExpiryNotices(env))); names.push('sendKeyExpiryNotices');
  jobs.push(import('./services/announcements.js').then((m) => m.resumeAnnouncements(env))); names.push('resumeAnnouncements');
  const res = await Promise.allSettled(jobs);
  res.forEach((r, i) => { if (r.status === 'rejected') console.error('maintenance ' + names[i] + ' failed:', r.reason && r.reason.message); });
}

export default {
  async fetch(request, env, exec) {
    try {
      const url = new URL(request.url); let path = url.pathname.replace(/\/+$/, '') || '/';
      if (path.startsWith('/assets/')) { const s = await serveStatic({ request }, path); if (s) return s; }
      const missing = missingSecrets(env);
      if (missing.length) return mkResponse(errorPage('The server is misconfigured (missing: ' + missing.join(', ') + '). Please contact the site owner.'), { status: 500 });

      const m = router.match(request.method, path);
      if (!m) {
        const s = await serveStatic({ request }, path); if (s) return s;
        // A broken/unknown PAGE link goes straight to the home page instead of a "page not found" screen. APIs, assets, QR images,
        // files with other extensions and non-GET requests keep a real 404 so integrations and browsers see the truth.
        const pageLike = (request.method === 'GET' || request.method === 'HEAD') && !/^\/(api|gateway-api|assets|temporary)(\/|$)/.test(path) && (!/\.[A-Za-z0-9]{1,6}$/.test(path) || /\.(html?|php|aspx?|jsp)$/i.test(path));
        if (pageLike) return new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store', ...SECURITY_HEADERS } });
        return mkResponse(errorPage('That page does not exist.'), { status: 404 });
      }
      const ctx = makeCtx(request, env, exec, url, path); ctx.params = m.params;

      // flash: a one-shot cookie carried across the redirect it was set before
      const flashCookie = parseCookies(request)['gw_flash'];
      ctx._flashIn = flashCookie ? safeParseFlash(flashCookie) : null;
      if (flashCookie) ctx.cookies.push(setCookie('gw_flash', '', { maxAge: 0 }));

      ensureAdminSoon(ctx);   // idempotent; also runs once at boot (server.js)

      const res = await m.handler(ctx);
      if (!ctx.c.paymentsEnabled) res.headers.set('X-Robots-Tag', 'noindex, nofollow');
      if (ctx._flash) res.headers.append('Set-Cookie', setCookie('gw_flash', encodeURIComponent(JSON.stringify(ctx._flash)), { maxAge: 30, secure: ctx.c.isProd }));
      return res;
    } catch (e) {
      console.error('unhandled error:', e && e.stack || e);
      return mkResponse(errorPage('Something went wrong. Please try again.'), { status: 500 });
    }
  },
};
function safeParseFlash(v) { try { return JSON.parse(decodeURIComponent(v)); } catch { return null; } }
