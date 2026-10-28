// Node HTTP server for the gateway. Listens on 0.0.0.0:$PORT and runs the periodic maintenance job.
import http from 'node:http';
import app, { runMaintenance } from './app.js';
import { reconcileOpenGmailAccounts, refreshIdleBalances } from './gmail/reconcile.js';
import { maybeBackup } from './services/backup.js';
import { registerTelegramWebhook } from './services/telegram-welcome.js';
import { createPgDriver } from './db/pg.js';
import { assertSchemaReady, migrate } from './db/migrate.js';
import { ensureSuperAdmin } from './auth/accounts.js';
import { configure as healthConfigure, roundDone } from './lib/health-state.js';
import { startMonitor } from './services/monitor.js';
import { cfg, missingSecrets } from './lib/config.js';

const MAX_BODY = 1024 * 1024;                     // 1 MiB; the app itself only reads the first 64 KB of any body
const MAINTENANCE_MS = 5 * 60 * 1000;             // was the Cloudflare cron: every 5 minutes

const env = process.env;
const pending = new Set();                        // background tasks (ctx.defer) tracked for graceful shutdown
const exec = { waitUntil(p) { const t = Promise.resolve(p).catch((e) => console.error('background task failed:', e && e.message)).finally(() => pending.delete(t)); pending.add(t); } };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res, appEnv) {
  try {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
    const url = `${proto}://${req.headers.host || 'localhost'}${req.url}`;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const body = hasBody ? await readBody(req) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) { if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v !== undefined) headers.set(k, v); }
    const request = new Request(url, { method: req.method === 'HEAD' ? 'GET' : req.method, headers, body: hasBody && body.length ? body : undefined });   // HEAD is served as GET, body stripped below
    const response = await app.fetch(request, appEnv, exec);
    const out = {}; const cookies = response.headers.getSetCookie();
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
    if (cookies.length) out['set-cookie'] = cookies;
    const buf = Buffer.from(await response.arrayBuffer());
    out['content-length'] = buf.length;
    res.writeHead(response.status, out);
    res.end(req.method === 'HEAD' ? undefined : buf);
  } catch (e) {
    const status = e && e.status === 413 ? 413 : 500;
    if (status === 500) console.error('request failed:', e && e.stack || e);
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(status === 413 ? 'Payload too large' : 'Internal Server Error');
  }
}

async function main() {
  const c = cfg(env);
  const missing = missingSecrets(env);
  if (missing.length) console.error('WARNING: missing/short secrets: ' + missing.join(', ') + ' — the app will refuse to serve until they are set.');
  if (c.isProd && !c.appUrl) console.error('WARNING: APP_URL is not set — OAuth redirects, origin checks and emails need it.');
  if (c.isProd && !c.adminPassword) console.error('WARNING: ADMIN_PASSWORD is not set — admin login stays disabled.');

  const db = createPgDriver(env);
  const appEnv = new Proxy(env, { get: (t, k) => (k === 'DB' ? db : t[k]), has: (t, k) => k === 'DB' || k in t });   // env.DB = Postgres, everything else = process.env
  if (c.isProd) {
    await assertSchemaReady(db);
  } else {
    const applied = await migrate(db, { log: (m) => console.log(m) });
    if (applied.length) console.log('migrations applied:', applied.join(', '));
  }
  if (!missing.length) await ensureSuperAdmin(appEnv).catch((e) => console.error('ensureSuperAdmin failed:', e.message));

  const server = http.createServer((req, res) => { handle(req, res, appEnv); });
  server.keepAliveTimeout = 65000; server.headersTimeout = 66000; server.requestTimeout = 30000;   // longer than Render's proxy idle timeout
  const port = Number(env.PORT) || 10000;
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  console.log(`UnknownXfam Gateway listening on 0.0.0.0:${port} (${c.appEnv}) ${c.appUrl ? '— ' + c.appUrl : ''}`);

  const timer = setInterval(() => { exec.waitUntil(runMaintenance(appEnv)); }, MAINTENANCE_MS); timer.unref();
  exec.waitUntil(runMaintenance(appEnv));

  // Fast payment detection: every GMAIL_POLL_SECONDS (default 2, minimum 1; 0 = off) read the Gmail INBOX of every merchant with an
  // OPEN order, and refresh the FamPay balance of every other connected merchant. Rounds run back-to-back (the next one starts
  // GMAIL_POLL_SECONDS after the previous one STARTED, or right away if it was slower), never overlapping.
  const pollSec = env.GMAIL_POLL_SECONDS === undefined || env.GMAIL_POLL_SECONDS === '' ? 2 : Number(env.GMAIL_POLL_SECONDS);
  const idleOn = String(env.GMAIL_IDLE_POLL || '1') !== '0';   // GMAIL_IDLE_POLL=0: only merchants with open orders are polled (no live balance for idle ones)
  let fastTimer = null; let fastStopped = false;
  healthConfigure({ pollOn: pollSec > 0 && Number.isFinite(pollSec) });
  const stopMonitor = startMonitor(appEnv);       // alerts (Telegram + e-mail) when payment checking stops, and when it is back
  if (pollSec > 0 && Number.isFinite(pollSec)) {
    const ms = Math.max(1, pollSec) * 1000; const gap = Math.max(1, Math.floor(ms / 1000) - 1);
    const schedule = (delay) => { if (fastStopped) return; fastTimer = setTimeout(() => exec.waitUntil(round()), delay); fastTimer.unref(); };
    const round = async () => {
      const t0 = Date.now();
      try { await reconcileOpenGmailAccounts(appEnv, gap); if (idleOn) await refreshIdleBalances(appEnv, gap); roundDone(true); }
      catch (e) { console.error('gmail fast poll failed:', e.message); roundDone(false, e.message); }
      schedule(Math.max(250, ms - (Date.now() - t0)));
    };
    schedule(1000);
    console.log(`Gmail payment checks every ${ms / 1000}s for merchants with open orders` + (idleOn ? '; FamPay balance refresh for all other connected merchants' : ''));
  }

  // Telegram backup: checked every 15 minutes; a database claim guarantees one backup per interval even across redeploys/instances.
  const backupTick = () => exec.waitUntil(maybeBackup(appEnv).then((r) => { if (r && r.parts) console.log(`telegram backup sent (${r.parts} file(s), ${r.rows} rows)`); }).catch((e) => console.error('telegram backup failed:', e.message)));
  const backupTimer = setInterval(backupTick, 15 * 60 * 1000); backupTimer.unref();
  const backupFirst = setTimeout(backupTick, 60 * 1000); backupFirst.unref();

  // Telegram: point the bot's webhook at /telegram/welcome-forward so /start gets the welcome reply.
  registerTelegramWebhook(appEnv, c.appUrl).then((r) => console.log('telegram webhook:', r.ok ? 'registered ' + r.url : 'skipped (' + r.skipped + ')')).catch((e) => console.error('telegram webhook failed:', e.message));

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return; closing = true; console.log(sig + ' received — shutting down');
    clearInterval(timer); stopMonitor(); fastStopped = true; if (fastTimer) clearTimeout(fastTimer); clearInterval(backupTimer); clearTimeout(backupFirst);
    const force = setTimeout(() => process.exit(1), 25000); force.unref();
    server.close();
    await Promise.allSettled([...pending]);
    await db.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
}
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.stack || e));
main().catch((e) => { console.error('fatal startup error:', e && e.stack || e); process.exit(1); });
