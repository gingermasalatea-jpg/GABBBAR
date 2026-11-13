-- GABBBAR schema — single tenant (no tenant_id anywhere by design).
-- gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('super_admin','admin','agent','viewer')),
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  token_version integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE custom_fields (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{0,48}$'),
  label      text NOT NULL,
  type       text NOT NULL DEFAULT 'text' CHECK (type IN ('text','number','date','boolean','select')),
  options    jsonb NOT NULL DEFAULT '[]',
  internal   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  name            text,
  email           text,
  tags            text[] NOT NULL DEFAULT '{}',
  custom          jsonb NOT NULL DEFAULT '{}',
  opted_in        boolean NOT NULL DEFAULT false,
  opt_in_source   text,
  opt_in_at       timestamptz,
  opted_out_at    timestamptz,
  source          text NOT NULL DEFAULT 'manual',
  is_demo         boolean NOT NULL DEFAULT false,
  last_inbound_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_tags_idx ON contacts USING gin (tags);
CREATE INDEX contacts_email_idx ON contacts (lower(email));
CREATE INDEX contacts_name_idx ON contacts (lower(name));
CREATE INDEX contacts_updated_idx ON contacts (updated_at);

CREATE TABLE labels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  color      text NOT NULL DEFAULT '#22c55e',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id           uuid NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  assigned_to          uuid REFERENCES users(id) ON DELETE SET NULL,
  ai_mode_override     text CHECK (ai_mode_override IN ('off','suggest','auto')),
  human_takeover       boolean NOT NULL DEFAULT false,
  takeover_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  takeover_at          timestamptz,
  unread_count         integer NOT NULL DEFAULT 0,
  last_message_at      timestamptz,
  last_message_preview text,
  last_inbound_at      timestamptz,
  last_handler         text CHECK (last_handler IN ('ai','human','automation')),
  flow_state           jsonb,
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_last_msg_idx ON conversations (last_message_at DESC NULLS LAST);
CREATE INDEX conversations_assigned_idx ON conversations (assigned_to);
CREATE INDEX conversations_status_idx ON conversations (status);

CREATE TABLE conversation_labels (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  label_id        uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, label_id)
);

CREATE TABLE templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (name ~ '^[a-z0-9_]+$' AND char_length(name) <= 512),
  language         text NOT NULL DEFAULT 'en',
  category         text NOT NULL CHECK (category IN ('MARKETING','UTILITY','AUTHENTICATION')),
  status           text NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','PENDING','APPROVED','REJECTED','PAUSED','DISABLED','IN_APPEAL','PENDING_DELETION','DELETED','LIMIT_EXCEEDED')),
  components       jsonb NOT NULL DEFAULT '[]',
  wa_template_id   text,
  rejection_reason text,
  quality_score    text,
  last_synced_at   timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, language)
);

CREATE TABLE broadcasts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  template_id        uuid NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  template_variables jsonb NOT NULL DEFAULT '{}',
  header_media_url   text,
  audience           jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','scheduled','running','completed','cancelled','failed')),
  scheduled_at       timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,
  error              text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE broadcast_recipients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id  uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id    uuid REFERENCES contacts(id) ON DELETE SET NULL,
  phone         text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','queued','sent','delivered','read','failed','skipped')),
  skip_reason   text,
  message_id    uuid,
  wa_message_id text,
  error_code    text,
  error_message text,
  attempts      integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broadcast_id, phone)
);
CREATE INDEX broadcast_recipients_status_idx ON broadcast_recipients (broadcast_id, status);
CREATE INDEX broadcast_recipients_wamid_idx ON broadcast_recipients (wa_message_id);

CREATE TABLE messages (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id        uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id             uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  direction              text NOT NULL CHECK (direction IN ('in','out')),
  sender_type            text NOT NULL CHECK (sender_type IN ('contact','agent','ai','automation','broadcast','api','system')),
  sender_user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  type                   text NOT NULL DEFAULT 'text',
  body                   text,
  payload                jsonb NOT NULL DEFAULT '{}',
  template_name          text,
  wa_message_id          text UNIQUE,
  reply_to_wa_id         text,
  status                 text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('received','queued','held','sent','delivered','read','failed','simulated')),
  error_code             text,
  error_message          text,
  broadcast_recipient_id uuid REFERENCES broadcast_recipients(id) ON DELETE SET NULL,
  sent_at                timestamptz,
  delivered_at           timestamptz,
  read_at                timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_created_idx ON messages (created_at);
