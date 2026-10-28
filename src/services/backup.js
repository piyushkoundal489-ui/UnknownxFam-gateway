// Encrypted database backups delivered to a private Telegram channel by a bot (Bot API, HTTPS only — no extra service).
//   dumpDatabase()  -> consistent snapshot (one REPEATABLE READ read-only transaction) of every data table as JSON
//   encryptBackup() -> gzip + AES-256-GCM (key = scrypt(BACKUP_PASSPHRASE || ENCRYPTION_KEY, random salt)); NOTHING readable leaves the server
//   sendToTelegram()-> sendDocument, split into <=19 MB parts (bots can DOWNLOAD only 20 MB files, so every part must stay loadable)
//   fetchLatestBackup() -> finds the newest backup (pinned channel message or the recorded file ids) and downloads it
//   restoreBackup() is also used by the admin "Load Backup" button
//   maybeBackup()   -> scheduled entry point; a database "claim" row makes it safe with several instances and frequent redeploys
//   restoreBackup() -> used by scripts/restore-backup.mjs and the tests
// Transient tables (sessions, rate limits, OTPs, OAuth states) are not backed up: restoring logs everyone out, which is the safe default.
import { gzipSync, gunzipSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { getSetting, setSetting, now } from '../lib/db.js';
import { fmtISTs } from '../lib/time.js';

export const MAGIC = Buffer.from('UXGB1');
export const EXCLUDED_TABLES = ['schema_migrations', 'sessions', 'rate_limits', 'email_otps', 'oauth_states'];
export const PART_BYTES = 19 * 1024 * 1024;   // Telegram: bots upload <=50 MB but download <=20 MB (getFile) — parts must be loadable again
const IDENT = /^[a-z_][a-z0-9_]*$/;

export const backupConfig = (env) => ({
  token: String(env.TELEGRAM_BOT_TOKEN || '').trim(),
  chatId: String(env.TELEGRAM_BACKUP_CHAT_ID || '').trim(),
  intervalSec: Math.max(1, Number(env.BACKUP_INTERVAL_HOURS) || 6) * 3600,
  pin: String(env.TELEGRAM_BACKUP_PIN || '1') !== '0',
  secret: String(env.BACKUP_PASSPHRASE || env.ENCRYPTION_KEY || ''),
});
export const backupConfigured = (env) => { const c = backupConfig(env); return !!(c.token && c.chatId && c.secret.length >= 16); };

/** Replaces the bot token anywhere it could appear (URLs in fetch errors) before an error is logged or stored. */
const scrub = (msg, env) => { const t = backupConfig(env).token; let s = String(msg || ''); if (t) s = s.split(t).join('<bot-token>'); return s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>'); };

// ---- snapshot ----
async function listTables(q) {
  const t = await q.query("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'");
  const names = t.rows.map((r) => r.n).filter((n) => IDENT.test(n) && !EXCLUDED_TABLES.includes(n));
  const fk = await q.query(`SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint
    JOIN pg_class AS child ON child.oid = pg_constraint.conrelid
    JOIN pg_class AS parent ON parent.oid = pg_constraint.confrelid
    JOIN pg_namespace AS schema_ns ON schema_ns.oid = pg_constraint.connamespace
    WHERE pg_constraint.contype = 'f' AND schema_ns.nspname = current_schema()`);
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const r of fk.rows) { const c = r.child; const p = r.parent; if (c !== p && deps.has(c) && deps.has(p)) deps.get(c).add(p); }
  const out = []; const done = new Set();   // parents first, so a restore never violates a foreign key
  while (out.length < names.length) {
    const next = names.filter((n) => !done.has(n) && [...deps.get(n)].every((p) => done.has(p))).sort();
    if (!next.length) { for (const n of names) if (!done.has(n)) { out.push(n); done.add(n); } break; }
    for (const n of next) { out.push(n); done.add(n); }
  }
  return out;
}

export async function dumpDatabase(env) {
  return env.DB.tx(async (t) => {
    await t.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const names = await listTables(t); const tables = [];
    for (const name of names) tables.push({ name, rows: (await t.query(`SELECT * FROM "${name}"`)).rows });
    const mig = await t.query('SELECT name FROM schema_migrations ORDER BY name');
    return { format: 1, createdAt: now(), migrations: mig.rows.map((r) => r.name), tables };
  });
}

// ---- encryption ----
export function encryptBackup(obj, secret) {
  if (!secret || secret.length < 16) throw new Error('backup passphrase must be at least 16 characters');
  const salt = randomBytes(16); const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(gzipSync(Buffer.from(JSON.stringify(obj)))), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}
export function decryptBackup(buf, secret) {
  if (buf.length < MAGIC.length + 44 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a backup file (or parts are missing/out of order)');
  const salt = buf.subarray(5, 21), iv = buf.subarray(21, 33), tag = buf.subarray(33, 49), body = buf.subarray(49);
  const d = createDecipheriv('aes-256-gcm', scryptSync(secret, salt, 32), iv); d.setAuthTag(tag);
  try { return JSON.parse(gunzipSync(Buffer.concat([d.update(body), d.final()])).toString('utf8')); }
  catch { throw new Error('could not decrypt: wrong passphrase/ENCRYPTION_KEY, or the file is damaged'); }
}

// ---- Telegram ----
async function tgCall(env, method, form, attempts = 3) {
  const { token } = backupConfig(env); let last = 'unknown error';
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) return j;
      last = `Telegram ${res.status}: ${j.description || 'request failed'}`;
      if (res.status === 429 && j.parameters && j.parameters.retry_after && j.parameters.retry_after <= 30) { await new Promise((r) => setTimeout(r, j.parameters.retry_after * 1000)); continue; }
      if (res.status >= 400 && res.status < 500) break;   // bad token / chat id / permissions: retrying will not help
    } catch (e) { last = 'network error: ' + e.message; }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error(scrub(last, env));
}
export async function sendToTelegram(env, buf, filename, caption, partBytes = PART_BYTES, collect = null) {
  const { chatId } = backupConfig(env); const n = Math.max(1, Math.ceil(buf.length / partBytes));
  for (let i = 0; i < n; i++) {
    const chunk = buf.subarray(i * partBytes, (i + 1) * partBytes);
    const name = n === 1 ? filename : `${filename}.part${String(i + 1).padStart(2, '0')}of${String(n).padStart(2, '0')}`;
    const form = new FormData();
    form.append('chat_id', chatId); form.append('disable_notification', 'true');
    form.append('caption', n === 1 ? caption : `${caption}\nPart ${i + 1}/${n}`);
    form.append('document', new Blob([chunk], { type: 'application/octet-stream' }), name);
    const r = await tgCall(env, 'sendDocument', form);
    const res = (r && r.result) || {}; const doc = res.document || {};
    if (collect) collect.push({ name, size: chunk.length, message_id: res.message_id, file_id: doc.file_id, date: res.date });
  }
  return n;
}

