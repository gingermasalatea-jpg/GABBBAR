/**
 * End-to-end API tests against a real PostgreSQL database (inline queue, mock WhatsApp + AI).
 * Run: createdb wadesk_test && DATABASE_URL=postgres://…/wadesk_test npm run test:integration
 * WARNING: wipes and recreates the database schema.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

if (!process.env.RUN_INTEGRATION) {
  test('integration tests skipped (set RUN_INTEGRATION=1 and DATABASE_URL to a throwaway database)', { skip: true }, () => {});
} else {
  process.env.NODE_ENV = 'test';
  process.env.QUEUE_DRIVER = 'inline';
  process.env.WHATSAPP_MOCK = 'true';
  process.env.AI_MOCK = 'true';
  process.env.GOOGLE_MOCK = 'true';
  process.env.MEDIA_DIR = process.env.MEDIA_DIR || '/tmp/wadesk-test-media';

  const { pool, query } = await import('../../src/db/pool.js');
  const { migrate } = await import('../../src/db/migrate.js');
  const { createApp } = await import('../../src/app.js');
  const { registerAllJobs } = await import('../../src/queue/register.js');
  const { setSecret, setSection, clearSettingsCache } = await import('../../src/services/settings.js');
  const { signMetaBody } = await import('../../src/whatsapp/signature.js');
  const bcrypt = (await import('bcryptjs')).default;

  let server;
  let base;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function call(path, { method = 'GET', body, cookie, headers = {}, csrf = true } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-Requested-With': 'wadesk' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }

  async function login(email, password) {
    const r = await call('/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.headers.get('set-cookie').split(';')[0];
  }

  before(async () => {
    await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate({ log: () => {} });
    const hash = await bcrypt.hash('Admin@12345', 10);
    await query(`INSERT INTO users (name, email, role, password_hash) VALUES ('Admin','admin@t.local','super_admin',$1), ('Agent','agent@t.local','agent',$1), ('View','viewer@t.local','viewer',$1)`, [hash]);
    await query(`INSERT INTO knowledge_items (type, title, content) VALUES ('faq','What payment methods do you accept?','We accept UPI, bank transfer and cards.')`);
    await query(`INSERT INTO custom_fields (key, label, internal) VALUES ('pan_no','PAN',true)`);
    registerAllJobs();
    server = http.createServer(createApp());
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  });

  after(async () => {
    server?.close();
    await pool.end();
  });

  test('auth: wrong password, login, me, CSRF header required', async () => {
    assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'admin@t.local', password: 'nope' } })).status, 401);
    const c = await login('admin@t.local', 'Admin@12345');
    assert.equal((await call('/api/auth/me', { cookie: c })).json.user.role, 'super_admin');
    assert.equal((await call('/api/contacts', { method: 'POST', cookie: c, csrf: false, body: { phone: '9800000001' } })).status, 403);
    assert.equal((await call('/api/contacts')).status, 401);
  });

  test('rbac: viewer cannot write, agent cannot change settings or send live', async () => {
    const v = await login('viewer@t.local', 'Admin@12345');
    assert.equal((await call('/api/contacts', { method: 'POST', cookie: v, body: { phone: '9800000002' } })).status, 403);
    const a = await login('agent@t.local', 'Admin@12345');
    assert.equal((await call('/api/settings/general', { method: 'PUT', cookie: a, body: { send_live: true } })).status, 403);
    assert.equal((await call('/api/users', { method: 'POST', cookie: a, body: { name: 'x', email: 'x@x.com', role: 'admin', password: 'Abcdefgh12' } })).status, 403);
  });

  test('secrets are write-only and encrypted at rest', async () => {
    const c = await login('admin@t.local', 'Admin@12345');
    assert.equal((await call('/api/settings/secrets/whatsapp.access_token', { method: 'PUT', cookie: c, body: { value: 'EAAG-SUPER-SECRET' } })).status, 200);
    const s = await call('/api/settings', { cookie: c });
    assert.equal(s.json.secrets['whatsapp.access_token'].set, true);
    assert.ok(!JSON.stringify(s.json).includes('EAAG-SUPER-SECRET'));
    const row = (await query(`SELECT secret_enc FROM settings WHERE key = 'secret:whatsapp.access_token'`)).rows[0];
    assert.ok(row.secret_enc.startsWith('v1:') && !row.secret_enc.includes('EAAG'));
  });

  test('send live cannot be enabled in mock mode', async () => {
    const c = await login('admin@t.local', 'Admin@12345');
    assert.equal((await call('/api/settings/general', { method: 'PUT', cookie: c, body: { send_live: true } })).status, 400);
  });

  test('meta webhook: verify token, signature check, dedup, AI auto-reply, internal data never sent', async () => {
    await setSecret('whatsapp.app_secret', 'app-secret');
    await setSecret('whatsapp.verify_token', 'verify-me');
    await setSection('ai', { mode: 'auto' });
    await query(`INSERT INTO contacts (phone, name, custom) VALUES ('+919811100001','Ravi', '{"pan_no":"ABCDE1234F"}')`);
    clearSettingsCache();
    const v = await call('/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42');
    assert.equal(v.json, 42);
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { contacts: [{ profile: { name: 'Ravi' }, wa_id: '919811100001' }], messages: [{ from: '919811100001', id: 'wamid.T1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Do you accept UPI?' } }] } }] }] });
    assert.equal((await call('/api/webhooks/meta', { method: 'POST', body: payload, headers: { 'X-Hub-Signature-256': 'sha256=deadbeef' } })).status, 401);
    const sig = signMetaBody(Buffer.from(payload), 'app-secret');
    assert.equal((await call('/api/webhooks/meta', { method: 'POST', body: payload, headers: { 'X-Hub-Signature-256': sig } })).status, 200);
    assert.equal((await call('/api/webhooks/meta', { method: 'POST', body: payload, headers: { 'X-Hub-Signature-256': sig } })).status, 200);
    await sleep(4500);
    const msgs = (await query(`SELECT m.direction, m.sender_type, m.body FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.phone = '+919811100001' ORDER BY m.created_at`)).rows;
    assert.equal(msgs.filter((m) => m.direction === 'in').length, 1, 'duplicate webhook stored once');
    const ai = msgs.find((m) => m.sender_type === 'ai');
    assert.ok(ai, 'AI replied');
    assert.match(ai.body, /UPI/);
    assert.ok(!ai.body.includes('ABCDE1234F'));
    const log = (await query(`SELECT prompt, decision FROM ai_logs WHERE decision = 'sent' LIMIT 1`)).rows[0];
    assert.ok(!log.prompt.includes('ABCDE1234F'), 'internal field never reaches the AI prompt');
  });

  test('takeover pauses AI; out-of-knowledge question creates a ticket', async () => {
    const c = await login('admin@t.local', 'Admin@12345');
    await call('/api/whatsapp/simulate-inbound', { method: 'POST', cookie: c, body: { phone: '9811100002', name: 'Neha', text: 'Can you recommend a good movie?' } });
    await sleep(4500);
    const t = (await query(`SELECT source FROM tickets`)).rows;
    assert.ok(t.some((x) => x.source === 'ai_fallback'));
    const conv = (await query(`SELECT cv.id FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE c.phone = '+919811100001'`)).rows[0];
    assert.equal((await call(`/api/conversations/${conv.id}/takeover`, { method: 'POST', cookie: c })).status, 200);
    await call('/api/whatsapp/simulate-inbound', { method: 'POST', cookie: c, body: { phone: '9811100001', text: 'What payment methods do you accept?' } });
    await sleep(4500);
    const aiCount = (await query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND sender_type = 'ai'`, [conv.id])).rows[0].n;
    assert.equal(aiCount, 1, 'no new AI reply after takeover');
  });

  test('24h window and opt-out rules', async () => {
    const c = await login('admin@t.local', 'Admin@12345');
    const conv = (await query(`SELECT cv.id FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE c.phone = '+919811100002'`)).rows[0];
    await query(`UPDATE conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`, [conv.id]);
    const r = await call(`/api/conversations/${conv.id}/messages`, { method: 'POST', cookie: c, body: { text: 'late reply' } });
    assert.equal(r.status, 400);
    await call('/api/whatsapp/simulate-inbound', { method: 'POST', cookie: c, body: { phone: '9811100002', text: 'STOP' } });
    await sleep(800);
    const ct = (await query(`SELECT opted_in, opted_out_at FROM contacts WHERE phone = '+919811100002'`)).rows[0];
    assert.equal(ct.opted_in, false);
    assert.ok(ct.opted_out_at);
  });

  test('REST API key auth and scopes', async () => {
    const c = await login('admin@t.local', 'Admin@12345');
    const k = await call('/api/connectors/api-keys', { method: 'POST', cookie: c, body: { name: 'test', scopes: ['contacts:read'] } });
    const key = k.json.secret;
    const ok = await call('/api/v1/contacts', { headers: { Authorization: `Bearer ${key}` }, csrf: false });
    assert.equal(ok.status, 200);
    assert.equal((await call('/api/v1/contacts', { method: 'POST', body: { phone: '9800011111' }, headers: { Authorization: `Bearer ${key}` }, csrf: false })).status, 403);
    assert.equal((await call('/api/v1/contacts', { headers: { Authorization: 'Bearer wak_invalid' }, csrf: false })).status, 401);
    const list = await call('/api/connectors/api-keys', { cookie: c });
    assert.ok(!JSON.stringify(list.json).includes(key));
  });
}
