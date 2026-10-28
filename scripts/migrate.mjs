// `pnpm run db:migrate` — applies db/migrations/*.sql to the development DATABASE_URL.
import { createPgDriver } from '../src/db/pg.js';
import { migrate } from '../src/db/migrate.js';
const db = createPgDriver(process.env);
try { const done = await migrate(db, { log: console.log }); console.log(done.length ? 'applied: ' + done.join(', ') : 'database is up to date'); }
finally { await db.end(); }
