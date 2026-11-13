import { Router } from 'express';
import { one, query } from '../db/pool.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { z, body } from '../lib/validate.js';
import { sha256Hex } from '../lib/crypto.js';
import { isWindowOpen } from '../lib/window.js';
import { emit } from '../lib/hooks.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as contacts from '../services/contacts.js';
import { getOrCreateConversation } from '../services/conversations.js';
import { sendTemplate } from '../services/templates.js';
import { audit } from '../services/audit.js';

/**
 * Inbound webhooks: POST /api/hooks/in/<token>
 * Body: { phone, name?, email?, tags?, custom?, variables?: string[], consent_source? }
 */
const r = Router();

r.post(
  '/:token',
  rateLimit({ name: 'hooks-in', windowMs: 60_000, max: 120, key: (req) => sha256Hex(req.params.token).slice(0, 16) }),
  ah(async (req, res) => {
    const hook = await one(`SELECT * FROM webhooks WHERE direction = 'in' AND token_hash = $1`, [sha256Hex(req.params.token)]);
    if (!hook || !hook.is_active) throw notFound('Unknown webhook');
    const d = body(
      z.object({
        phone: z.string().min(5).max(30),
        name: z.string().max(200).optional(),
        email: z.string().email().max(200).optional(),
        tags: z.array(z.string().max(60)).max(20).optional(),
        custom: z.record(z.any()).optional(),
        variables: z.array(z.string().max(1024)).max(20).optional(),
        consent_source: z.string().max(100).optional(),
      }),
      req,
    );
    const action = hook.action || {};
    const phone = await contacts.normalizePhone(d.phone);
    let contact = await contacts.getContactByPhone(phone);
    const tags = contacts.cleanTags([...(d.tags || []), ...(action.add_tags || [])]);
    const custom = await contacts.cleanCustom(d.custom || {}, { ignoreUnknown: true });
    if (contact) contact = await contacts.updateContact(contact.id, { name: d.name ?? contact.name, email: d.email ?? contact.email, tags: [...contact.tags, ...tags], custom });
    else contact = await contacts.createContact({ phone, name: d.name, email: d.email, tags, custom }, { source: `webhook:${hook.name}` });
    if (action.mark_opted_in && d.consent_source) contact = await contacts.setOptIn(contact.id, true, `webhook:${d.consent_source}`);
    emit('contact.updated', { contact });

    let messageId = null;
    if (action.type === 'send_template') {
      if (!(contact.opted_in || isWindowOpen(contact.last_inbound_at))) throw badRequest('Contact has not opted in — template not sent');
      const conv = await getOrCreateConversation(contact.id);
      const msg = await sendTemplate({ conversationId: conv.id, templateId: action.template_id, variables: d.variables || [], senderType: 'api' });
      messageId = msg.id;
    }
    await query(`UPDATE webhooks SET last_status = '200 OK', last_called_at = now() WHERE id = $1`, [hook.id]);
    await audit({ req, actorType: 'system', actorLabel: `inbound webhook: ${hook.name}`, action: 'webhook.inbound', entityType: 'contact', entityId: contact.id });
    res.json({ ok: true, contact_id: contact.id, message_id: messageId });
  }),
);

export default r;
