import fs from 'node:fs/promises';
import { one, many, query, tx } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { toWaId, fromWaId } from '../lib/phone.js';
import { isWindowOpen } from '../lib/window.js';
import { logger } from '../lib/logger.js';
import { emit } from '../lib/hooks.js';
import { enqueue } from '../queue/index.js';
import { getClient } from '../whatsapp/client.js';
import { textPayload, mediaPayload, templatePayload } from '../whatsapp/payloads.js';
import { shouldApplyStatus } from '../whatsapp/parser.js';
import { describeMetaErrorCode } from '../whatsapp/metaErrors.js';
import { isSendLive, getSection } from './settings.js';
import { publish } from './realtime.js';
import { upsertByPhone } from './contacts.js';
import { getOrCreateConversation } from './conversations.js';

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];

export function previewOf(msg) {
  if (msg.body) return msg.body.slice(0, 120);
  if (msg.template_name) return `📄 Template: ${msg.template_name}`;
  const icons = { image: '📷 Photo', video: '🎥 Video', audio: '🎤 Audio', document: '📎 Document', sticker: '🏷️ Sticker', location: '📍 Location' };
  return icons[msg.type] || `[${msg.type}]`;
}

const MSG_SELECT = `
  SELECT m.*, u.name AS sender_name,
    (SELECT json_build_object('id', md.id, 'mime_type', md.mime_type, 'file_name', md.file_name, 'size_bytes', md.size_bytes, 'status', md.status)
       FROM media md WHERE md.message_id = m.id ORDER BY md.created_at LIMIT 1) AS media
  FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id`;

export async function getMessage(id) {
  return one(`${MSG_SELECT} WHERE m.id = $1`, [id]);
}

export async function listMessages(conversationId, { before, limit = 50 } = {}) {
  const vals = [conversationId, Math.min(200, limit)];
  let cond = '';
  if (before) {
    vals.push(before);
    cond = 'AND m.created_at < $3';
  }
  const rows = await many(`${MSG_SELECT} WHERE m.conversation_id = $1 ${cond} ORDER BY m.created_at DESC LIMIT $2`, vals);
  return rows.reverse();
}

function publishMessage(msg, conversation) {
  publish('message.new', { conversation_id: msg.conversation_id, assigned_to: conversation?.assigned_to ?? null, message: msg });
}

/* ───────────────────────── Inbound ───────────────────────── */

/**
 * Store an inbound message event. Returns { duplicate: true } if this wamid was already processed.
 */