// ---- run ----
export const backupStatus = async (env) => { try { return JSON.parse(await getSetting(env, 'backup_status', '{}')) || {}; } catch { return {}; } };
export async function runBackup(env, { partBytes = PART_BYTES, safety = false } = {}) {
  const c = backupConfig(env);
  if (!backupConfigured(env)) throw new Error('Telegram backup is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_BACKUP_CHAT_ID and a 16+ character BACKUP_PASSPHRASE/ENCRYPTION_KEY are required).');
  // safety = the copy taken right before "Load Backup" replaces the data: it is sent to Telegram but is NEVER recorded/pinned as "the latest backup".
  try {
    const dump = await dumpDatabase(env);
    const rows = dump.tables.reduce((a, t) => a + t.rows.length, 0);
    const enc = encryptBackup(dump, c.secret);
    const stamp = new Date(dump.createdAt * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z|Z/, '').replace('T', '-');
    const sent = [];
    const parts = await sendToTelegram(env, enc, `${safety ? 'unknownxfam-safety' : 'unknownxfam-backup'}-${stamp}.uxgb`,
      `${safety ? 'PRE-RESTORE safety copy' : 'UnknownXfam Gateway backup'} (encrypted)\n${fmtISTs(dump.createdAt)}\n${dump.tables.length} tables, ${rows} rows`, partBytes, sent);
    const st = { at: now(), ok: true, bytes: enc.length, parts, rows, tables: dump.tables.length };
    if (safety) return st;
    // A single-file backup is pinned so a brand-new empty database can still find "the latest backup" in the channel. (Best effort: needs the bot's "Pin messages" right.)
    st.pinned = false;
    if (c.pin && parts === 1 && sent[0] && sent[0].message_id) {
      try { const f = new FormData(); f.append('chat_id', c.chatId); f.append('message_id', String(sent[0].message_id)); f.append('disable_notification', 'true'); await tgCall(env, 'pinChatMessage', f, 1); st.pinned = true; }
      catch (e) { console.error('backup pin failed (give the bot the "Pin messages" right in the channel):', scrub(e.message, env)); }
    }
    await setSetting(env, 'backup_latest', JSON.stringify({ at: st.at, createdAt: dump.createdAt, rows, tables: st.tables, bytes: st.bytes, parts: sent.map(({ name, size, message_id, file_id }) => ({ name, size, message_id, file_id })) }));
    await setSetting(env, 'backup_status', JSON.stringify(st)); return st;
  } catch (e) {
    const msg = scrub(e.message, env);
    if (!safety) await setSetting(env, 'backup_status', JSON.stringify({ at: now(), ok: false, error: msg })).catch(() => {});
    throw new Error(msg);
  }
}
export const latestBackupInfo = async (env) => { try { return JSON.parse(await getSetting(env, 'backup_latest', '')) || null; } catch { return null; } };

