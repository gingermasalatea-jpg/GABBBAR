import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { one, many, query } from '../db/pool.js';
import { hmacSha256Hex } from '../lib/crypto.js';
import { customerSafeContact } from '../lib/templateVars.js';
import { enqueue } from '../queue/index.js';
import { decryptValue } from './settings.js';
import { listCustomFields } from './contacts.js';

export const OUTBOUND_EVENTS = [
  'message.received',
  'message.sent',
  'message.status',
  'contact.created',
  'contact.updated',
  'conversation.resolved',
  'ticket.created',
];

/** Block SSRF to private/internal addresses in production. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
  }
  return true;
}

export async function assertSafeUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw Object.assign(new Error('Invalid URL'), { permanent: true });
  }
  if (!['https:', 'http:'].includes(u.protocol)) throw Object.assign(new Error('Only http(s) URLs are allowed'), { permanent: true });
  if (config.isProd) {
    if (u.protocol !== 'https:') throw Object.assign(new Error('Webhook URLs must use https in production'), { permanent: true });
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (addrs.some((a) => isPrivateAddress(a.address))) throw Object.assign(new Error('Webhook URL resolves to a private address'), { permanent: true });
  }
}

/** Strip internal custom fields from any contact object in the payload. */
async function sanitize(data) {
  const defs = await listCustomFields();
  const clean = (c) => (c && c.phone ? { id: c.id, ...customerSafeContact(c, defs), opted_in: c.opted_in, created_at: c.created_at } : c);
  const out = { ...data };
  if (out.contact) out.contact = clean(out.contact);
  if (out.message) {
    const { payload: _p, ...m } = out.message;
    out.message = m;
  }
  if (out.conversation) {
    const { flow_state: _f, ...c } = out.conversation;
    out.conversation = c;
  }
  return out;
}

/** Fan an event out to every active outbound webhook subscribed to it. */
export async function emitWebhookEvent(event, data) {
  const hooks = await many(`SELECT id FROM webhooks WHERE direction = 'out' AND is_active AND $1 = ANY(events)`, [event]);
  if (!hooks.length) return;
  const payload = { event, timestamp: new Date().toISOString(), data: await sanitize(data) };
  for (const h of hooks) {
    const d = await one(`INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1,$2,$3) RETURNING id`, [h.id, event, payload]);
    await enqueue('webhooks', 'deliver', { deliveryId: d.id }, { jobId: `whd:${d.id}` });
  }
}

export async function deliver(deliveryId, attempt) {
  const d = await one(
    `SELECT d.*, w.url, w.secret_enc, w.is_active FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = $1`,
    [deliveryId],
  );
  if (!d || !d.is_active || d.status === 'success') return;
  await assertSafeUrl(d.url);
  const body = JSON.stringify(d.payload);
  const secret = d.secret_enc ? decryptValue(d.secret_enc) : '';
  let res;
  try {
    res = await fetch(d.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Gabbbar-Webhooks/1.0',
        'X-Gabbbar-Event': d.event,
        'X-Gabbbar-Delivery': String(d.id),
        ...(secret ? { 'X-Gabbbar-Signature': `sha256=${hmacSha256Hex(secret, body)}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    await query(`UPDATE webhook_deliveries SET attempts = $2, error = $3, updated_at = now() WHERE id = $1`, [d.id, attempt, err.message]);
    throw err;
  }
  const ok = res.status >= 200 && res.status < 300;
  await query(`UPDATE webhook_deliveries SET status = $2, response_code = $3, attempts = $4, error = $5, updated_at = now() WHERE id = $1`, [
    d.id,
    ok ? 'success' : 'pending',
    res.status,
    attempt,
    ok ? null : `HTTP ${res.status}`,
  ]);
  await query(`UPDATE webhooks SET last_status = $2, last_called_at = now() WHERE id = $1`, [d.webhook_id, ok ? `${res.status} OK` : `HTTP ${res.status}`]);
  if (!ok) {
    const err = new Error(`Webhook responded ${res.status}`);
    if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) err.permanent = true;
    throw err;
  }
}

export async function markDeliveryFailed(deliveryId) {
  await query(`UPDATE webhook_deliveries SET status = 'failed', updated_at = now() WHERE id = $1 AND status <> 'success'`, [deliveryId]);
}
