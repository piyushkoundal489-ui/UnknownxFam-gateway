// Migration runner: applies db/migrations/*.sql (in name order) exactly once, inside one transaction guarded by an
// advisory lock, so several instances starting at the same time cannot race. Safe to run on every boot.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

export async function migrate(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
  const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  const applied = [];
  await db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock(727274001)');
    const done = new Set((await t.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      log('applying migration ' + f);
      await t.exec(readFileSync(join(dir, f), 'utf8'));
      await t.query('INSERT INTO schema_migrations(name, applied_at) VALUES ($1, $2)', [f, Math.floor(Date.now() / 1000)]);
      applied.push(f);
    }
  });
  return applied;
}

export async function assertSchemaReady(db) {
  const result = await db.query(`
    SELECT
      to_regclass('public.users') AS users,
      to_regclass('public.orders') AS orders,
      to_regclass('public.schema_migrations') AS schema_migrations
  `);
  const row = result.rows[0] || {};
  const missing = ['users', 'orders', 'schema_migrations'].filter((name) => !row[name]);
  if (missing.length) {
    throw new Error(
      `Production database schema is missing ${missing.join(', ')}. Run the development database migrations, then publish the schema before serving production traffic.`,
    );
  }
}
