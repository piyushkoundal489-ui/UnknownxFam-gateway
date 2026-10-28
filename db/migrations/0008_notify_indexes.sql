-- /notify/feed asks "anything new for this user in the last few minutes?" every few seconds while a dashboard is open.
CREATE INDEX IF NOT EXISTS ix_gpm_user_created ON gmail_payment_messages (user_id, created_at DESC);