CREATE INDEX messages_template_idx ON messages (template_name) WHERE template_name IS NOT NULL;

CREATE TABLE media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid REFERENCES messages(id) ON DELETE CASCADE,
  wa_media_id  text,
  mime_type    text,
  file_name    text,
  size_bytes   bigint,
  sha256       text,
  storage_path text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','stored','failed')),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_message_idx ON media (message_id);

CREATE TABLE notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_conv_idx ON notes (conversation_id, created_at);

CREATE TABLE automations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('keyword','welcome','out_of_hours','flow')),
  is_active       boolean NOT NULL DEFAULT true,
  priority        integer NOT NULL DEFAULT 100,
  trigger         jsonb NOT NULL DEFAULT '{}',
  response        jsonb NOT NULL DEFAULT '{}',
  flow_start_node text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flow_nodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  node_key      text NOT NULL,
  type          text NOT NULL CHECK (type IN ('message','buttons','list','condition','assign','tag','webhook','handoff')),
  config        jsonb NOT NULL DEFAULT '{}',
  next          jsonb NOT NULL DEFAULT '{}',
  position      integer NOT NULL DEFAULT 0,
  UNIQUE (automation_id, node_key)
);

CREATE TABLE tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  subject         text NOT NULL,
  description     text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed')),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai_fallback','flow','api')),
  assigned_to     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
CREATE INDEX tickets_status_idx ON tickets (status, created_at DESC);

CREATE TABLE knowledge_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL CHECK (type IN ('business_info','faq','document')),
  title       text NOT NULL,
  content     text NOT NULL,
  tags        text[] NOT NULL DEFAULT '{}',
  source_file text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id       uuid REFERENCES messages(id) ON DELETE SET NULL,
  reply_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  mode             text NOT NULL,
  provider         text NOT NULL,
  model            text,
  input            jsonb NOT NULL DEFAULT '{}',
  prompt           text,
  output           text,
  raw_output       text,
  knowledge_ids    uuid[] NOT NULL DEFAULT '{}',
  knowledge_titles text[] NOT NULL DEFAULT '{}',
  decision         text NOT NULL CHECK (decision IN ('sent','suggested','held','fallback','blocked','error','skipped')),
  guardrail_flags  text[] NOT NULL DEFAULT '{}',
  latency_ms       integer,
  tokens_in        integer,
  tokens_out       integer,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_logs_conv_idx ON ai_logs (conversation_id, created_at DESC);
CREATE INDEX ai_logs_created_idx ON ai_logs (created_at DESC);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}',
  secret_enc text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type  text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','api_key','system')),
  actor_label text,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  meta        jsonb NOT NULL DEFAULT '{}',
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  prefix       text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('in','out')),
  url         text,
  events      text[] NOT NULL DEFAULT '{}',
  token_hash  text UNIQUE,
  secret_enc  text,
  action      jsonb NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  last_status text,
  last_called_at timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((direction = 'out' AND url IS NOT NULL) OR direction = 'in')
);

CREATE TABLE webhook_deliveries (
  id            bigserial PRIMARY KEY,
  webhook_id    uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event         text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  response_code integer,
  attempts      integer NOT NULL DEFAULT 0,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_idx ON webhook_deliveries (webhook_id, created_at DESC);

CREATE TABLE processed_events (
  event_id   text PRIMARY KEY,
  kind       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dead_letters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue       text NOT NULL,
  job_name    text NOT NULL,
  job_id      text,
  payload     jsonb NOT NULL DEFAULT '{}',
  error       text,
  attempts    integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','retried','discarded')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX dead_letters_status_idx ON dead_letters (status, created_at DESC);

CREATE TABLE sheet_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  spreadsheet_id   text NOT NULL,
  sheet_name       text NOT NULL,
  key_column       text NOT NULL,
  mapping          jsonb NOT NULL DEFAULT '[]',
  sync_direction   text NOT NULL DEFAULT 'both' CHECK (sync_direction IN ('pull','push','both')),
  interval_minutes integer NOT NULL DEFAULT 15 CHECK (interval_minutes BETWEEN 5 AND 1440),
  default_opt_in   boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  last_synced_at   timestamptz,
  last_status      text,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