export async function recordInbound(evt) {
  const result = await tx(async (client) => {
    const dedup = await client.query(`INSERT INTO processed_events (event_id, kind) VALUES ($1, 'message') ON CONFLICT DO NOTHING RETURNING event_id`, [
      `msg:${evt.waMessageId}`,
    ]);
    if (!dedup.rowCount) return { duplicate: true };

    const contact = await upsertByPhone(fromWaId(evt.from), { name: evt.profileName || undefined }, { source: 'whatsapp', client });
    const conv = await getOrCreateConversation(contact.id, client);

    let payload = {};
    if (evt.media) payload = { media: evt.media };
    if (evt.interactive) payload = { ...payload, interactive: evt.interactive };
    if (evt.reaction) payload = { ...payload, reaction: evt.reaction };
    if (evt.type === 'location' || evt.type === 'contacts' || evt.type === 'order') payload = { ...payload, raw: evt.raw };
    if (evt.errors) payload = { ...payload, errors: evt.errors };

    const { rows } = await client.query(
      `INSERT INTO messages (conversation_id, contact_id, direction, sender_type, type, body, payload, wa_message_id, reply_to_wa_id, status, created_at)
       VALUES ($1,$2,'in','contact',$3,$4,$5,$6,$7,'received',$8)
       ON CONFLICT (wa_message_id) DO NOTHING RETURNING *`,
      [conv.id, contact.id, evt.type, evt.text || null, payload, evt.waMessageId, evt.context?.replyTo || null, evt.timestamp],
    );
    const message = rows[0];
    if (!message) return { duplicate: true };

    let mediaRow = null;
    if (evt.media?.id) {
      const r = await client.query(`INSERT INTO media (message_id, wa_media_id, mime_type, file_name, sha256) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [
        message.id,
        evt.media.id,
        evt.media.mimeType,
        evt.media.fileName || null,
        evt.media.sha256 || null,
      ]);
      mediaRow = r.rows[0];
    }

    const reopen = conv.status === 'resolved';
    const isReaction = evt.type === 'reaction';
    await client.query(
      `UPDATE conversations SET
         unread_count = unread_count + $2,
         last_message_at = GREATEST(coalesce(last_message_at, $3), $3),
         last_message_preview = $4,
         last_inbound_at = GREATEST(coalesce(last_inbound_at, $3), $3),
         status = 'open', resolved_at = NULL,
         human_takeover = CASE WHEN $5 THEN false ELSE human_takeover END,
         updated_at = now()
       WHERE id = $1`,
      [conv.id, isReaction ? 0 : 1, evt.timestamp, previewOf(message), reopen],
    );
    await client.query(`UPDATE contacts SET last_inbound_at = GREATEST(coalesce(last_inbound_at, $2), $2), updated_at = now() WHERE id = $1`, [
      contact.id,
      evt.timestamp,
    ]);
    return { duplicate: false, message, contact, conversation: { ...conv, status: 'open' }, media: mediaRow, isNewContact: contact.inserted, isNewConversation: conv.inserted, reopened: reopen };
  });

  if (result.duplicate) return result;
  if (result.media) await enqueue('media', 'download', { mediaId: result.media.id }, { jobId: `media:${result.media.id}` });
  const full = await getMessage(result.message.id);
  publishMessage(full, result.conversation);
  publish('conversation.updated', { id: result.conversation.id, assigned_to: result.conversation.assigned_to });
  return { ...result, message: full };
}

/* ───────────────────────── Outbound ───────────────────────── */

/**
 * Queue an outbound message. kind: 'text' | 'template' | 'media' | 'interactive'.
 * Enforces the 24h window (non-template), and opt-out for business-initiated templates.
 * @param {object} p
 * @param {string} p.conversationId
 * @param {'text'|'template'|'media'|'interactive'} p.kind
 * @param {'agent'|'ai'|'automation'|'broadcast'|'api'|'system'} p.senderType
 * @param {string} [p.userId]
 * @param {string} [p.text]
 * @param {object} [p.template]  { name, language, components, values, headerValues, headerMedia, buttonValues, category }
 * @param {object} [p.media]     { mediaRowId, type, caption, filename }
 * @param {object} [p.interactive] Cloud API interactive payload (without `to`)
 * @param {string} [p.broadcastRecipientId]
 * @param {boolean} [p.skipWindowCheck]
 * @param {string} [p.replyTo]
 */
export async function queueOutbound(p) {
  const conv = await one(
    `SELECT c.*, ct.phone, ct.opted_out_at, ct.opted_in FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
    [p.conversationId],
  );
  if (!conv) throw notFound('Conversation not found');
  const windowOpen = isWindowOpen(conv.last_inbound_at);

  if (p.kind !== 'template' && !windowOpen && !p.skipWindowCheck) {
    throw badRequest('The 24-hour window is closed. Only an approved template can be sent to this customer.');
  }
  if (p.kind === 'template' && conv.opted_out_at && !windowOpen) {
    throw badRequest('This customer has opted out (STOP). Business-initiated templates are blocked.');
  }

  let type = p.kind;
  let body = null;
  let payload = {};
  let templateName = null;
  if (p.kind === 'text') {
    if (!p.text?.trim()) throw badRequest('Message is empty');
    body = p.text.trim().slice(0, 4096);
    type = 'text';
  } else if (p.kind === 'template') {
    const t = p.template;
    // Build now so missing variables fail fast (400) instead of in the worker.
    let api;
    try {
      api = templatePayload('0', t);
    } catch (err) {
      throw badRequest(err.message);
    }
    delete api.to;
    templateName = t.name;
    type = 'template';
    body = t.preview || null;
    payload = { api, template: { name: t.name, language: t.language, category: t.category } };
  } else if (p.kind === 'media') {
    if (!MEDIA_TYPES.includes(p.media?.type)) throw badRequest('Unsupported media type');
    type = p.media.type;
    body = p.media.caption || null;
    payload = { media_row_id: p.media.mediaRowId, caption: p.media.caption, filename: p.media.filename };
  } else if (p.kind === 'interactive') {
    type = 'interactive';
    body = p.interactive?.body?.text || null;
    payload = { api: { messaging_product: 'whatsapp', recipient_type: 'individual', type: 'interactive', interactive: p.interactive } };
  }

  const msg = await one(
    `INSERT INTO messages (conversation_id, contact_id, direction, sender_type, sender_user_id, type, body, payload, template_name,
                           status, broadcast_recipient_id, reply_to_wa_id)
     VALUES ($1,$2,'out',$3,$4,$5,$6,$7,$8,'queued',$9,$10) RETURNING *`,
    [conv.id, conv.contact_id, p.senderType, p.userId || null, type, body, payload, templateName, p.broadcastRecipientId || null, p.replyTo || null],
  );
  if (p.media?.mediaRowId) await query('UPDATE media SET message_id = $1 WHERE id = $2', [msg.id, p.media.mediaRowId]);

  const handler = p.senderType === 'ai' ? 'ai' : p.senderType === 'agent' ? 'human' : p.senderType === 'automation' ? 'automation' : null;
  await query(
    `UPDATE conversations SET last_message_at = now(), last_message_preview = $2,
       last_handler = COALESCE($3, last_handler),
       assigned_to = CASE WHEN $4::uuid IS NOT NULL AND assigned_to IS NULL THEN $4::uuid ELSE assigned_to END,
       updated_at = now() WHERE id = $1`,
    [conv.id, previewOf(msg), handler, p.senderType === 'agent' ? p.userId : null],
  );

  // Broadcast messages go through the rate-limited broadcast queue; everything else here.
  if (!p.broadcastRecipientId) await enqueue('outbound', 'send', { messageId: msg.id }, { jobId: `out:${msg.id}` });
  const full = await getMessage(msg.id);
  publishMessage(full, conv);
  return full;
}

async function setMessageStatus(id, status, extra = {}) {
  const sets = ['status = $2'];
  const vals = [id, status];
  for (const [k, v] of Object.entries(extra)) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  const m = await one(`UPDATE messages SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
  if (m) publish('message.status', { conversation_id: m.conversation_id, message_id: m.id, status: m.status, error_message: m.error_message });
  return m;
}

/**
 * Deliver one queued message (outbound worker). Honors "Send live":
 * real mode + send_live off -> held (never reaches the customer).
 */
export async function deliverMessage(messageId) {
  const msg = await one(`SELECT m.*, ct.phone FROM messages m JOIN contacts ct ON ct.id = m.contact_id WHERE m.id = $1`, [messageId]);
  if (!msg) return { skipped: 'missing' };
  if (!['queued'].includes(msg.status)) return { skipped: msg.status };

  const client = getClient();
  if (!client.isMock && !(await isSendLive())) {
    await setMessageStatus(msg.id, 'held', { error_message: '"Send live" is off — message was not delivered' });
    if (msg.broadcast_recipient_id) await query(`UPDATE broadcast_recipients SET status = 'skipped', skip_reason = 'send_live_off', updated_at = now() WHERE id = $1`, [msg.broadcast_recipient_id]);
    return { held: true };
  }

  const to = toWaId(msg.phone);
  let payload;
  if (msg.type === 'text') payload = textPayload(to, msg.body, { replyTo: msg.reply_to_wa_id || undefined });
  else if (msg.type === 'template' || msg.type === 'interactive') payload = { ...msg.payload.api, to };
  else if (MEDIA_TYPES.includes(msg.type)) {
    const media = await one('SELECT * FROM media WHERE id = $1', [msg.payload.media_row_id]);
    if (!media?.storage_path) throw Object.assign(new Error('Media file is missing'), { permanent: true });
    let waMediaId = media.wa_media_id;
    if (!waMediaId) {
      const buf = await fs.readFile(media.storage_path);
      waMediaId = (await client.uploadMedia(buf, media.mime_type, media.file_name)).id;
      await query('UPDATE media SET wa_media_id = $2 WHERE id = $1', [media.id, waMediaId]);
    }
    payload = mediaPayload(to, msg.type, { id: waMediaId, caption: msg.payload.caption, filename: msg.payload.filename || media.file_name });
  } else throw Object.assign(new Error(`Cannot send message type ${msg.type}`), { permanent: true });

  try {
    const { waMessageId } = await client.sendMessage(payload);
    await setMessageStatus(msg.id, 'sent', { wa_message_id: waMessageId, sent_at: new Date(), error_code: null, error_message: null });
    if (msg.broadcast_recipient_id) {
      await query(`UPDATE broadcast_recipients SET status = 'sent', wa_message_id = $2, message_id = $3, updated_at = now() WHERE id = $1`, [
        msg.broadcast_recipient_id,
        waMessageId,
        msg.id,
      ]);
    }
    if (client.isMock) scheduleMockStatuses(waMessageId);
    emit('message.sent', { message: { ...msg, wa_message_id: waMessageId } });
    return { waMessageId };
  } catch (err) {
    if (err.retryable && !err.permanent) {
      await query('UPDATE messages SET error_code = $2, error_message = $3 WHERE id = $1', [msg.id, err.code ? String(err.code) : null, `Retrying: ${err.message}`]);
      throw err;
    }
    await failMessage(msg, err);
    if (err.optOutMarketing) await query(`UPDATE contacts SET opted_in = false, opted_out_at = now() WHERE id = $1`, [msg.contact_id]);
    if (err.alertAdmins) publish('system.alert', { level: 'error', message: err.message });
    return { failed: true, error: err.message };
  }
}

export async function failMessage(msg, err) {
  await setMessageStatus(msg.id, 'failed', { error_code: err.code ? String(err.code) : null, error_message: String(err.message).slice(0, 1000) });
  if (msg.broadcast_recipient_id) {
    await query(`UPDATE broadcast_recipients SET status = 'failed', error_code = $2, error_message = $3, updated_at = now() WHERE id = $1`, [
      msg.broadcast_recipient_id,
      err.code ? String(err.code) : null,
      String(err.message).slice(0, 1000),
    ]);
  }
}

/** Demo mode: emulate Meta's delivered/read webhooks. */
function scheduleMockStatuses(waMessageId) {
  enqueue('inbound', 'mock-status', { waMessageId, status: 'delivered' }, { delayMs: 1500, attempts: 1 }).catch(() => {});
  enqueue('inbound', 'mock-status', { waMessageId, status: 'read' }, { delayMs: 4000, attempts: 1 }).catch(() => {});
}

/** Apply a delivery status webhook (sent / delivered / read / failed). Out-of-order safe and idempotent. */
export async function applyStatus(evt) {
  const msg = await one('SELECT * FROM messages WHERE wa_message_id = $1', [evt.waMessageId]);
  if (!msg) {
    // Status for a message we don't know (e.g. sent from another tool) — still update broadcast rows if any.
    logger.debug('status for unknown message', { wamid: evt.waMessageId });
    return { unknown: true };
  }
  if (!shouldApplyStatus(msg.status, evt.status)) return { ignored: true };
  const extra = {};
  if (evt.status === 'delivered') extra.delivered_at = evt.timestamp;
  if (evt.status === 'read') {
    extra.read_at = evt.timestamp;
    if (!msg.delivered_at) extra.delivered_at = evt.timestamp;
  }
  if (evt.status === 'failed') {
    const e = evt.errors?.[0] || {};
    extra.error_code = e.code ? String(e.code) : null;
    extra.error_message = describeMetaErrorCode(e.code) || e.error_data?.details || e.title || e.message || 'Delivery failed';
    if (Number(e.code) === 131050) await query(`UPDATE contacts SET opted_in = false, opted_out_at = now() WHERE id = $1`, [msg.contact_id]);
  }
  await setMessageStatus(msg.id, evt.status, extra);
  if (msg.broadcast_recipient_id) {
    await query(
      `UPDATE broadcast_recipients SET status = $2, error_code = COALESCE($3, error_code), error_message = COALESCE($4, error_message), updated_at = now()
        WHERE id = $1 AND (status <> 'read' OR $2 = 'read')`,
      [msg.broadcast_recipient_id, evt.status, extra.error_code ?? null, extra.error_message ?? null],
    );
    publish('broadcast.progress', { recipient_id: msg.broadcast_recipient_id });
  }
  emit('message.status', { message_id: msg.id, wa_message_id: evt.waMessageId, status: evt.status, conversation_id: msg.conversation_id, errors: evt.errors });
  return { applied: true };
}

/** Re-queue a failed or held message (agent action). */
export async function retryMessage(id) {
  const m = await one('SELECT * FROM messages WHERE id = $1', [id]);
  if (!m) throw notFound('Message not found');
  if (m.direction !== 'out' || !['failed', 'held'].includes(m.status)) throw badRequest('Only failed or held outgoing messages can be retried');
  await setMessageStatus(m.id, 'queued', { error_code: null, error_message: null });
  await enqueue('outbound', 'send', { messageId: m.id }, { jobId: `out:${m.id}:${Date.now()}` });
  return getMessage(m.id);
}

/** STOP / START keyword handling. Returns true when the message was an opt-out/opt-in command. */
export async function handleOptKeywords(message, contact) {
  if (message.type !== 'text' && message.type !== 'button' && message.type !== 'interactive') return false;
  const text = String(message.body || '').trim().toUpperCase().replace(/[.!]+$/, '');
  if (!text || text.length > 40) return false;
  const g = await getSection('general');
  const isOut = (g.opt_out_keywords || []).some((k) => k.toUpperCase() === text);
  const isIn = (g.opt_in_keywords || []).some((k) => k.toUpperCase() === text);
  if (!isOut && !isIn) return false;
  if (isOut) {
    await query(`UPDATE contacts SET opted_in = false, opted_out_at = now(), updated_at = now() WHERE id = $1`, [contact.id]);
    // Cancel any queued broadcast messages to this contact.
    await query(`UPDATE broadcast_recipients SET status = 'skipped', skip_reason = 'opted_out', updated_at = now() WHERE contact_id = $1 AND status IN ('pending','queued')`, [contact.id]);
    await query(`UPDATE conversations SET flow_state = NULL WHERE id = $1`, [message.conversation_id]);
    if (g.opt_out_reply) await queueOutbound({ conversationId: message.conversation_id, kind: 'text', text: g.opt_out_reply, senderType: 'system' });
  } else {
    await query(
      `UPDATE contacts SET opted_in = true, opt_in_source = 'whatsapp_keyword', opt_in_at = now(), opted_out_at = NULL, updated_at = now() WHERE id = $1`,
      [contact.id],
    );
    if (g.opt_in_reply) await queueOutbound({ conversationId: message.conversation_id, kind: 'text', text: g.opt_in_reply, senderType: 'system' });
  }
  publish('contact.updated', { id: contact.id });
  return true;
}
