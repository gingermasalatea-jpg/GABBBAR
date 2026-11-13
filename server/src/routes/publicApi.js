import { Router } from 'express';
import { one, many, query } from '../db/pool.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { z, body, queryParams } from '../lib/validate.js';
import { toE164 } from '../lib/phone.js';
import { isWindowOpen } from '../lib/window.js';
import { emit } from '../lib/hooks.js';
import { requireApiKey, requireScope } from '../middleware/apiKey.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as contacts from '../services/contacts.js';
import { getOrCreateConversation, decorate } from '../services/conversations.js';
import { queueOutbound } from '../services/messages.js';
import { sendTemplate } from '../services/templates.js';
import { audit } from '../services/audit.js';
import { sha256Hex } from '../lib/crypto.js';

/**
 * Public REST API v1 — authenticate with `Authorization: Bearer wak_...`.
 * Contacts are addressed by phone (any format; normalised to E.164).
 */
const r = Router();
r.use(requireApiKey);
r.use(rateLimit({ name: 'api-v1', windowMs: 60_000, max: 120, key: (req) => req.apiKey.id }));

async function phoneParam(req) {
  const e164 = toE164(decodeURIComponent(req.params.phone), await contacts.defaultCountryCode());
  if (!e164) throw badRequest('Invalid phone number');
  return e164;
}

const contactBody = z.object({
  phone: z.string().min(5).max(30),
  name: z.string().max(200).optional(),
  email: z.string().email().max(200).optional(),
  tags: z.array(z.string().max(60)).max(50).optional(),
  custom: z.record(z.any()).optional(),
});

r.get(
  '/contacts',
  requireScope('contacts:read'),
  ah(async (req, res) => {
    const q = queryParams(z.object({ search: z.string().max(100).optional(), tag: z.string().max(60).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) }), req);
    res.json(await contacts.listContacts(q));
  }),
);

r.get(
  '/contacts/:phone',
  requireScope('contacts:read'),
  ah(async (req, res) => {
    const c = await contacts.getContactByPhone(await phoneParam(req));
    if (!c) throw notFound('Contact not found');
    res.json({ contact: c });
  }),
);

/** Create or update by phone. */
r.post(
  '/contacts',
  requireScope('contacts:write'),
  ah(async (req, res) => {
    const d = body(contactBody, req);
    const phone = await contacts.normalizePhone(d.phone);
    const existing = await contacts.getContactByPhone(phone);
    const c = existing ? await contacts.updateContact(existing.id, d) : await contacts.createContact(d, { source: 'api' });
    emit(existing ? 'contact.updated' : 'contact.created', { contact: c });
    await audit({ req, action: existing ? 'api.contact_updated' : 'api.contact_created', entityType: 'contact', entityId: c.id });
    res.status(existing ? 200 : 201).json({ contact: c, created: !existing });
  }),
);

r.patch(
  '/contacts/:phone',
  requireScope('contacts:write'),
  ah(async (req, res) => {
    const c0 = await contacts.getContactByPhone(await phoneParam(req));
    if (!c0) throw notFound('Contact not found');
    const d = body(contactBody.partial().omit({ phone: true }), req);
    const c = await contacts.updateContact(c0.id, d);
    emit('contact.updated', { contact: c });
    res.json({ contact: c });
  }),
);

/** Record WhatsApp consent collected by your website / CRM. `source` describes where. */
r.post(
  '/contacts/:phone/opt-in',
  requireScope('contacts:write'),
  ah(async (req, res) => {
    const { source, name } = body(z.object({ source: z.string().min(2).max(100), name: z.string().max(200).optional() }), req);
    const phone = await phoneParam(req);
    const c0 = await contacts.upsertByPhone(phone, { name }, { source: 'api' });
    const c = await contacts.setOptIn(c0.id, true, `api:${source}`);
    await audit({ req, action: 'api.contact_opted_in', entityType: 'contact', entityId: c.id, meta: { source } });
    res.json({ contact: c });
  }),
);

r.post(
  '/contacts/:phone/opt-out',
  requireScope('contacts:write'),
  ah(async (req, res) => {
    const c0 = await contacts.getContactByPhone(await phoneParam(req));
    if (!c0) throw notFound('Contact not found');
    res.json({ contact: await contacts.setOptIn(c0.id, false) });
  }),
);

