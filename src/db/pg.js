// PostgreSQL driver for production (Render). Wraps a node-postgres pool in the tiny interface src/lib/db.js expects.
import pg from 'pg';

// BIGINT (timestamps, paise, ids) and NUMERIC come back as JS numbers — all values here are far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

/**
 * Optional DATABASE_CA: the PEM certificate of the CA that signed the database server's certificate (Aiven shows it as "CA certificate").
 * Accepts the PEM text as is, a single-line PEM with literal \n, or the PEM base64-encoded. It is only ever used to VERIFY the server
 * (it replaces Node's default trust store for this connection); it never turns verification off. An unusable value fails closed.
 */
export function caOption(env = process.env) {
  const raw = String(env.DATABASE_CA || '').trim();
  if (!raw) return undefined;
  const isPem = (s) => /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(s);
  let pem = raw.replace(/\\n/g, '\n');
  if (!isPem(pem)) { try { pem = Buffer.from(raw, 'base64').toString('utf8'); } catch { pem = ''; } }
  if (!isPem(pem)) throw new Error('DATABASE_CA is set but is not a PEM certificate (expected -----BEGIN CERTIFICATE-----, plain or base64-encoded).');
  return pem;
}

export function sslOption(url, env = process.env) {
  const flag = String(env.DATABASE_SSL || '').toLowerCase();
  const ca = caOption(env);
  const production = env.NODE_ENV === 'production' || env.APP_ENV === 'production';
  if (production) {
    try {
      const params = new URL(url).searchParams;
      const mode = String(params.get('sslmode') || '').toLowerCase();
      const ssl = String(params.get('ssl') || '').toLowerCase();
      const libpqCompat = String(params.get('uselibpqcompat') || '').toLowerCase() === 'true';
      const explicitlyPlaintext = ['0', 'false', 'off', 'no', 'disable'].includes(ssl) || mode === 'disable';
      const skipsVerification = ssl === 'no-verify' || ['no-verify', 'prefer', 'verify-ca'].includes(mode) || (libpqCompat && mode && mode !== 'verify-full');
      if (explicitlyPlaintext || skipsVerification) {
        throw new Error('DATABASE_URL requests disabled or weakly verified TLS. Remove the SSL query override and use TLS with certificate verification.');
      }
    } catch (error) {
      if (error instanceof Error && /requests disabled or weakly verified TLS/.test(error.message)) throw error;
    }
  }
  if (['0', 'false', 'off', 'disable'].includes(flag)) {
    if (production) {
      throw new Error('DATABASE_SSL cannot disable TLS in production; remove the override and use the Render internal URL or TLS-enabled external URL.');
    }
    return false;
  }
  if (['1', 'true', 'on', 'require'].includes(flag)) return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  if (ca) return { rejectUnauthorized: true, ca };   // a CA certificate was supplied, so the server is verified against it (hostname check stays on)
  // auto: Render's *external* URL (public hostname) needs TLS; the *internal* URL (short hostname) does not.
  try { const h = new URL(url).hostname; if (/\.render\.com$/i.test(h)) return { rejectUnauthorized: true }; } catch { /* fall through */ }
  return false;
}

/**
 * pg-connection-string v2 warns at every startup when the URL carries sslmode=require/prefer/verify-ca (it treats them as
 * verify-full). To keep the exact same behaviour without the warning, strip those query params and request verified TLS
 * explicitly. Other sslmode values (disable, no-verify) are left untouched so sslOption()'s production guard still sees them.
 */
export function normalizeDatabaseUrl(url, env = process.env) {
  const ssl = sslOption(url, env);
  const m = /[?&]sslmode=([^&#]*)/i.exec(url);
  const mode = m ? decodeURIComponent(m[1]).toLowerCase() : '';
  if (!['require', 'prefer', 'verify-ca', 'verify-full'].includes(mode)) return { connectionString: url, ssl };
  const cleaned = url
    .replace(/([?&])(sslmode|uselibpqcompat)=[^&#]*/gi, '$1')
    .replace(/\?&+/, '?').replace(/&{2,}/g, '&').replace(/[?&]+(#|$)/, '$1');
  return { connectionString: cleaned, ssl: ssl && typeof ssl === 'object' ? ssl : { rejectUnauthorized: true } };
}

export function createPgDriver(env = process.env) {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (use the Internal Database URL of your Render PostgreSQL instance).');
  const pool = new pg.Pool({
    ...normalizeDatabaseUrl(url, env), max: Number(env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, statement_timeout: 20000, application_name: 'unknownxfam-gateway',
  });
  pool.on('error', (e) => console.error('postgres pool error:', e.message));   // idle-client errors must not crash the process
  return {
    query: (text, params) => pool.query(text, params),
    exec: (text) => pool.query(text),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn({ query: (t, p) => c.query(t, p), exec: (t) => c.query(t) });
        await c.query('COMMIT'); return r;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    end: () => pool.end(),
  };
}
