# GABBBAR — Build Plan

Single-tenant WhatsApp Business automation platform and team inbox for one
company, one WhatsApp number and one team. Official Meta WhatsApp Business
Cloud API only.

## 1. Folder structure

```
wadesk/
├── PLAN.md  README.md  DEPLOYMENT.md  .env.example  docker-compose.yml
├── package.json                    npm workspaces: server, web
├── server/                         Node.js 20+ (ESM) · Express · PostgreSQL · BullMQ
│   ├── package.json
│   ├── src/
│   │   ├── index.js                HTTP server + workers bootstrap
│   │   ├── app.js                  Express app factory (routes, middleware)
│   │   ├── config.js               env parsing, mock flags
│   │   ├── db/                     pool.js · migrate.js · seed.js · migrations/*.sql
│   │   ├── lib/                    pure, dependency-free helpers (unit tested)
│   │   │   ├── phone.js  crypto.js  jwt.js  csv.js  backoff.js  window.js
│   │   │   ├── permissions.js  workingHours.js  templateVars.js  redact.js
│   │   │   ├── errors.js  logger.js  events.js (SSE bus)  validate.js
│   │   ├── middleware/             auth · rbac · apiKey · rateLimit · security · error
│   │   ├── services/               settings · audit · contacts · conversations · messages
│   │   │                           templates · broadcasts · automations · tickets
│   │   │                           analytics · webhooksOut · sheets · dlq · users
│   │   ├── whatsapp/               client (real + mock) · signature · parser · metaErrors · media
│   │   ├── ai/                     providers/ · knowledge (retrieval) · prompt · guardrails · assistant
│   │   ├── automation/             engine (pure flow evaluator) · runner
│   │   ├── queue/                  queues · workers · inline fallback
│   │   └── routes/                 one router per module + public REST API v1
│   └── test/                       node:test unit + integration tests
└── web/                            Next.js (App Router) · Tailwind CSS v4
    ├── app/                        login · inbox · contacts · templates · broadcasts
    │                               automations · ai · tickets · analytics · settings
    ├── components/                 UI kit, chat, layout, states (loading/empty/error)
    └── lib/                        api client · auth context · SSE hook · theme
```

## 2. Database schema (PostgreSQL, single-tenant, no tenant_id)

| Table | Key columns |
|---|---|
| users | id, name, email (unique, case-insensitive), password_hash (bcrypt), role (super_admin/admin/agent/viewer), is_active, last_login_at |
| contacts | id, phone (E.164, UNIQUE), name, email, tags[], custom jsonb, opted_in, opt_in_source, opt_in_at, opted_out_at, is_demo, last_inbound_at |
| custom_fields | key, label, type, options, internal (never shown to customers / AI) |
| conversations | id, contact_id (unique), status open/resolved, assigned_to, ai_mode_override, human_takeover, unread_count, last_message_at, last_inbound_at, last_handler (ai/human), flow_state jsonb, resolved_at |
| messages | id, conversation_id, direction in/out, sender_type, sender_user_id, type, body, payload, template_name, wa_message_id (UNIQUE), status, error_code, broadcast_recipient_id, sent/delivered/read timestamps |
| media | message_id, wa_media_id, mime_type, file_name, size_bytes, sha256, storage_path, status |
| templates | name+language (unique), category, status, components jsonb, wa_template_id, rejection_reason, last_synced_at |
| broadcasts | name, template_id, template_variables, audience jsonb, status, scheduled_at, started_at, completed_at |
| broadcast_recipients | broadcast_id, contact_id, phone, status, skip_reason, wa_message_id, error_code, attempts |
| automations | name, type (keyword/welcome/out_of_hours/flow), is_active, priority, trigger jsonb, response jsonb, flow_start_node |
| flow_nodes | automation_id, node_key, type (message/buttons/list/condition/assign/tag/webhook/handoff), config, next |
| labels / conversation_labels | label catalogue + many-to-many |
| notes | conversation_id, user_id, body (internal only) |
| tickets | conversation_id, contact_id, subject, description, status, priority, source, assigned_to |
| ai_logs | conversation_id, message_id, mode, provider, model, input, prompt, output, knowledge_ids, decision, guardrail_flags, latency_ms |
| knowledge_items | type (business_info/faq/document), title, content, tags, is_active |
| settings | key, value jsonb, secret_enc (AES-256-GCM, never returned) |
| audit_logs | user_id, actor_type, action, entity_type, entity_id, meta, ip |
| api_keys | name, prefix, key_hash (sha256), scopes[], last_used_at, revoked_at |
| webhooks / webhook_deliveries | inbound (token hash + action) and outbound (url, events, signing secret) + delivery log |
| processed_events | event_id PK — de-duplicates Meta webhook events |
| dead_letters | queue, job_name, payload, error, status — admin-visible DLQ |
| sheet_connections | spreadsheet_id, sheet_name, mapping jsonb (exact column names), key_column, sync_direction, last_synced_at |

