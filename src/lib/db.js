// The single data-access layer. Every SQL statement in the app goes through these helpers.
// Statements are written with `?` placeholders and rewritten to PostgreSQL's $1..$n here, so call sites stay readable.
// `env.DB` is a small driver object (see src/db/pg.js): { query(sql, params), exec(sql), tx(fn), end() }.
// PostgreSQL has real transactions, so batch() is a genuine all-or-nothing transaction; races are still
// prevented with conditional UPDATEs and unique indexes exactly as before.
export const now = () => Math.floor(Date.now() / 1000);

/** `?` -> `$n`, skipping anything inside '...' string literals or "..." identifiers. */
export function toPg(sql) {
  let out = ''; let n = 0; let quote = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) { out += ch; if (ch === quote) { if (sql[i + 1] === quote) { out += sql[++i]; } else quote = ''; } continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === '?' ? '$' + (++n) : ch;
  }
  return out;
}
const clean = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const exec = (db, sql, args) => db.query(toPg(sql), clean(args));

export const stmt = (env, sql, ...args) => ({ sql, args });
export async function first(env, sql, ...args) { return (await exec(env.DB, sql, args)).rows[0] || null; }
export async function all(env, sql, ...args) { return (await exec(env.DB, sql, args)).rows; }
export async function run(env, sql, ...args) { const r = await exec(env.DB, sql, args); return { rows: r.rows, meta: { changes: r.rowCount || 0 } }; }
export const changes = (r) => (r && r.meta && r.meta.changes) || 0;
/** Runs the statements from stmt() atomically (one transaction). */
export const batch = (env, stmts) => env.DB.tx(async (t) => { const out = []; for (const s of stmts) out.push(await exec(t, s.sql, s.args)); return out; });
/** Interactive transaction: fn receives { first, all, run } bound to ONE connection; commits on return, rolls back on throw. */
export const withTx = (env, fn) => env.DB.tx((t) => fn({
  first: async (sql, ...args) => (await exec(t, sql, args)).rows[0] || null,
  all: async (sql, ...args) => (await exec(t, sql, args)).rows,
  run: async (sql, ...args) => { const r = await exec(t, sql, args); return { rows: r.rows, meta: { changes: r.rowCount || 0 } }; },
}));
/** PostgreSQL unique_violation is SQLSTATE 23505. */
export const isUnique = (e) => !!e && (e.code === '23505' || /duplicate key value violates unique constraint/i.test(String(e.message)));

// ---- key/value settings (admin-managed) ----
export async function getSetting(env, k, d = '') { const r = await first(env, 'SELECT v FROM app_settings WHERE k = ?', k); return r ? r.v : d; }
export async function setSetting(env, k, v) { await run(env, 'INSERT INTO app_settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v)); }
export async function getSettings(env, keys) {
  const rows = await all(env, `SELECT k, v FROM app_settings WHERE k IN (${keys.map(() => '?').join(',')})`, ...keys);
  const o = Object.fromEntries(keys.map((k) => [k, ''])); for (const r of rows) o[r.k] = r.v; return o;
}
