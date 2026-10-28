-- Tracks the API-key expiry e-mails (daily from 3 days before expiry, plus one "expired" notice) so each is sent once per day,
-- and starts over when the key is renewed or replaced (key_notice_for no longer equals the key's expiry).
ALTER TABLE users ADD COLUMN key_notice_at   BIGINT;   -- when the last notice was sent
ALTER TABLE users ADD COLUMN key_notice_for  BIGINT;   -- the api_key_expires_at that notice was about
ALTER TABLE users ADD COLUMN key_notice_kind TEXT;     -- 'reminder' | 'expired'
