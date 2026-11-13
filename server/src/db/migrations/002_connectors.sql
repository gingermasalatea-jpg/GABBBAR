-- Sheets: remember each row's last-synced values so two-way sync can tell which side changed.
ALTER TABLE sheet_connections ADD COLUMN row_state jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sheet_connections ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;
COMMENT ON COLUMN sheet_connections.default_opt_in IS 'Admin confirmed rows in this sheet gave WhatsApp consent; only then an opted-in column marks contacts opted in';

-- Inbound webhooks: show a short prefix of the token so admins can tell them apart.
ALTER TABLE webhooks ADD COLUMN token_prefix text;
