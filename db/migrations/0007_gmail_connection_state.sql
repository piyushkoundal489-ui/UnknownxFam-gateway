-- Gmail connection health. A revoked / dead refresh token no longer deletes the row (that silently hid the problem and lost the
-- owner's claim on the address); it flags the connection so the dashboard can say "reconnect Gmail" and the background poller
-- stops calling Google with a token that is known to be dead. Only a successful disconnect (or reconnect) clears it.
ALTER TABLE gmail_accounts ADD COLUMN IF NOT EXISTS status        TEXT   NOT NULL DEFAULT 'active';   -- active | reconnect_required
ALTER TABLE gmail_accounts ADD COLUMN IF NOT EXISTS last_error    TEXT;                                -- short machine code only, never a token or message body
ALTER TABLE gmail_accounts ADD COLUMN IF NOT EXISTS last_error_at BIGINT;
ALTER TABLE gmail_accounts DROP CONSTRAINT IF EXISTS gmail_accounts_status_chk;
ALTER TABLE gmail_accounts ADD CONSTRAINT gmail_accounts_status_chk CHECK (status IN ('active', 'reconnect_required'));
-- Defence in depth: the one-address-one-owner rule is already ux_gmail_email (LOWER(email)); make sure nothing stores an unnormalised address.
ALTER TABLE gmail_accounts DROP CONSTRAINT IF EXISTS gmail_accounts_email_norm_chk;
ALTER TABLE gmail_accounts ADD CONSTRAINT gmail_accounts_email_norm_chk CHECK (email = LOWER(BTRIM(email)));
