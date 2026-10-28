# UnknownXfam Gateway

Direct-to-UPI payment gateway on **Node.js + PostgreSQL**. Users sign up (email/password or Gmail codes, no
Google login), the admin approves, users save a UPI ID and get API URLs. Each API call creates an order with a
real, dynamically generated UPI QR valid for 15 minutes, served both as a styled HTML pay page and as a genuine
`/temporary/qr/*.png` image endpoint. Full staff roles, account status system, audit log, Gmail/FamApp-style
payment reconciliation (with running-balance consistency checks and a MANUAL_REVIEW fallback), and a signed
provider-webhook API.

See **`docs/RENDER_ARCHITECTURE.md`** for how the app runs on Render (and exactly what changed from the Cloudflare
Workers + D1 version), and **`docs/API.md`** for full endpoint documentation with examples.

> **Payment status only ever moves to `PAID` inside `settleOrder()`** (`src/payments/core.js`), reachable only from:
> a signed provider webhook, a merchant-authenticated forwarder, a fully-verified Gmail/FamApp notification
> (sender + DKIM + amount + time window + an unambiguous, not-reused reference + a consistent running balance when
> known), or — SUPER_ADMIN only, with a mandatory reason, fully audited — manual confirmation. Evidence that partly
> matches but doesn't clear every check becomes `MANUAL_REVIEW`, never a guessed `PAID`. The full status set is
> `PENDING | PROCESSING | PAID | UNSUCCESSFUL | EXPIRED | CANCELLED | MANUAL_REVIEW`.

## Project structure
```
src/
  lib/        crypto, config, PostgreSQL access, HTML auto-escaping, HTTP/cookies, rate limiting
  db/         PostgreSQL driver (pg pool) + migration runner
  auth/       accounts, sessions/CSRF, sign-up email validation
  admin/      RBAC, audit log, admin actions (freeze/suspend/ban/API/roles/manual confirm)
  payments/   order lifecycle + settlement, public/merchant API handlers
  gmail/      Google OAuth, Gmail-based payment reconciliation
  services/   OTP codes, outbound mail (Gmail API)
  pages/      server-rendered HTML pages (login, dashboard, admin, pay page, …)
  server.js   Render entry point: Node HTTP server on 0.0.0.0:$PORT, boot-time migrations, maintenance timer
  app.js      request pipeline (Fetch API Request -> Response): routes, cookies, flash, security headers
  router.js   tiny path router
public/       static landing page + assets (logo, QR renderer, CSS/JS) — served from memory by src/static.js
db/migrations/ PostgreSQL schema (0001 = the complete final schema, incl. the expanded status enum, split
              UTR/transaction-id fields and the payments/gmail_payment_messages/payment_matches/payment_audit_logs tables)
scripts/      build check, manual migration, one-time D1 -> Postgres data import
render.yaml   Render Blueprint (web service; bring your own PostgreSQL, e.g. Aiven or Neon)
docs/         API reference, Render architecture & migration notes
```

## Local development
Needs Node 20+ and a PostgreSQL database (e.g. `docker run -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16`).
```bash
npm install
cp .env.example .env           # fill in real values; .env is gitignored. (Load it with: node --env-file=.env src/server.js)
# minimum for local http: APP_ENV=development APP_URL=http://localhost:10000 DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres
npm run dev                    # starts the server (auto-restarts on change); migrations run automatically at boot
npm run db:migrate             # optional: apply migrations without starting the server
```

## Replit private test instance
The Replit preview runs the same Node server and uses the project's development PostgreSQL database. `APP_ENV=development` is scoped to the development environment; if `ENCRYPTION_KEY` is absent, only this development mode derives one from `SESSION_SECRET`. Production still requires an independent `ENCRYPTION_KEY`.

OTP delivery is not connected in this test instance. This source currently sends OTPs through the admin's Gmail OAuth connection; it does not include an AgentMail transport. Do not enable email-code requirements until a mail sender is configured and tested.

## Deploying to Render from GitHub
1. **Push this project to GitHub** (`git add -A && git commit -m "Render deployment" && git push`).
2. **Blueprint deploy (recommended):** Render Dashboard → **New → Blueprint** → pick the repo. `render.yaml` creates
   the Web Service (`npm ci && npm run build` → `npm start`, health check `/health`). Create the PostgreSQL database
   yourself (Aiven, Neon or Render Postgres) and set `DATABASE_URL` in the dashboard (plus `DATABASE_CA` for Aiven, see
   below). *Manual alternative:* create the Web Service by hand (Runtime Node, Build `npm ci && npm run build`, Start
   `npm start`, Health Check Path `/health`). Production never creates tables by itself: run
   `DATABASE_URL=… npm run db:migrate` (or restore a backup) on a new database before the first start.
3. **Fill in the environment variables** Render asks for (see the table below; never commit them):
   `APP_URL` (your `https://<service>.onrender.com` or custom domain), `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
   `ENCRYPTION_KEY`, `WEBHOOK_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. `SESSION_SECRET` is generated for
   you. Generate random values with `openssl rand -base64 32`. `NODE_ENV`/`APP_ENV` are `production`.
