import { Router } from 'express';
import { one, many, query } from '../db/pool.js';
import { ah, notFound, badRequest } from '../lib/errors.js';
import { z, body, queryParams, uuid } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { can } from '../lib/permissions.js';
import * as convs from '../services/conversations.js';
import * as messages from '../services/messages.js';
import { saveOutboundUpload } from '../services/media.js';
import { getClient } from '../whatsapp/client.js';
import { isSendLive } from '../services/settings.js';
import { publish } from '../services/realtime.js';
import { audit } from '../services/audit.js';
import { emit } from '../lib/hooks.js';
import { runForMessage } from '../ai/assistant.js';

const r = Router();

async function load(req) {
  const conv = await convs.getConversation(req.params.id);
  convs.assertCanSee(req.user, conv);
  return conv;
}

r.get(
  '/',
  requirePermission('inbox.view'),
  ah(async (req, res) => {
    const q = queryParams(
      z.object({
        filter: z.enum(['all', 'open', 'resolved', 'unread', 'mine', 'unassigned', 'ai', 'human', 'takeover']).default('open'),
        search: z.string().max(100).optional(),
        label: uuid.optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(40),
      }),
      req,
    );
    res.json(await convs.listConversations(req.user, q));
  }),
);

/** Find (or start) the conversation for a contact — used from the contacts page. */
r.get(
  '/by-contact/:contactId',
  requirePermission('inbox.view'),
  ah(async (req, res) => {
    const c = await one('SELECT id FROM contacts WHERE id = $1', [req.params.contactId]);
    if (!c) throw notFound('Contact not found');
    const conv = await convs.getOrCreateConversation(c.id);
    res.json({ conversation: await convs.getConversation(conv.id) });
  }),
);

r.get(
  '/:id',
  requirePermission('inbox.view'),
  ah(async (req, res) => {
    const conv = await load(req);
    const contact = await one('SELECT * FROM contacts WHERE id = $1', [conv.contact_id]);
    const fields = await many('SELECT key, label, type, internal FROM custom_fields ORDER BY created_at');
    const tickets = await many(`SELECT id, subject, status, priority, source, created_at FROM tickets WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 10`, [conv.contact_id]);
    res.json({ conversation: conv, contact, fields, tickets, sendLive: await isSendLive(), mock: getClient().isMock });
  }),
);

r.patch(
  '/:id',
  requirePermission('inbox.view'),
  ah(async (req, res) => {
    const data = body(
      z.object({
        status: z.enum(['open', 'resolved']).optional(),
        assigned_to: uuid.nullable().optional(),
        ai_mode_override: z.enum(['off', 'suggest', 'auto']).nullable().optional(),
      }),
      req,
    );
    await load(req);
    if (data.assigned_to !== undefined && !can(req.user.role, 'inbox.assign')) throw badRequest('You cannot assign conversations');
    if ((data.status || data.ai_mode_override !== undefined) && !can(req.user.role, 'inbox.reply')) throw badRequest('Read-only access');
    // Agents may assign only to themselves or unassign themselves; admins assign anyone.
    if (data.assigned_to && data.assigned_to !== req.user.id && !can(req.user.role, 'inbox.view_all')) {
      throw badRequest('Agents can only assign conversations to themselves');
    }
    const conv = await convs.updateConversation(req.params.id, data, req.user);
    await audit({ req, action: 'conversation.updated', entityType: 'conversation', entityId: conv.id, meta: data });
    res.json({ conversation: conv });
  }),
);

r.post(
  '/:id/takeover',
  requirePermission('inbox.takeover'),
  ah(async (req, res) => {
    await load(req);
    const conv = await convs.takeover(req.params.id, req.user.id);
    await audit({ req, action: 'conversation.takeover', entityType: 'conversation', entityId: conv.id });
    res.json({ conversation: conv });
  }),
);

r.post(
  '/:id/release',
  requirePermission('inbox.takeover'),
  ah(async (req, res) => {
    await load(req);
    const conv = await convs.release(req.params.id);
    await audit({ req, action: 'conversation.released', entityType: 'conversation', entityId: conv.id });
    res.json({ conversation: conv });
  }),
);

r.post(
  '/:id/read',
  requirePermission('inbox.view'),
  ah(async (req, res) => {
    const conv = await load(req);
    await convs.markRead(conv.id);
    // Blue ticks for the customer only when we're live and an agent can reply.
    if (can(req.user.role, 'inbox.reply') && (await isSendLive())) {
      const last = await one(`SELECT wa_message_id FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1`, [conv.id]);
      if (last?.wa_message_id) getClient().markRead(last.wa_message_id).catch(() => {});
    }
    res.json({ ok: true });
  }),
);

