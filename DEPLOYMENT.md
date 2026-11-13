# Deployment guide

## 1. Server

Use any Linux VM (2 vCPU / 4 GB RAM handles one busy number) with Docker and a domain. You need two hostnames, or one hostname and a path proxy:

- `app.example.com` → web (Next.js, port 3000). It also proxies `/api/*` to the API.
- `api.example.com` → API (port 4000). Meta's webhook and the inbound webhooks hit this.

## 2. Configure

```bash
git clone <repo> wadesk && cd wadesk
cp .env.example .env
```

Set at least the following in `.env`:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://app.example.com` |
| `API_URL` | `https://api.example.com` |
| `JWT_SECRET` | 48+ random bytes (base64). The app refuses to start without it |
| `ENCRYPTION_KEY` | 32 random bytes (base64). **Back this up.** Losing it makes stored tokens and keys unreadable |
| `POSTGRES_PASSWORD` | A strong password (used by `docker-compose.prod.yml`) |
| `WHATSAPP_MOCK` / `AI_MOCK` / `GOOGLE_MOCK` | `false` once real credentials are ready |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Your first Super Admin (only used by the seed script) |

## 3. Start

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

- `api` runs migrations automatically on start (`AUTO_MIGRATE=false` disables this) and serves HTTP only.
- `worker` runs all queue workers and scheduled jobs (template sync, Sheets sync, cleanup). Scale it with `--scale worker=2`. BullMQ shares the work safely.
- Media files live in the `media` volume, which `api` and `worker` share.

Create the first Super Admin:

```bash
docker compose -f docker-compose.prod.yml exec api node src/db/seed.js
```

The seed also loads demo contacts, chats and knowledge. Delete the demo contacts afterwards (Contacts → filter by tag), or create the admin with SQL instead.

## 4. Reverse proxy (TLS)

Example with Caddy (automatic HTTPS):

```
app.example.com {
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1          # keep the live inbox (SSE) streaming
  }
}
api.example.com {
  reverse_proxy 127.0.0.1:4000 {
    flush_interval -1
  }
}
```

With nginx, set `proxy_buffering off;` and `proxy_read_timeout 1h;` for `/api/events`. Keep `TRUST_PROXY=1` so rate limits and audit logs see the real client IP.

## 5. Meta webhook

Callback URL: `https://api.example.com/api/webhooks/meta`. Use the verify token from Settings → WhatsApp. Subscribe to `messages`, `message_template_status_update` and `message_template_quality_update`. Without the **App Secret** set, every webhook POST is rejected (401) by design.

## 6. Google Sheets (optional)

1. In Google Cloud Console, create OAuth credentials (type *Web application*).
2. Add the authorized redirect URI: `https://app.example.com/api/connectors/google/callback`.
3. Enable the **Google Sheets API**.
4. Enter the client ID and secret in Settings → Connectors, then click **Connect Google account**.

## 7. Backups and operations

- **Postgres**: run `pg_dump` nightly (for example with `docker compose exec postgres pg_dump -U wadesk wadesk | gzip > backup.sql.gz`) and copy the dumps off the server.
- **Media volume**: back up `/data/media`. Meta's media links expire, so this is the only copy of customer attachments.
- **Encryption key**: store `ENCRYPTION_KEY` in a password manager.
- **Health**: `GET /api/health`. Watch Settings → Failed jobs (dead-letter queue) and the audit log.
- **Updates**: `git pull && docker compose -f docker-compose.prod.yml up -d --build`. Migrations run on start.
- **Rotating a Meta token**: paste the new token in Settings → WhatsApp. No restart is needed.

## 8. Security checklist

- [ ] Change all seeded passwords; deactivate demo users you don't need
- [ ] `NODE_ENV=production` (secure cookies, HSTS, https-only outbound webhooks, private-IP SSRF block)
- [ ] App Secret and verify token set; webhook verification succeeds in Meta
- [ ] Ports 3000/4000 bound to localhost only, behind the TLS proxy
- [ ] Postgres and Redis not exposed publicly
- [ ] Mark ID numbers, payment proofs and credit limits as **Internal** custom fields
- [ ] Review the AI knowledge base and Do/Don't rules before turning on Auto-reply
- [ ] Turn on **Send live** only after a final test
