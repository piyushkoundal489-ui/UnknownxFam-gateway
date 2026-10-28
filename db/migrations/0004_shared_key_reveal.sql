-- Encrypted (AES-GCM, ENCRYPTION_KEY) copy of each NEW shared key so a super admin can show it again on Admin -> Shared keys.
-- Keys created before this migration keep key_enc NULL (their value was only ever shown once).
ALTER TABLE shared_api_keys ADD COLUMN key_enc TEXT;