/** Send an approved template. Only to customers who opted in or are inside the 24h window — no cold messaging. */
r.post(
  '/messages/template',
  requireScope('messages:send'),
  ah(async (req, res) => {
    const d = body(
      z.object({
        phone: z.string().min(5).max(30),
        template_name: z.string().max(512),
        language: z.string().max(10).default('en'),
        variables: z.array(z.string().max(1024)).default([]),
        header_values: z.array(z.string().max(60)).default([]),
        header_media_url: z.string().url().optional(),
        idempotency_key: z.string().max(100).optional(),
      }),
      req,
    );
    const phone = await contacts.normalizePhone(d.phone);
    const contact = await contacts.getContactByPhone(phone);
    if (!contact) throw badRequest('Unknown contact. Create the contact and record opt-in first.');
    if (!(contact.opted_in || isWindowOpen(contact.last_inbound_at))) throw badRequest('Contact has not opted in to WhatsApp messages');
    if (contact.opted_out_at && !isWindowOpen(contact.last_inbound_at)) throw badRequest('Contact has opted out');
    const tpl = await one(`SELECT id FROM templates WHERE name = $1 AND language = $2 AND status = 'APPROVED'`, [d.template_name, d.language]);
    if (!tpl) throw badRequest(`No APPROVED template "${d.template_name}" (${d.language})`);
    if (d.idempotency_key) {
      const ins = await query(`INSERT INTO processed_events (event_id, kind) VALUES ($1,'api_send') ON CONFLICT DO NOTHING`, [`api:${req.apiKey.id}:${sha256Hex(d.idempotency_key)}`]);
      if (!ins.rowCount) return res.status(409).json({ error: 'Duplicate idempotency_key — message already accepted' });
    }
    const conv = await getOrCreateConversation(contact.id);
    const message = await sendTemplate({
      conversationId: conv.id,
      templateId: tpl.id,
      variables: d.variables,
      headerValues: d.header_values,
      headerMedia: d.header_media_url ? { link: d.header_media_url } : undefined,
      senderType: 'api',
    });
    res.status(202).json({ message: { id: message.id, status: message.status } });
  }),
);

r.post(
  '/messages/text',
  requireScope('messages:send'),
  ah(async (req, res) => {
    const d = body(z.object({ phone: z.string().min(5).max(30), text: z.string().min(1).max(4096) }), req);
    const contact = await contacts.getContactByPhone(await contacts.normalizePhone(d.phone));
    if (!contact) throw notFound('Contact not found');
    const conv = await getOrCreateConversation(contact.id);
    const message = await queueOutbound({ conversationId: conv.id, kind: 'text', text: d.text, senderType: 'api' });
    res.status(202).json({ message: { id: message.id, status: message.status } });
  }),
);

r.get(
  '/messages/:id',
  requireScope('messages:send'),
  ah(async (req, res) => {
    const m = await one(`SELECT id, status, error_code, error_message, sent_at, delivered_at, read_at, created_at FROM messages WHERE id = $1 AND sender_type = 'api'`, [req.params.id]);
    if (!m) throw notFound('Message not found');
    res.json({ message: m });
  }),
);

r.get(
  '/conversations',
  requireScope('conversations:read'),
  ah(async (req, res) => {
    const q = queryParams(z.object({ status: z.enum(['open', 'resolved']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req);
    const rows = await many(
      `SELECT c.id, c.status, c.assigned_to, c.unread_count, c.last_message_at, c.last_message_preview, c.last_inbound_at, c.last_handler,
              ct.phone, ct.name FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
        ${q.status ? 'WHERE c.status = $2' : ''} ORDER BY c.last_message_at DESC NULLS LAST LIMIT $1`,
      q.status ? [q.limit, q.status] : [q.limit],
    );
    res.json({ conversations: rows.map(decorate) });
  }),
);

r.get(
  '/templates',
  requireScope('templates:read'),
  ah(async (_req, res) => {
    res.json({ templates: await many(`SELECT name, language, category, status, components FROM templates WHERE status = 'APPROVED' ORDER BY name`) });
  }),
);

export default r;