4. **First boot** applies `db/migrations/*.sql` automatically (advisory-locked, exactly once) and creates the
   SUPER_ADMIN row for `ADMIN_EMAIL`. No console access to the database is needed.
5. **Google OAuth** (Google Cloud Console → Google Auth Platform): keep the existing OAuth client ID/secret and scopes.
   Its web client must include `https://YOUR-APP-URL/gmail-callback` (user Gmail reconciliation) and
   `https://YOUR-APP-URL/admin/mail-callback` (admin sender Gmail) as **Authorized redirect URIs**; keep the app origin
   in **Authorized JavaScript origins** if it is already configured. Remove only obsolete `*.workers.dev` entries.
   Enable the **Gmail API**. For public access, set the audience to **External**, move Publishing status to **In production**,
   and submit the app/scopes through Google's verification flow; do not use a test-user or unverified-app workaround.
   Use `unknownxfam-gateway.onrender.com` as the requested authorized domain only if Google accepts and verifies it.
   Google requires ownership verification for domains used by the OAuth home page, privacy-policy URL, origins, and
   redirect URIs. Because `onrender.com` is a shared hosting domain, Google may require a custom domain you control
   before approving the public app. If so, add that domain in Render and change `APP_URL` and the OAuth URLs together;
   do not change the client credentials or requested Gmail scopes to evade verification.
   The user reconciliation flow requests restricted `gmail.readonly`; the admin sender requests sensitive `gmail.send`.
   Google may require an independent security assessment for restricted-scope server use. Provide a public home page,
   privacy policy, and the scope-by-scope justification/video requested in the Verification Center.
6. **Custom domain (optional):** Service → Settings → Custom Domains, then update `APP_URL` and the Google redirect URIs.
7. **Updating:** `git push` — Render rebuilds and redeploys. New migration files in `db/migrations/` are applied on
   the next boot. **Logs:** the service's Logs tab.
8. **Existing data from Cloudflare D1?** See *Migrating existing data* in `docs/RENDER_ARCHITECTURE.md`
   (`scripts/import-d1-dump.mjs`). Reuse the same `ENCRYPTION_KEY` — API keys, webhook secrets and Gmail tokens are sealed with it.

