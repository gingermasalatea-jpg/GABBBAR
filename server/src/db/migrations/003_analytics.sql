-- Who resolved a conversation (agent performance) and when automations last fired per conversation.
ALTER TABLE conversations ADD COLUMN resolved_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN last_auto_reply_at timestamptz;
CREATE INDEX messages_out_sender_idx ON messages (sender_type, created_at) WHERE direction = 'out';
CREATE INDEX messages_conv_dir_idx ON messages (conversation_id, direction, created_at);
