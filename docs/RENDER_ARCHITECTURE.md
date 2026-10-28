# Render architecture & migration notes

## How it runs
- **Runtime:** a Render *Web Service* (Node 22) started with `npm start` → `src/server.js`. It listens on
  `0.0.0.0:$PORT` (Render injects `PORT`), serves `public/*` from memory, and adapts Node's HTTP requests to the
  same Fetch-API pipeline (`src/app.js`) the Cloudflare Worker used — so every route, page, cookie and API response
  is unchanged.
- **Database:** Render PostgreSQL via `DATABASE_URL`. `src/lib/db.js` is still the only place that touches the DB;
  handlers keep using `first/all/run` with `?` placeholders, translated to `$1..$n`.
- **Migrations:** `db/migrations/*.sql`, applied at boot by `src/db/migrate.js` inside one transaction guarded by a
  Postgres advisory lock (safe with several instances), tracked in `schema_migrations`. `npm run db:migrate` runs them
  by hand. Add future changes as `0002_*.sql`, `0003_*.sql`, …
- **Cron → in-process timer:** the Cloudflare `*/5 * * * *` trigger became a 5-minute `setInterval` in `server.js`
  (expire orders, lift suspensions, purge sessions/OTPs/rate-limit rows). All jobs are idempotent.
- **Deferred work** (`ctx.defer`, formerly `waitUntil`) runs as tracked background promises; `SIGTERM` waits for them
  (max ~25 s), then closes the pool.
- **Health check:** `GET /health` → `{"status":"ok"}` after a `SELECT 1` (503 if the database is unreachable).

## What changed vs. the Cloudflare version
| Area | Before | Now |
|---|---|---|
| Entry point | `src/worker.js` (`fetch` + `scheduled`) | `src/server.js` (Node http) → `src/app.js` (`fetch`) |
| Database | D1 (`env.DB.prepare/batch`) | PostgreSQL (`pg` pool; real transactions for `batch()`) |
| Schema | `migrations/0001-0005` (SQLite) | `db/migrations/0001_initial.sql` (same tables/columns/constraints/indexes) |
| Static assets | inlined into `assets.generated.js` at build | read from `public/` at boot |
| Client IP | `CF-Connecting-IP` | see below |
| Config | `wrangler.toml` vars/secrets | Render environment variables (`render.yaml`, `.env.example`) |
| Deploy | `wrangler deploy` | Git push → Render build (`npm ci && npm run build`) → `npm start` |

Unchanged: UI, pages, authentication/sessions/CSRF, RBAC, audit log, payment logic, statuses, Gmail reconciliation,
webhook signing, API paths and JSON envelopes (including `Portal_Owner` / `Powered_By`), QR generation, rate-limit rules.

### PostgreSQL translation details
- `COLLATE NOCASE` (emails, UPI ID, order/payment ids) → `LOWER(x) = LOWER(?)` with matching expression indexes, so the
  case-insensitive uniqueness of email / UPI / Gmail address is preserved.
- Partial unique indexes (one open order per amount, unique `(user_id, txn_ref)`, unique API key/webhook hash) are kept.
- `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`; `LIKE` → `ILIKE` (SQLite's `LIKE` is case-insensitive); the dashboard
  totals query uses `COUNT(*) FILTER`. Timestamps/paise are `BIGINT` (returned as JS numbers).
- **One deliberate tightening:** linking a Gmail account used `INSERT OR REPLACE`, which in SQLite would also have deleted
  another user's row holding the same Gmail address. It is now an upsert on `user_id`, so a Gmail address already linked to
  a different user is rejected — which is what the existing "already connected to another user" message always intended.

### Client IP behind Render (rate limits, audit log)
Render sits behind a CDN edge and *appends* to `X-Forwarded-For` without clearing what the caller sent, so the left-most
entry can be forged. `clientIp()` therefore uses, in order: `CLIENT_IP_HEADER` (if you set it) → `CF-Connecting-IP` /
`True-Client-IP` (set by the edge, not the caller) → the entry `TRUSTED_PROXY_HOPS` from the right of `X-Forwarded-For`.
Verify on your service (e.g. check the IP recorded in Admin → Audit or a user's security events) and pin the header with
`CLIENT_IP_HEADER` if needed. If it came back `unknown`, all callers would share one rate-limit bucket.

## Files, QR codes and storage
The app writes **no files**. QR PNGs (`/temporary/qr/{order}.png`) are generated per request in memory from the order's
UPI link, and static assets are loaded into memory at boot. Nothing depends on the local disk, so restarts/redeploys lose
nothing. All persistent state (users, orders, sessions, settings, Gmail tokens) is in PostgreSQL. If you later add uploads,
use a Render Persistent Disk or object storage — do not rely on the ephemeral filesystem.

## Migrating existing data from Cloudflare D1
1. On the old setup: `npx wrangler d1 export unknownxfam-gateway --remote --no-schema --output=d1-data.sql`
2. Deploy the Render service once (creates the schema). Stop or ignore traffic until the import is done.
3. From your machine, with Render's **External Database URL**:
   ```bash
   DATABASE_URL="postgres://…" node scripts/import-d1-dump.mjs d1-data.sql --replace
   ```
   `--replace` empties the app tables first (the service already created the SUPER_ADMIN row). The import is a single
   transaction (all or nothing), keeps ids, and resets the identity sequences.
4. Use the **same `ENCRYPTION_KEY`** (and ideally `SESSION_SECRET`) as before — API keys, webhook secrets and Gmail tokens
   are sealed with the encryption key; without it they cannot be decrypted.
5. Update `APP_URL`, Google redirect URIs and any merchant integrations that still point at the old `workers.dev` URL.

## Limitations
Single-process background jobs (fine for one instance; safe but redundant on several). In-memory Gmail access-token
cache is per process. Not yet exercised on Render itself; see README → Remaining limitations.
