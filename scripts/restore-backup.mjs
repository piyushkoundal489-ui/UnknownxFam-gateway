// Restore an encrypted Telegram backup into PostgreSQL.
//   1) Download the .uxgb file (or ALL .partNNofMM files of one backup) from your Telegram channel.
//   2) DATABASE_URL=<postgres url> BACKUP_PASSPHRASE=<passphrase or ENCRYPTION_KEY> \
//        node scripts/restore-backup.mjs unknownxfam-backup-20261005-120000.uxgb [--replace]
// Several part files can be listed in order (shell globbing sorts them: *.part*). --replace empties the app tables first.
import { readFileSync } from 'node:fs';
import { createPgDriver } from '../src/db/pg.js';
import { migrate } from '../src/db/migrate.js';
import { restoreBackup } from '../src/services/backup.js';

const args = process.argv.slice(2); const replace = args.includes('--replace');
const files = args.filter((a) => !a.startsWith('--')).sort();
const secret = process.env.BACKUP_PASSPHRASE || process.env.ENCRYPTION_KEY || '';
if (!files.length || !secret) { console.error('usage: DATABASE_URL=… BACKUP_PASSPHRASE=… node scripts/restore-backup.mjs <file(s)> [--replace]'); process.exit(2); }
const db = createPgDriver(process.env);
try {
  await migrate(db);
  const r = await restoreBackup(db, Buffer.concat(files.map((f) => readFileSync(f))), secret, { replace });
  console.log('Restored backup from', new Date(r.createdAt * 1000).toISOString());
  for (const [t, n] of Object.entries(r.counts)) console.log(' ', t.padEnd(26), n);
  console.log('Everyone has to log in again (sessions are not backed up).');
} catch (e) { console.error('Restore failed, nothing was changed:', e.message); process.exit(1); }
finally { await db.end(); }
