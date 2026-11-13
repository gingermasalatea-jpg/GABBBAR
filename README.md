# GABBBAR

A single-company WhatsApp Business team inbox with automations, broadcasts and a grounded AI assistant. It is an in-house alternative to AiSensy or Wati. It uses the **official Meta WhatsApp Business Cloud API only**.

- **Team inbox**: live chat, assignment, labels, internal notes, delivery ticks, 24-hour window timer, human takeover.
- **Contacts**: E.164 phone key, tags, custom fields (with *internal* fields), opt-in tracking, CSV import/export, duplicate merge.
- **Templates**: create, submit to Meta, sync status and rejection reasons, preview, send.
- **Broadcasts**: approved template to opted-in contacts only, with a rate-limited queue and a delivery report.
- **Automations**: keyword replies, welcome, out-of-hours, and a flow builder (buttons, lists, conditions, assign, tag, webhook, hand-off).
- **AI assistant**: Claude (default), OpenAI, Gemini or any OpenAI-compatible endpoint. Answers only from your knowledge base, with guardrails. Off / Suggest / Auto modes. Every reply is logged.
- **Connectors**: two-way Google Sheets sync, inbound and outbound webhooks, and a REST API with API keys.
- **Security**: Super Admin / Admin / Agent / Viewer roles, audit log, encrypted secrets, and Meta signature checks.

## Requirements

- Node.js **20.12+** (22 recommended)
- Docker (for PostgreSQL 16 and Redis 7), or your own Postgres and Redis

## Run it locally

```bash
cp .env.example .env
# Generate secrets and paste them into .env:
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"

docker compose up -d          # Postgres + Redis
npm install                   # installs server + web workspaces
npm run db:migrate
npm run db:seed               # demo users, contacts, chats, templates, knowledge, automations
npm run dev                   # API on :4000, web on :3000
```

Open http://localhost:3000 and sign in.

| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@wadesk.local` (or `SEED_ADMIN_EMAIL`) | `ChangeMe@123` (or `SEED_ADMIN_PASSWORD`) |
| Admin | `admin@demo.local` | `Demo@12345` |
| Agent | `ravi@demo.local`, `neha@demo.local` | `Demo@12345` |
| Viewer | `viewer@demo.local` | `Demo@12345` |

Change these passwords before going live (Settings → Team & roles).

### Try the demo flow

While `WHATSAPP_MOCK=true`, nothing is sent to anyone:

1. Go to **Inbox → + Simulate customer** and send *"Do you accept UPI?"*. The message goes through the same webhook → queue → automation → AI pipeline as a real one.
2. Turn the AI to **Auto-reply** in Settings → AI assistant. The AI answers from the knowledge base. Ticks move from sent to delivered to read (simulated).
3. Ask something outside the knowledge base, such as *"Can you recommend a movie?"*. A ticket is created and the team is notified.
4. Send **menu**. The demo flow replies with buttons.
5. Try **Broadcasts**, **Templates → New template** (auto-reviewed after about 5 seconds in demo mode), and **Settings → Connectors** (the demo Google Sheet).

Without Redis you can run with `QUEUE_DRIVER=inline` (an in-process queue with the same retries and dead-letter behaviour). Use Redis in production.

## Mock mode vs real credentials

| Flag (`.env`) | `true` (default) | `false` |
|---|---|---|
| `WHATSAPP_MOCK` | Local mock transport, simulated ticks, simulate-customer button | Real Graph API. Needs Phone Number ID, WABA ID, access token, app secret, verify token |
| `AI_MOCK` | Local extractive answers from the knowledge base (same guardrails and logs) | Calls the provider chosen in Settings. Needs its API key |
| `GOOGLE_MOCK` | Local JSON "spreadsheet" for mapping and sync | Real Google OAuth + Sheets API. Needs OAuth client ID and secret |

Credentials can be entered in **Settings** (stored AES-256-GCM encrypted, never returned to the browser) or in `.env`. Values in Settings win over `.env`.

**Send live.** No real customer message is delivered until an admin turns on **Settings → WhatsApp → Send live**. While it is off, every outgoing message (agents, AI, automations, broadcasts) is recorded with status *held*.

## Going live with WhatsApp

1. In Meta for Developers, create an app with the **WhatsApp** product. Add your number and create a **System User** token with `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
2. In GABBBAR **Settings → WhatsApp**, enter the Phone Number ID, WABA ID, access token, App Secret, and a verify token of your choice.
3. In Meta → WhatsApp → Configuration, set the callback URL to `https://<your-api-domain>/api/webhooks/meta` with the same verify token. Subscribe to `messages`, `message_template_status_update` and `message_template_quality_update`.
4. Set `WHATSAPP_MOCK=false` and restart. Click **Test connection**, then **Sync from Meta** on the Templates page.
5. Turn on **Send live**.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API (watch mode) + Next.js dev server |
| `npm run db:migrate` / `npm run db:seed` | Apply migrations / load demo data (idempotent) |
| `npm test` | Unit tests (node:test) |
| `npm run test:integration --workspace server` | HTTP + database tests. Needs `RUN_INTEGRATION=1` and a throwaway `DATABASE_URL`, because it **wipes that schema** |
| `npm run build` | Production build of the web app |
| `npm run lint` | ESLint (server) + `next lint` (web) |

## Architecture

```
Browser ──► Next.js (web, :3000) ──/api/*──► Express API (:4000) ──► PostgreSQL
                                    SSE ◄──┘        │  ▲
Meta Cloud API ──webhook──► /api/webhooks/meta ─────┘  │
                                                ▼      │
                                         Redis / BullMQ queues ──► workers:
                         inbound · outbound · media · automation · ai · broadcast · webhooks · sheets · maintenance
```

- The webhook verifies `X-Hub-Signature-256`, queues the payload and returns 200. Workers de-duplicate by message ID.
- Failed jobs retry with exponential backoff. Once retries are exhausted they land in the **dead-letter queue** (Settings → Failed jobs), where an admin can retry or discard them.
- See [PLAN.md](PLAN.md) for the schema and API list, and [DEPLOYMENT.md](DEPLOYMENT.md) for production.