## 3. API list (all under `/api`, JSON, cookie JWT auth unless noted)

- **Auth**: POST /auth/login · POST /auth/logout · GET /auth/me · POST /auth/change-password
- **Users** (admin): GET/POST /users · PATCH /users/:id · GET /users/permissions
- **Settings**: GET /settings · PUT /settings/:section · PUT /settings/secrets/:name · POST /settings/whatsapp/test · GET /settings/status
- **Contacts**: GET/POST /contacts · GET/PATCH/DELETE /contacts/:id · POST /contacts/import · GET /contacts/export · GET /contacts/duplicates · POST /contacts/merge · POST /contacts/:id/opt-in · POST /contacts/:id/opt-out
- **Custom fields**: GET/POST /custom-fields · PATCH/DELETE /custom-fields/:id
- **Conversations**: GET /conversations?filter= · GET /conversations/:id · PATCH /conversations/:id (status, assign, ai override) · POST /conversations/:id/takeover · POST /conversations/:id/release · POST /conversations/:id/read · GET/POST /conversations/:id/messages · GET/POST /conversations/:id/notes · PUT /conversations/:id/labels · POST /conversations/:id/ai-suggest
- **Labels**: GET/POST /labels · DELETE /labels/:id
- **Media**: GET /media/:id (authenticated stream)
- **Templates**: GET/POST /templates · PATCH/DELETE /templates/:id · POST /templates/:id/submit · POST /templates/sync · POST /templates/:id/send
- **Broadcasts**: GET/POST /broadcasts · GET /broadcasts/:id · POST /broadcasts/:id/schedule · POST /broadcasts/:id/cancel · GET /broadcasts/:id/recipients · POST /broadcasts/preview-audience
- **Automations**: GET/POST /automations · GET/PUT/DELETE /automations/:id (incl. flow nodes) · POST /automations/test
- **AI**: GET /ai/logs · GET /ai/logs/:id · POST /ai/test · knowledge: GET/POST /knowledge · PATCH/DELETE /knowledge/:id
- **Tickets**: GET /tickets · PATCH /tickets/:id · POST /tickets
- **Analytics**: GET /analytics/overview?days=
- **Connectors**: GET /connectors/google/auth-url · GET /connectors/google/callback · GET/POST /connectors/sheets · PUT/DELETE /connectors/sheets/:id · GET /connectors/sheets/:id/headers · POST /connectors/sheets/:id/sync · GET/POST /webhooks · PATCH/DELETE /webhooks/:id · GET /webhooks/:id/deliveries
- **API keys**: GET/POST /api-keys · DELETE /api-keys/:id
- **Ops**: GET /audit-logs · GET /dlq · POST /dlq/:id/retry · POST /dlq/:id/discard · GET /events (SSE) · GET /health
- **Meta webhook** (public, signature-verified): GET /webhooks/meta (verify) · POST /webhooks/meta
- **Inbound webhooks** (public, token): POST /hooks/in/:token
- **Dev/demo**: POST /dev/simulate-inbound (only while WhatsApp is in mock mode)
- **Public REST API v1** (API key, `Authorization: Bearer wak_…`): GET/POST /v1/contacts · GET/PATCH /v1/contacts/:phone · POST /v1/messages/template · POST /v1/messages/text · GET /v1/conversations · GET /v1/templates

## 4. Phase checklist

