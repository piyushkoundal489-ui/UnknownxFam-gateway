// One-time data migration from the old Cloudflare D1 database into PostgreSQL.
//   1) On the old setup:  npx wrangler d1 export unknownxfam-gateway --remote --no-schema --output=d1-data.sql
//   2) Point DATABASE_URL at the new Postgres (use Render's EXTERNAL URL from your machine) and run:
//        node scripts/import-d1-dump.mjs d1-data.sql --replace
// `--replace` empties the app tables first (needed because the service creates the SUPER_ADMIN row on first boot).
// Everything runs in ONE transaction: any error (e.g. a CHECK constraint) rolls the whole import back.
import { readFileSync } from 'node:fs';
import { createPgDriver } from '../src/db/pg.js';
import { migrate } from '../src/db/migrate.js';

// Parents before children (foreign keys).
const ORDER = ['users', 'orders', 'gmail_accounts', 'sessions', 'payments', 'gmail_payment_messages', 'payment_matches', 'payment_events', 'payment_audit_logs',
  'order_events', 'api_activity', 'audit_log', 'security_events', 'email_otps', 'oauth_states', 'rate_limits', 'app_settings'];
const IDENTITY = ['users', 'payment_events', 'audit_log', 'order_events', 'api_activity', 'email_otps', 'security_events', 'payments', 'gmail_payment_messages', 'payment_matches', 'payment_audit_logs'];

/** Splits a SQL dump into statements on `;` outside '...' literals; rewrites SQLite's char(n) to Postgres chr(n) outside literals. */
export function splitStatements(text) {
  const out = []; let cur = ''; let inStr = false; let seg = '';
  const flushSeg = () => { cur += seg.replace(/\bchar\(/gi, 'chr('); seg = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { cur += ch; if (ch === "'") { if (text[i + 1] === "'") cur += text[++i]; else inStr = false; } continue; }
    if (ch === "'") { flushSeg(); inStr = true; cur += ch; continue; }
    if (ch === '-' && text[i + 1] === '-') { while (i < text.length && text[i] !== '\n') i++; seg += '\n'; continue; }   // -- comment
    if (ch === ';') { flushSeg(); if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    seg += ch;
  }
  flushSeg(); if (cur.trim()) out.push(cur.trim());
  return out;
}
export function tableOf(sql) { const m = /^INSERT\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(sql); return m ? m[1].toLowerCase() : null; }

async function main() {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) { console.error('usage: node scripts/import-d1-dump.mjs <d1-export.sql> [--replace]'); process.exit(2); }
  const replace = flags.includes('--replace');
  const byTable = {}; const skipped = new Set();
  for (const s of splitStatements(readFileSync(file, 'utf8'))) {
    const t = tableOf(s); if (!t) continue;
    if (!ORDER.includes(t)) { skipped.add(t); continue; }
    (byTable[t] ||= []).push(s);
  }
  const db = createPgDriver(process.env);
  try {
    await migrate(db);
    await db.tx(async (t) => {
      const existing = (await t.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
      if (existing && !replace) throw new Error(`the target database already has ${existing} user(s); re-run with --replace to empty the app tables first`);
      if (replace) await t.exec('TRUNCATE ' + ORDER.join(', ') + ' RESTART IDENTITY CASCADE');
      for (const table of ORDER) {
        const stmts = byTable[table] || []; for (const s of stmts) await t.query(s);
        console.log(table.padEnd(24), stmts.length + ' rows');
      }
      for (const table of IDENTITY) await t.exec(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT MAX(id) IS NOT NULL FROM ${table}))`);
    });
    if (skipped.size) console.log('ignored (not app data):', [...skipped].join(', '));
    console.log('Import complete. Keep ENCRYPTION_KEY and SESSION_SECRET identical to the old deployment.');
  } finally { await db.end(); }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('Import failed, nothing was written:', e.message); process.exit(1); });