// ---- find + download the latest backup from Telegram ----
async function downloadFile(env, fileId) {
  const { token } = backupConfig(env);
  const f = new FormData(); f.append('file_id', fileId);
  const r = await tgCall(env, 'getFile', f, 2);
  const path = r.result && r.result.file_path; if (!path) throw new Error('Telegram did not return a download path (the file may be larger than the 20 MB bot download limit)');
  let res;
  try { res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`); } catch (e) { throw new Error(scrub('network error while downloading: ' + e.message, env)); }
  if (!res.ok) throw new Error(`Telegram download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
/** Newest backup wins: the pinned channel message (works on an empty database) vs the file ids this database recorded (also works for multi-part backups). */
export async function fetchLatestBackup(env) {
  const c = backupConfig(env);
  if (!backupConfigured(env)) throw new Error('Telegram backup is not configured.');
  const rec = await latestBackupInfo(env);
  const recFiles = rec && Array.isArray(rec.parts) && rec.parts.length && rec.parts.every((p) => p.file_id) ? rec.parts.map((p) => p.file_id) : null;
  let pin = null;
  try {
    const f = new FormData(); f.append('chat_id', c.chatId);
    const r = await tgCall(env, 'getChat', f, 2); const m = r.result && r.result.pinned_message; const d = m && m.document;
    if (d && d.file_id && /^unknownxfam-backup-.*\.uxgb$/.test(String(d.file_name || ''))) pin = { fileId: d.file_id, date: Number(m.date) || 0 };
  } catch (e) { if (!recFiles) throw e; }
  const useRecord = recFiles && (!pin || (rec.at || 0) >= pin.date - 5);   // the record is written right AFTER sending, so for the same backup it is >= the pin's date
  const ids = useRecord ? recFiles : pin ? [pin.fileId] : null;
  if (!ids) throw new Error('No backup found. Nothing is recorded in this database and no backup is pinned in the channel (the bot needs the "Pin messages" right). Download the .uxgb file(s) from Telegram and use scripts/restore-backup.mjs instead.');
  const bufs = []; for (const id of ids) bufs.push(await downloadFile(env, id));
  return { buf: Buffer.concat(bufs), parts: ids.length, source: useRecord ? 'recorded files' : 'pinned message' };
}

/** Scheduled entry point: runs at most once per interval across ALL instances/redeploys. On failure the claim is released so the next tick retries. */
export async function maybeBackup(env, nowSec = now()) {
  if (!backupConfigured(env)) return { skipped: 'not configured' };
  const { intervalSec } = backupConfig(env);
  const prev = await getSetting(env, 'backup_last', '');
  const claim = await env.DB.query(
    "INSERT INTO app_settings(k, v) VALUES ('backup_last', $1) ON CONFLICT (k) DO UPDATE SET v = excluded.v WHERE app_settings.v !~ '^[0-9]+$' OR app_settings.v::bigint <= $2 RETURNING v",
    [String(nowSec), nowSec - intervalSec]);
  if (claim.rowCount !== 1) return { skipped: 'not due yet' };
  try { return await runBackup(env); }
  catch (e) { await env.DB.query("UPDATE app_settings SET v = $1 WHERE k = 'backup_last' AND v = $2", [prev || '0', String(nowSec)]).catch(() => {}); throw e; }
}

// ---- restore ----
export async function restoreBackup(db, buf, secret, { replace = false } = {}) {
  const dump = decryptBackup(buf, secret);
  if (!dump || dump.format !== 1 || !Array.isArray(dump.tables)) throw new Error('unsupported backup format');
  return db.tx(async (t) => {
    const have = (await t.query("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")).rows.map((r) => r.n);
    const existing = (await t.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
    if (existing && !replace) throw new Error(`the target database already has ${existing} user(s); use --replace to overwrite it`);
    const targets = have.filter((n) => IDENT.test(n) && n !== 'schema_migrations');
    if (replace && targets.length) await t.exec('TRUNCATE ' + targets.map((n) => `"${n}"`).join(', ') + ' RESTART IDENTITY CASCADE');
    const counts = {};
    for (const tb of dump.tables) {
      if (!IDENT.test(tb.name) || !have.includes(tb.name) || EXCLUDED_TABLES.includes(tb.name)) throw new Error(`backup contains a table this database does not have: ${String(tb.name).slice(0, 40)} (run the same app version/migrations first)`);
      for (const row of tb.rows) {
        const cols = Object.keys(row); if (!cols.every((c) => IDENT.test(c))) throw new Error('backup contains an invalid column name');
        await t.query(`INSERT INTO "${tb.name}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, cols.map((c) => row[c]));
      }
      counts[tb.name] = tb.rows.length;
      const hasId = (await t.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'id'", [tb.name])).rowCount > 0;
      const seq = hasId ? await t.query('SELECT pg_get_serial_sequence($1, $2) AS s', [`"${tb.name}"`, 'id']) : { rows: [] };
      if (seq.rows[0] && seq.rows[0].s) await t.query(`SELECT setval($1, COALESCE((SELECT MAX(id) FROM "${tb.name}"), 1), (SELECT MAX(id) IS NOT NULL FROM "${tb.name}"))`, [seq.rows[0].s]);
    }
    return { createdAt: dump.createdAt, counts };
  });
}