### Phase 1 — Project setup, auth, roles, UI shell, settings screens
- [x] Monorepo, docker-compose (Postgres + Redis), .env.example
- [x] Config with mock flags (WHATSAPP_MOCK, AI_MOCK, GOOGLE_MOCK)
- [x] Email + password auth, bcrypt, HS256 JWT in httpOnly cookie, CSRF header check
- [x] Roles Super Admin / Admin / Agent / Viewer + permission matrix
- [x] Next.js App Router shell: sidebar, top bar, light/dark mode, responsive
- [x] Settings screens: WhatsApp, business profile, working hours, AI, rules, knowledge, team

### Phase 2 — Database schema, backend APIs, contacts
- [x] Migration runner + full schema
- [x] Encrypted settings store (AES-256-GCM), secrets never returned
- [x] Contacts: E.164 key, tags, custom fields (internal flag), opt-in, CSV import/export, duplicate merge
- [x] Audit log service; seed script with demo data

### Phase 3 — WhatsApp Cloud API
- [x] Webhook verify + X-Hub-Signature-256 check on every POST; 200 immediately, queue processing
- [x] De-duplication by message ID; status updates (sent/delivered/read/failed)
- [x] Send text / media / template / interactive; Meta error-code classification; backoff + DLQ
- [x] Media download + local storage right away (Meta links expire)
- [x] Template create / submit / sync status + rejection reasons / preview / send
- [x] STOP / START keywords; 24-hour window enforcement; mock transport

### Phase 4 — Team inbox
- [x] Conversation list with filters (unread, mine, unassigned, open, resolved, AI-handled, human-handled), search
- [x] WhatsApp-style chat, delivery ticks, 24h window timer, template picker outside the window
- [x] Assignment, labels, internal notes, human takeover (pauses AI instantly), resolve/reopen
- [x] Realtime via SSE

### Phase 5 — Connectors
- [x] Google Sheets OAuth + column-mapping UI (exact column names), two-way sync, scheduled sync
- [x] Inbound webhooks (token) + outbound webhooks (HMAC-signed, retried)
- [x] REST API v1 with hashed API keys + scopes

### Phase 6 — AI assistant
- [x] Provider layer: Claude (default), OpenAI, Gemini, OpenAI-compatible, mock
- [x] Knowledge retrieval, contact data minus internal fields, Do/Don't rules, tone, never-say list
- [x] Guardrails: grounded-only answers, no guarantees, no invented facts, no ID/payment data leaks
- [x] Out-of-context fallback → ticket + team notification
- [x] Modes Off/Suggest/Auto, global Send live, per-conversation override, takeover respected
- [x] Every AI reply logged with input, output, knowledge used

### Phase 7 — Broadcasts, automation, analytics
- [x] Broadcasts: approved template + audience (tags/filter/CSV) + schedule; rate-limited queue; report; opt-in enforced
- [x] Automations: keywords, welcome, out-of-hours, working hours; flow builder (message, buttons/list, condition, assign, tag, webhook, hand-off)
- [x] Analytics: conversations/day, response + resolution time, agent performance, AI vs human, template performance

### Phase 8 — Security hardening, tests, deployment
- [x] Security headers, rate limits (login, API, webhook), body limits, input validation (zod)
- [x] Unit tests (node:test) for pure logic; integration test for the HTTP API
- [x] DEPLOYMENT.md (Docker, reverse proxy, Meta webhook setup, backups)

## Verification status

- Unit tests: 27 passing (`npm test`): phone, crypto, JWT, CSV, permissions, working hours, 24h window,
  template variables, redaction, Meta signature/parser/errors/payloads, retrieval, prompt, guardrails, flow engine.
- Integration tests: 8 passing against real PostgreSQL (`npm run test:integration`): auth/CSRF, RBAC,
  encrypted write-only secrets, Send-live guard, webhook signature + dedup + AI auto-reply without internal data,
  takeover + fallback tickets, 24h window + STOP, API keys/scopes.
- Not yet verified in this build environment: `next build` / `next lint` / ESLint (packages could not be
  installed here), BullMQ against a live Redis, real Meta / Google / AI provider calls.