## Environment variables
| Variable | Secret? | Meaning |
|---|---|---|
| `NODE_ENV` | no | `production` on Render (set by `render.yaml`) |
| `DATABASE_URL` | **yes** | PostgreSQL connection string (Render: use the database's *Internal Database URL* from the web service). Render's internal URL uses its private network; external Render URLs require TLS. Do not disable SSL in production to silence warnings. |
| `PORT` | no | Injected by Render; the server listens on `0.0.0.0:$PORT` (never hardcoded) |
| `APP_ENV` | no | `production` (default) or `development`. Dev allows a fallback if `ADMIN_PASSWORD` is unset and permits manual payment confirmation without the production flag. |
| `APP_URL` | no | Public URL of the service, e.g. `https://unknownxfam-gateway.onrender.com` — used for OAuth redirects, Origin/CSRF checks, emails and API links. Falls back to Render's `RENDER_EXTERNAL_URL` if unset. Never hardcoded. |
| `ADMIN_EMAIL` | no | The one SUPER_ADMIN account's email. Pure config — set it in the Render environment; nothing in the code hardcodes it. On the next request, `ensureSuperAdmin()` promotes that address to SUPER_ADMIN (creating the account if needed) and demotes any previous SUPER_ADMIN to ADMIN. |
| `ADMIN_PASSWORD` | **yes** | Admin login password — a Render environment secret only, never committed. There is no built-in fallback in production: admin login is refused outright while it's unset, rather than silently accepting a default password. |
| `SESSION_SECRET` | **yes** | 32+ random chars — signs session ids and CSRF tokens |
| `ENCRYPTION_KEY` | **yes** | 32+ random chars — AES-256-GCM key for API keys, webhook secrets, OAuth refresh tokens |
| `WEBHOOK_SECRET` | **yes** | Shared HMAC secret for the signed provider webhook |
| `TELEGRAM_WEBHOOK_SECRET` | **yes** | 32+ character secret shared with the existing Telegram update handler when it forwards messages to this app |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | id no / secret yes | Gmail reconciliation (user) + sender Gmail (admin). No Google *login* is offered — this is Gmail-connect only. |
| `GMAIL_ALLOWED_SENDERS` | no | Comma list of bank/FamApp alert senders/domains for Gmail payment reconciliation |
| `GMAIL_PROVIDER_MAP` | no | `domain:Label,domain:Label` — e.g. `famapp.in:FamApp,axisbank.com:Axis Bank`. Falls back to a capitalized domain guess when a sender isn't listed. |
| `GMAIL_REQUIRE_DKIM`, `GMAIL_REQUIRE_REFERENCE` | no | Keep `1` |
| `ALLOWED_EMAIL_DOMAINS`, `BLOCKED_EMAIL_DOMAINS`, `EMAIL_DNS_CHECK` | no | Sign-up email checks |
| `PBKDF2_ITERATIONS` | no | Password hashing cost; capped at 100000 (existing hashes stay valid) |
| `CLIENT_IP_HEADER`, `TRUSTED_PROXY_HOPS` | no | How the caller IP is derived behind Render's proxy (see `docs/RENDER_ARCHITECTURE.md`) |
| `DATABASE_CA` | no (public cert) | **Aiven:** the whole "CA certificate" text from the Aiven service page (BEGIN/END lines included; plain, single-line with `\n`, or base64). The server certificate is then verified against it (hostname check stays on). Leave unset for Neon/Render. An invalid value stops the app at startup |
| `DATABASE_SSL`, `PG_POOL_MAX`, `UPI_NAME` | no | Optional DB TLS override, pool size, default payee name |

## Admin: roles, account status, audit
- **Roles** (`src/admin/rbac.js`): `SUPER_ADMIN` (one account — `ADMIN_EMAIL`; payment overrides, role management,
  platform settings) > `ADMIN` (user management, freeze/suspend/ban, API management, audit log) > `SUPPORT`
  (view-only + resend verification) > `USER`. Every permission check runs server-side in `authorize()` — the UI
  hides buttons the caller can't use, but that's a courtesy, not the control.
- **Account status**: `active | frozen | suspended | banned`. Suspension carries an expiry and lifts itself (checked
  on every request, and swept every 5 minutes by the in-process maintenance job). A freeze preserves the website
  session but blocks merchant API/webhook access; suspension and ban force-logout by bumping `session_version`, so
  open sessions are rejected on the next request — not just new logins.
- **Audit log** (`audit_log` table): every admin action, with admin id, target, reason, IP, timestamp, and
  redacted metadata (`src/admin/audit.js` strips anything that looks like a password/secret/token/key before
  writing). Per-user API activity and security events (`api_activity`, `security_events`) are also visible on each
  user's admin detail page.
- **Payments admin**: search by order/payment/UTR/merchant/amount, filter by status, see the full event timeline
  per order. Manual confirmation is restricted to SUPER_ADMIN, requires a typed reason, and is audited.
- **Gmail checks**: ADMIN and SUPER_ADMIN can review structured Gmail alert results, including ignored and
  `MANUAL_REVIEW` reasons. Message bodies are never stored.

## Security notes
- Passwords: PBKDF2-SHA256, 100k iterations, unique salt; a fixed dummy hash is checked on unknown-email login so
  timing doesn't reveal whether an account exists.
- Sessions: opaque cookie token, server-side session row in PostgreSQL, `HttpOnly; Secure; SameSite=Lax`; force-logout is
  immediate (not just cookie deletion). A frozen user keeps their website session but is blocked from merchant API and
  webhook access; suspension and ban invalidate sessions immediately.
- Password recovery: normal reset uses sender Gmail. An authorized admin can issue a one-time, 10-minute reset code
  shown once in the audit-protected admin response; the user completes it at `/reset-password?email=...`.
- CSRF: signed double-submit cookie + Origin/Sec-Fetch-Site check on every state-changing request.
- All SQL is parameterized (`?` binds) — no string-built queries anywhere.
- All page output goes through the auto-escaping `html` template tag (`src/lib/html.js`); raw HTML requires an
  explicit `raw()` call, making stored/reflected XSS structurally hard to introduce by accident.
- IDOR: every merchant-facing lookup is scoped by `user_id` in the SQL itself (`findUserOrder`), not filtered
  after the fact — another merchant's order id resolves to `NOT_FOUND`.
- Payment idempotency/races: `settleOrder()` is a single conditional `UPDATE ... WHERE status IN ('PENDING','PROCESSING')`;
  PostgreSQL's unique (partial) index on open-order amount and on `(user_id, txn_ref)` makes double-processing and amount-collision
  races fail at the database layer, not just in application logic (five concurrent
  settlement attempts on one order → exactly one succeeds).
- Webhook: HMAC-SHA256 over `"<timestamp>.<raw body>"`, 5-minute replay window, idempotent per `event_id`.
- Rate limiting: PostgreSQL-backed fixed-window limits (shared by all instances) on login, registration, OTP
  send/verify, password reset, OAuth callbacks, API auth, order creation, webhooks, and admin actions
  (`src/lib/ratelimit.js`). For high-volume abuse, also put an edge/CDN rate-limit layer (e.g. Cloudflare in front of
  a custom domain) in front of Render — the in-app limiter still does one database write per request.
- Secrets at rest: API keys and webhook secrets are stored as a SHA-256 hash (for lookup) plus an AES-256-GCM
  sealed copy (so the *owner* can view their own key again) — admins see only whether a key exists, never any part
  of it, anywhere in the admin UI or audit log. (7-digit keys are short enough that even a masked prefix would
  meaningfully shrink the guessing space, so the admin view shows no digits at all — see the trade-off note below.)
- **API key format:** every randomly generated key is 7-digit numeric: personal keys generated in Settings,
  personal keys issued by an admin (`issueApiKey()`), and admin-managed shared keys. Personal keys may instead be
  explicitly set to a custom value. There is one active personal key per user, looked up by hash so the raw key is
  never queryable from the database. This is a
  deliberately small default keyspace (10,000,000 values) — mitigated with per-IP failed-auth rate limiting
  (`api_bad_auth_ip`) and mandatory UPI-ID pairing, but real money handling at scale should add edge rate-limiting
  rules on top; this trade-off is documented, not hidden (see `docs/API.md`).
- **Admin "Create / replace API key" tool** (each user's admin detail page): lets an admin set, for any approved
  user, either a random 7-digit key (default) or a **custom value** (4-40 letters/digits/`_`/`-`, must be unique —
  a collision is rejected, never silently overwritten), with either **no expiry ("infinite")** or a **custom
  duration** (minutes/hours/days). Whatever is set replaces the user's existing key immediately and is what then
  appears in that user's own Settings page. An expired key is refused on the public API with a distinct "This API
  key has expired" message (`merchantByKey()` in `src/payments/core.js`) rather than a generic invalid-key error.
  The raw key value is shown once to the admin who creates it and is never written to the audit log — only that a
  key was (re)created, whether it was custom, and its expiry.
- **Issued keys card** (same admin user page): shows the API key an admin issued to the user and the shared key the user saved in Settings, with type, issue date, expiry and status (active / expired / revoked). Key values are visible to the SUPER_ADMIN only; ADMIN sees status without values; SUPPORT does not see the card.
- **Dashboard → Overview, 4th stat card "Key expiry":** date and time the admin-issued API key and, if saved, the shared key stop working (red when expired or revoked).
- **QR delivery:** `/temporary/qr/{order}.png` is a genuine, hand-encoded PNG (`src/lib/png.js` + the vendored MIT
  QR encoder in `src/lib/qr-encode.js`) built fresh from the order's real UPI link at error-correction level H — not
  a static image, not an HTML page pretending to be one. It 404s/410s (still as a real PNG) once the order is no
  longer open, so an old QR can never be rescanned into a new payment.

## Gmail / Google OAuth
No page in this app ever asks for a Google password, OTP, 2-step code, or phone number-match — that happens only
on Google's own consent screen (official authorization-code + PKCE flow, `src/gmail/google.js`). Two independent
connections exist:
- **User Gmail reconciliation** (`/gmail-connect`): read-only (`gmail.readonly`), used only to detect the user's
  *own* bank credit alerts for their *own* pending orders — sender allow-list, Gmail's DKIM verdict, amount, time
  window and a reference must all match before an order is settled (`src/gmail/reconcile.js`). Only the verdict,
  amount and sender domain are ever stored — never the email body.
- **Admin sender Gmail** (`/admin/mail-connect`): `gmail.send` only (optionally `gmail.readonly` for the inbox
  view), used to send OTP emails. Refresh tokens for both are AES-256-GCM sealed with `ENCRYPTION_KEY` before
  being written to the database.

**Public OAuth publication:** the code keeps the Gmail routes, redirect paths, client configuration, and scopes intact;
Google Cloud consent-screen status and verification are account-level settings and cannot be changed from this source
archive. `gmail.readonly` is a restricted Gmail scope and `gmail.send` is sensitive. For public release, verify the
brand/domain, publish an External audience, submit every scope for Google's review, and complete any required security
assessment. Google requires ownership verification of domains used by the home page and OAuth URLs; the requested
`unknownxfam-gateway.onrender.com` host may not qualify because it is a shared Render domain. If rejected, use a custom
domain you control. Do not bypass review by leaving the app in Testing or using an unverified-app exception.
See Google's [Gmail scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes),
[OAuth policy compliance](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance),
and [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

**Forgot password:** `/forgot-password` → `/reset-password` (`src/pages/auth.js`). A logged-out user enters their
email; if the sender Gmail is connected, a 6-digit code is sent through it (`otpIssue()`, purpose `reset`) and
entering it sets a new password, force-logs-out every other session for that account, and is rate-limited the same
as any other OTP (60s between sends, 5 wrong tries, 5/hour per address). The confirmation page always says "if the
account exists" regardless of whether it does, so the flow can't be used to enumerate registered emails. If no
sender Gmail is connected yet, the page says so plainly rather than pretending to send anything. A real deploy needs its own sender
Gmail connected (Admin → Support email & codes) before this works for real users.

`src/server.js` + the `pg` driver were additionally smoke-tested against a real PostgreSQL 16 server (migrations twice,
login/admin pages, order creation, QR PNG, graceful SIGTERM). Not run against Render itself.

## Theme & branding
The top bar has a moon/sun button: on = dark theme, off = normal theme (remembered per browser in `localStorage`; logic in `public/assets/theme.js`, colours in `public/assets/theme.css`). The logo/name links to `/`. Every page footer shows **Support - @UnknownNvrDie** linking to Telegram and a small **Follow Us** link to Instagram.

## Telegram backup (optional)
A bot built into the server sends an **encrypted** copy of the whole database to a private Telegram channel (default **every 6 h**, set with `BACKUP_INTERVAL_HOURS`; admin → **Backup** tab has a *Send Backup now* button and a *Load Backup* button). Files are gzip + AES-256-GCM encrypted before they leave the server; sessions, rate limits and OTPs are not included.
**Set up:** (1) chat with @BotFather → `/newbot` → copy the token → `TELEGRAM_BOT_TOKEN`. (2) Create a **private channel**, add the bot as an **administrator** (can post). (3) Post any message in the channel, open `https://api.telegram.org/bot<TOKEN>/getUpdates`, and copy `chat.id` (starts with `-100`) → `TELEGRAM_BACKUP_CHAT_ID`. (4) Set `BACKUP_PASSPHRASE` (16+ chars) and **store a copy outside Render**; without the passphrase (or `ENCRYPTION_KEY` if you left it unset) a backup cannot be opened. Files over 19 MB are split into numbered parts (Telegram lets bots download only 20 MB files, so each part must stay loadable).

**Load Backup (restore from Telegram):** admin (SUPER_ADMIN) → **Backup** → *Load Backup* downloads the newest backup from the channel, decrypts it, sends a PRE-RESTORE safety copy of the current data to Telegram, then **replaces all current data** with the backup and logs everyone out. You must type `RESTORE` to confirm. The newest backup is found from the pinned message in the channel (each single-file backup is pinned; the bot needs the *Pin messages* admin right; `TELEGRAM_BACKUP_PIN=0` turns pinning off) or from the file ids this database recorded, whichever is newer — so it also works on a brand-new empty database (log in as the owner first). Backups split into several parts are found from the recorded ids only. Every attempt is audited (`BACKUP_LOADED` / `BACKUP_LOAD_FAILED`).

**Welcome replies without replacing the current handler:** `POST /telegram/welcome-forward` accepts a Telegram Update
as JSON when it has the `X-Telegram-Bot-Api-Secret-Token` header matching `TELEGRAM_WEBHOOK_SECRET` (32+ characters).
The existing update handler must forward each incoming `message` update to
`https://unknownxfam-gateway.onrender.com/telegram/welcome-forward`; this app then sends the welcome reply using
`TELEGRAM_BOT_TOKEN`. Configure the same secret on both services. On startup the app now calls Telegram `setWebhook` itself (url `/telegram/welcome-forward`, with `TELEGRAM_WEBHOOK_SECRET`
as the secret token), so `/start` gets a reply with no extra setup. Set `TELEGRAM_AUTO_WEBHOOK=0` to skip this if another
service already owns the bot's webhook; then that service must forward updates here instead.
The secret must be 32+ characters using only letters, digits, `_` and `-`.
**Restore:** download the file(s) from the channel, then
`DATABASE_URL=<new postgres url> BACKUP_PASSPHRASE=<passphrase> node scripts/restore-backup.mjs <file(s)> --replace` (use `npm run db:restore -- <files> --replace`). Everyone has to log in again. `npm run backup` sends one backup immediately.

## Payment e-mail reading, results and the keyed lookup
- **What is read:** only the **newest unseen e-mails in the INBOX** from the allow-listed alert sender (`GMAIL_ALLOWED_SENDERS`, FamApp by default) that say *received* (or *credited* for bank alerts). Everything else (offers, "You have successfully **paid**" debit mails…) is looked at once and ignored. The live inbox listing is used instead of Gmail search, because search can show a brand-new e-mail 10–60 s late — that delay is why payments used to take 30–40 s.
- **FamApp layouts:** FamApp→FamApp transfers show a *Transaction ID* only; transfers from other UPI apps also show a **UTR** on its own line (`UTR :` / 12 digits). Transaction IDs may contain hyphens (`FMPU0la100c3-f0fb-…`) and are read in full.
- **API results show ✅ / ❌:** every status response now also has `status_display` (`Payment Received ✅`, `Failed ❌`, `Expired ❌`, `Cancelled ❌`, `Not found ❌`, `Pending ⏳`…), `successful` (`true ✅` / `false ❌`), a `message` (`You have successfully received ₹25.00 from Sahil Singh`) and `date` (`01:26 PM IST, 03 October 2026`, the style of FamApp's *Date* line). The machine fields `success` (boolean) and `status` (`PAID`, …) are unchanged, so existing integrations keep working.
- **Keyed lookup without a UPI id:** `GET /gateway-api/check_payment.php?id={UTR or transaction id}&key={any valid key}` (also under `/api/`). Any valid assigned key or shared key plus a payment's UTR / transaction ID returns that payment's details; it never reveals order ids or a merchant's balance. See `docs/API.md`.
- **Admin → user profile:** a **FamPay balance** card (the latest "Updated Balance", with its IST time), a **Successful payments** card (count + total) and a **Payment history** table — successful payments only (matched to an order, or money received with no order), each with UTR, transaction ID, amount, payer and status. The admin **Users** list has a *Payments → History* link for every approved user.
- **Live inbox (dashboard → Gmail → Inbox):** the page refreshes itself every 5 s while it is open (new e-mails appear on top, payment e-mails are highlighted ✅, the balance updates, older pages stay static). Each refresh also verifies new payment e-mails on the spot — open orders settle and the balance refreshes without waiting for the background round (`/gmail-inbox/live`, JSON, own mailbox only).

## FamPay balance, broken links and reference lookups
- **Balance auto-fill:** when a user connects Gmail, **only the latest** FamApp "received" alert is read (no history) and its **"Updated Balance"** becomes the user's *FamPay balance* (dashboard card, Settings → Profile, and the admin's user profile page, with its IST time). Afterwards every new alert refreshes it every `GMAIL_POLL_SECONDS` (5 s) — also for merchants **without** an open order (`GMAIL_IDLE_POLL=0` turns that part off). Only trusted alerts (allow-listed sender + DKIM) count, and the balance only ever moves forward.
- **Balance check on orders:** the running-balance check now follows real time (alerts are processed oldest first and an unrelated credit moves the balance forward), so money that arrives outside an order no longer causes a false MANUAL_REVIEW.
- **Broken links:** an unknown page address redirects (302) straight to the home page. `/api`, `/gateway-api`, `/assets`, `/temporary`, files with other extensions and non-GET requests keep a real 404.
- **UTR / transaction-id lookup:** `check_payment` also finds payments by either reference straight from the alert e-mails (see `docs/API.md`).

## Monitoring, alerts and login lockout

- **Alerts when payment checking stops** (`src/services/monitor.js`): if Gmail checks keep failing for a minute (network error, timeout, rate limit, Google 5xx, database error) or the check loop stalls, the owner gets a formatted **Telegram** message (bot → `ALERT_TELEGRAM_CHAT_ID`, default `7642584056`) **and an e-mail** to `ADMIN_EMAIL`. A reminder follows every 30 minutes while it is down, and one message when it works again. A merchant whose Gmail access ended (they must reconnect) is reported once per 6 hours. A short "Gateway started" Telegram message is sent after every restart (`ALERT_STARTUP=0` turns that off). Open the bot in Telegram and press **Start** once, otherwise Telegram refuses to deliver (the log then says so). The e-mail is sent through Admin → Support email.
- **Uptime monitor on `/health`:** `/health` returns `{"status":"ok","database":"Running correctly","payment_checking":"ok"}` (`database` is the PostgreSQL server: `Running correctly`, `Running slowly` when it needed 2 s or more to answer, or `Not responding` with HTTP 503 — the only case that returns 503; `payment_checking` is `ok`, `degraded`, `stalled` or `off`). It stays 200 when Gmail is failing so Render never restarts the app because of Gmail. An alert sent *from inside* the app cannot report that the app itself is down, so add a free external monitor (e.g. UptimeRobot → *Add New Monitor* → type **Keyword**, URL `https://<your-site>/health`, keyword `"payment_checking":"ok"` (or `"database":"Running correctly"` to watch the database), interval 5 min, alert contact: Telegram and/or e-mail). It then alerts when the site is down **or** payment checking is not ok.
- **Login lockout:** 5 wrong passwords in a row for an account (counted per e-mail address, whether or not it exists) lock **password** login for that account for **6 hours**; even the correct password is refused until then. A correct password before the 5th mistake resets the counter. "Forgot password" and "Email me a login code" keep working. The counters live in `rate_limits` (swept automatically, not part of backups). Constants: `LOGIN_LOCK` in `src/lib/ratelimit.js`.

## Fast payment detection
The server checks Gmail **every `GMAIL_POLL_SECONDS` (default 2, minimum 1)** for every merchant that has an open order, so a FamApp credit email settles the order within seconds even when the customer left the pay page (switching to the UPI app pauses the page's own polling). Merchants with no open order cost no Gmail calls; each account is also throttled (8 s) and every email is claimed once, so nothing is settled twice. Works for any account with Gmail connected, the owner's included. Needs an always-on Render plan (a sleeping free service cannot poll). `GMAIL_POLL_SECONDS=0` turns the fast poller off (the pay page and the 5-minute sweep still check).

## API key expiry reminders & renewal
- **Reminders:** for every user whose API key has an expiry, the server e-mails them **once a day from 3 days before it expires until it expires**, then sends **one "expired" notice** (keys that lapsed more than 7 days ago are skipped). The mail never contains the key and points to support (`@UnknownNvrDie`). It is sent from the connected sender Gmail (Admin → Support email); nothing is sent (and nothing is marked as sent) while that is not connected, and a failed send is retried on the next 5-minute run. Users who are unverified, banned/suspended/frozen, or have API access disabled are skipped.
- **Renew:** Admin → Users → the user → **Renew API key**. It extends the expiry by N days (from the current expiry, or from now if it already expired) or sets *never expires*, **keeps the same key value** (nothing changes in the user's integration), revives an expired key, e-mails the user and restarts the reminders. Works for the owner on their own account. Audited as `API_KEY_RENEWED`.
- **Not covered:** shared keys (they are managed on Admin → Shared keys with their own expiry).

## Google Search Console
- The verification file `public/google67c53875e4a6b009.html` is served at `/google67c53875e4a6b009.html` (200, unchanged, no login). Add your site as a **URL-prefix** property using your exact public address (e.g. `https://unknownxfam-gateway.onrender.com/`) and choose the *HTML file* method. (A **Domain** property can only be verified with a DNS TXT record, not an HTML file.) Verify at the same host you used: `www` vs non-`www` and `http` vs `https` are different properties.
- `/robots.txt` and `/sitemap.xml` are generated from `APP_URL` (so they follow a custom domain). robots.txt blocks the private areas (admin, dashboard, settings, APIs, pay pages) and announces the sitemap; in Search Console go to **Sitemaps** and submit `sitemap.xml`.
- The landing page's canonical, Open Graph and JSON-LD URLs are rewritten to your `APP_URL`/host at request time, and `og:image` points at the existing logo.
- Do not delete the verification file afterwards — Google re-checks it.

## Time zone
Every time people see (admin and user pages, audit log, backups captions, key-expiry and renewal e-mails) is in **IST (UTC+05:30)**, formatted like `7:54 am 10-10-2026` (time first, 12-hour am/pm, then DD-MM-YYYY), by `src/lib/time.js`. Stored values stay UTC unix seconds and **API/JSON timestamps stay ISO UTC (`...Z`)** so integrations are unaffected.

## API keys
API keys are **never created automatically** — not on sign-up, not on approval, not for the admin account. Only an
Admin/Owner can issue, replace, or revoke a personal key from the user's Admin page; the issued value is shown once
to that admin. A normal user can enter and save only the key already assigned to their own account. Admin-managed
shared keys are also random 7-digit values and can be added by approved users in Settings.

## Remaining limitations
- **Not deployed on Render by the author of this conversion** — do a first deploy to a staging service and click
  through sign-up, admin login, an API order and the pay page before pointing real traffic at it.
- **Google OAuth is not end-to-end tested** (needs live network + real Google credentials). The scope-filtering,
  PKCE, state, and token-encryption logic is unit-tested; the actual redirect/consent/callback round trip and Google
  verification status are not.
- **Gmail API mail sending is not live-tested** for the same reason — code paths are unit-tested with a mocked
  `fetch`, not exercised against real Gmail.
- **Background work runs inside the web process** (order expiry / session sweeps and Gmail reconciliation every
  5 minutes, with an additional throttled check when a merchant status/check-payment request arrives). Use an
  always-on Render plan: a free web service sleeps and pauses it.
- **Local disk is ephemeral on Render.** The app writes no files (QR PNGs are generated per request in memory, static
  assets are read at boot), so nothing needs a persistent disk.


## Gmail-only accounts, user notices, pending badge
- **Gmail only:** sign-up and login accept `@gmail.com` addresses only (the owner / SUPER_ADMIN account is exempt so it can never be locked out).
- **Notices:** when an admin or owner acts on a user account (approve, reject, freeze, unfreeze, suspend, ban, force logout, API access / key changes, password reset, role change, manual payment confirmation, delete) the user gets an email with the action, the reason and the time, sent from the support Gmail (Admin → Support email). Nothing is sent if no sender Gmail is connected; the action still applies.
- **Pending badge:** the admin "Pending approvals" tab shows the number of account requests waiting for approval.

## E-mail look
Every e-mail starts with the gateway logo, embedded in the message (`public/assets/logo-email.png`, sent as an inline CID image so it shows without "load images" prompts). The OTP code mails keep their own layout (only the logo was added on top). All other mails (test e-mail, account notices such as approved / rejected / frozen, API-key renewal and expiry reminders) use the shared layout in `src/services/email-templates.js`: emoji heading, details box, button, support footer, plus a plain-text twin for apps that need it.

## Key e-mails and the Shared keys tab
- When the owner / an admin issues a personal API key (Create key or Reissue on the user's admin page) the user is e-mailed the key itself, with its expiry date, their UPI ID and the owner's note. The key value is never written to the audit log. Renewals send their own "renewed" e-mail (key unchanged).
- Admin → Shared keys now has two sections: **Active keys** and **Expired keys** (an expired key cannot be shown and has a "Remove from list" button; revoked keys stay hidden).

## Code e-mails and Pending approvals
- Each code e-mail has its own wording: **sign-up** ("Verification Code"), **login** ("Login Code") and **password reset** ("Password Reset Code"). Text customised under Admin → Support email applies to sign-up and login codes; reset codes always use the reset wording.
- With "Email code at sign-up" switched on, **Pending approvals** (list and red badge) shows only accounts that already verified their email; the others wait under Users (a banner shows how many) and appear as soon as they enter their code.
- The logo is a small inline image at the start of the first line of every e-mail.

## Auto Approve
Admin → Pending approvals has an **Auto Approve** switch (green ON / red OFF; needs the `users.approve` permission).
- **ON:** every request already waiting is approved at once, and every new sign-up is approved automatically (each user gets the approval e-mail; waiting ones are e-mailed one by one so Gmail's sending limit is never hit). With "Email code at sign-up" on, an account is approved the moment its email is verified.
- **OFF:** manual approval again, exactly as before.
Turning it on/off and every automatic approval are written to the audit log (`AUTO_APPROVE_ON` / `AUTO_APPROVE_OFF` / `USER_APPROVED` with `auto: true`).

## `searched_utr` in the UTR APIs
Both UTR verification APIs (personal `/gateway-api/{upi}/check_payment.php` and universal `/gateway-api/check_payment.php`) put `details.searched_utr` first: the UTR / transaction ID that was searched (also on not-found and error responses; `null` when no id was sent).

## Announcements (admin tab)
Admin → Announcements (ADMIN and SUPER_ADMIN): type a message, choose **a particular user** (enter their email) or **all users** (every approved, non-banned account), press *Review & send*, then confirm on the confirmation page. Each email starts with the gateway logo and name centred on the first line and the message follows exactly as typed (line breaks, spaces, emojis, links; HTML is shown as plain text). Broadcasts are sent one email at a time (Gmail's sending limit), progress is shown under *Recent announcements*, a broadcast that keeps failing stops after 5 failures in a row with a **Retry** button, and an interrupted one resumes automatically. Needs the support sender Gmail (Admin → Support email). Sending is recorded in the audit log (`ANNOUNCEMENT_SENT`, no message text).

## Approval history, Auto Approve row, shared-keys table
- **Pending approvals** has a `⏳ Pending | 🗂️ History` switch. *History* lists every approval and rejection (email, status dot, who/Auto Approve, date, reason), with All / Approved / Rejected filters.
- **Auto Approve** is one compact row (title left, small ON/OFF switch right) that applies instantly, with no confirmation, like the theme switch.
- **Shared keys** is one table (Key, Status with green/red dot, Created On, Expiry Date `h:mm am/pm DD-MM-YYYY`); *Show key* works for active and expired keys.

## Small UI updates
- **Users tab:** new *FamPay balance* column between Email and UPI ID (latest "Updated Balance" email; "not read" if none).
- **Balance / Successful payments cards:** label on top, big amount, note underneath (admin user page and user dashboard).
- **Shared keys:** green key + ✓ icon for active keys, red key + ✗ icon for expired keys.
- **Buttons:** holding a button, menu pill or footer pill no longer opens the browser's link menu / page preview (`public/assets/nopress.js`; text links keep the normal menu).
- **Home page:** hero text now talks about FamPay ("Multi-Merchant FamPay Payment API").

## Motion (light CSS + one tiny script)
- **Load:** pages fade up; landing hero and badges appear one after another.
- **Scroll:** cards, stats and landing sections fade up (75px, eased over 260px of scrolling) as they scroll into view, a thin gold reading-progress bar runs along the top (CSS scroll timelines; older browsers simply skip it).
- **Click:** buttons press in with a soft light flash; the theme / Auto Approve switches slide.
- **Submit / loading:** the pressed button shows a spinner (and can't be double-submitted), a thin loading bar runs along the top while the next page loads (`public/assets/motion.js`), the "Test" output and "Sending…" pills pulse.
- **Feedback:** errors shake once, focused fields glow, the pending-approvals badge pulses gently, the payment result pops in, and pages cross-fade when you open another one.
- Everything is switched off for people who turned on "reduce motion" on their phone.

## Expired orders are hidden, keys are shown
- **Order lists** (admin Payments tab, a user's Orders on the admin user page, the user's own dashboard) show only **paid** orders, orders **needing review**, and orders whose QR is **still valid (15 minutes)**. Expired, cancelled and failed orders are not listed. Searching the Payments tab by an order ID / payment ID / UTR still finds any order (support). The data and the API are unchanged. Logic: `src/lib/order-visibility.js`.
- **Shared keys** table shows each key's actual value (admin-only page); keys created before values were stored show "not stored". Status icons are 15px green / red keys, no glow.

## Auto Approve switch (in place)
The switch is small and saves **in place**: it slides instantly, the request is sent in the background (`Accept: application/json` on `POST /admin/approvals`), a small message appears at the bottom, and when it clears the waiting list the rows fade away and the red number disappears. If saving fails it slides back and says why. Without JavaScript the old form + redirect still works.


## Gmail connection rules (users' read-only inbox)
- One Gmail address belongs to one gateway user at a time (`ux_gmail_email`, enforced inside a transaction with a per-address advisory lock). A rejected attempt never touches or revokes the owner's connection; ownership is released only by that user's disconnect (or account deletion).
- Credentials are saved only after Gmail's own profile for *that* token confirms the address. A missing refresh token is kept from the existing row only for the same verified address.
- Google ties all of this app's tokens for one Google account to a single grant, so a token is revoked only when no other connection (another user or the admin sender Gmail) uses that account.
- A dead token (`invalid_grant`, insufficient scope) flags the row `reconnect_required` (migration 0007) instead of deleting it; outages/quota errors show "try again", not "reconnect".
- Tests: this deployment copy ships without the `tests/` folder (the suite — PGlite, a real PostgreSQL engine in-process, fake Google — passed 53/53 before it was removed). `npm test` needs the full copy.

## Payer names & date style
- `received_from` is read from the credit sentence ("received ₹50.0 from Laiba naved at …"); older records with an empty name are filled in the first time they are looked up by UTR / transaction id, by re-reading that one already-recorded e-mail.
- API `date` fields use the same style as the pages (`4:49 pm 20-10-2026`); machine fields such as `payment_time` stay ISO-8601 UTC so integrations are unaffected.

## Pop-ups and scroll animation
- **Pop-ups** (`toast.js` / `toast.css`): one bottom-centre stack, max 3, same look as the "Auto Approve is ON" message. Sources: short success messages after a redirect (errors and anything long or secret, e.g. a new API key, stay as normal banners), theme switch, Auto Approve, the payment page, and real backend events from `GET /notify/feed` (own orders paid / QR generated, unmatched payment e-mails) with the actual amounts, polled every 8 s only while the tab is visible and de-duplicated by id.
- **Scroll reveal** (`motion.js`): the old scroll-linked CSS animation (it re-ran on every scroll direction change and when the phone's address bar resized the screen) is gone. Blocks that start below the fold now fade up once via IntersectionObserver; nothing already on screen is hidden, nothing is hidden without JavaScript, and the page cross-fade / page fade-in that stacked on top of it were removed.
