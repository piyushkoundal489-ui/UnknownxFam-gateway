// Sends one backup to Telegram right now (for testing the bot setup): DATABASE_URL, TELEGRAM_BOT_TOKEN,
// TELEGRAM_BACKUP_CHAT_ID and BACKUP_PASSPHRASE (or ENCRYPTION_KEY) must be set.   npm run backup
import { createPgDriver } from '../src/db/pg.js';
import { runBackup } from '../src/services/backup.js';
const db = createPgDriver(process.env);
try { const r = await runBackup({ ...process.env, DB: db }); console.log(`Backup sent: ${r.parts} file(s), ${r.bytes} bytes, ${r.rows} rows in ${r.tables} tables.`); }
catch (e) { console.error('Backup failed:', e.message); process.exitCode = 1; }
finally { await db.end(); }