r.get(
  '/:id/messages',
  requirePermission('inbox.view'),
  ah(async (req, res) => {
    await load(req);
    const q = queryParams(z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(60) }), req);
    const rows = await messages.listMessages(req.params.id, q);
    const notes = await many(
      `SELECT n.*, u.name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.conversation_id = $1 ORDER BY n.created_at`,
      [req.params.id],
    );
    res.json({ messages: rows, notes });
  }),
);

r.post(
  '/:id/messages',
  requirePermission('inbox.reply'),
  ah(async (req, res) => {
    const conv = await load(req);
    const data = body(
      z.object({
        text: z.string().max(4096).optional(),
        reply_to: z.string().max(200).optional(),
        media: z
          .object({ base64: z.string().min(1).max(140_000_000), mime_type: z.string().max(120), file_name: z.string().max(240).optional(), caption: z.string().max(1024).optional() })
          .optional(),
        buttons: z.array(z.object({ id: z.string().max(256), title: z.string().min(1).max(20) })).max(3).optional(),
      }),
      req,
    );
    let msg;
    if (data.media) {
      const { media, type } = await saveOutboundUpload({ base64: data.media.base64, mimeType: data.media.mime_type, fileName: data.media.file_name });
      msg = await messages.queueOutbound({
        conversationId: conv.id,
        kind: 'media',
        senderType: 'agent',
        userId: req.user.id,
        media: { mediaRowId: media.id, type, caption: data.media.caption, filename: data.media.file_name },
      });
    } else if (data.buttons?.length) {
      msg = await messages.queueOutbound({
        conversationId: conv.id,
        kind: 'interactive',
        senderType: 'agent',
        userId: req.user.id,
        interactive: { type: 'button', body: { text: data.text || '' }, action: { buttons: data.buttons.map((b) => ({ type: 'reply', reply: b })) } },
      });
    } else {
      msg = await messages.queueOutbound({ conversationId: conv.id, kind: 'text', text: data.text, senderType: 'agent', userId: req.user.id, replyTo: data.reply_to });
    }
    // An agent reply clears unread and counts as handled by a human.
    await query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [conv.id]);
    emit('agent.replied', { conversation: conv, message: msg, user: req.user });
    res.status(201).json({ message: msg });
  }),
);

r.post(
  '/:id/messages/:messageId/retry',
  requirePermission('inbox.reply'),
  ah(async (req, res) => {
    await load(req);
    const m = await one('SELECT conversation_id FROM messages WHERE id = $1', [req.params.messageId]);
    if (!m || m.conversation_id !== req.params.id) throw notFound('Message not found');
    res.json({ message: await messages.retryMessage(req.params.messageId) });
  }),
);

/** Ask the AI for a suggested reply to the latest customer message (never sends). */
r.post(
  '/:id/ai-suggest',
  requirePermission('inbox.reply'),
  ah(async (req, res) => {
    const conv = await load(req);
    const result = await runForMessage({ conversationId: conv.id, force: true });
    res.json({ suggestion: result.decision === 'suggested' ? { text: result.reply, knowledge: result.knowledge, log_id: result.logId } : { text: null, reason: result.reason } });
  }),
);

r.post(
  '/:id/notes',
  requirePermission('notes.write'),
  ah(async (req, res) => {
    const conv = await load(req);
    const { body: text } = body(z.object({ body: z.string().trim().min(1).max(5000) }), req);
    const note = await one(`INSERT INTO notes (conversation_id, user_id, body) VALUES ($1,$2,$3) RETURNING *`, [conv.id, req.user.id, text]);
    const full = { ...note, user_name: req.user.name };
    publish('note.new', { conversation_id: conv.id, assigned_to: conv.assigned_to, note: full });
    res.status(201).json({ note: full });
  }),
);

r.put(
  '/:id/labels',
  requirePermission('inbox.reply'),
  ah(async (req, res) => {
    await load(req);
    const { label_ids } = body(z.object({ label_ids: z.array(uuid).max(20) }), req);
    res.json({ conversation: await convs.setLabels(req.params.id, label_ids) });
  }),
);

/* ───── Labels ───── */
export const labelsRouter = Router();

labelsRouter.get('/', requirePermission('inbox.view'), ah(async (_req, res) => res.json({ labels: await many('SELECT * FROM labels ORDER BY name') })));

labelsRouter.post(
  '/',
  requirePermission('inbox.assign'),
  ah(async (req, res) => {
    const d = body(z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#22c55e') }), req);
    const l = await one('INSERT INTO labels (name, color) VALUES ($1,$2) RETURNING *', [d.name, d.color]);
    res.status(201).json({ label: l });
  }),
);

labelsRouter.delete(
  '/:id',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    await query('DELETE FROM labels WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }),
);

export default r;
