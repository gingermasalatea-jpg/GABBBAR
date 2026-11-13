import { one, many, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { toE164 } from '../lib/phone.js';
import { logger } from '../lib/logger.js';
import { enqueue } from '../queue/index.js';
import { publish } from './realtime.js';
import { defaultCountryCode } from './contacts.js';
import { getOrCreateConversation } from './conversations.js';
import { sendTemplate } from './templates.js';
import { deliverMessage, failMessage } from './messages.js';

/**
 * Audience shapes:
 *   { type: 'all' }
 *   { type: 'tags', tags: [...], match: 'any'|'all' }
 *   { type: 'filter', field: 'custom.city'|'name'|..., operator: 'equals'|'contains'|'not_equals', value, tags?: [] }
 *   { type: 'csv', phones: [...] }
 * Only contacts who opted in (and have not opted out) are messaged. Everyone else is recorded as skipped.
 */

const SAFE_FIELD = /^(name|email|custom\.[a-z][a-z0-9_]{0,48})$/;

async function audienceWhere(audience, vals) {
  const push = (v) => {
    vals.push(v);
    return `$${vals.length}`;
  };
  switch (audience.type) {
    case 'all':
      return 'TRUE';
    case 'tags': {
      const tags = (audience.tags || []).map((t) => String(t).toLowerCase());
      if (!tags.length) throw badRequest('Choose at least one tag');
      return audience.match === 'all' ? `c.tags @> ${push(tags)}::text[]` : `c.tags && ${push(tags)}::text[]`;
    }
    case 'filter': {
      if (!SAFE_FIELD.test(audience.field || '')) throw badRequest('Invalid filter field');
      const col = audience.field.startsWith('custom.') ? `(c.custom->>${push(audience.field.slice(7))})` : `c.${audience.field}`;
      const v = String(audience.value ?? '');
      let cond;
      if (audience.operator === 'contains') cond = `lower(coalesce(${col},'')) LIKE ${push(`%${v.toLowerCase()}%`)}`;
      else if (audience.operator === 'not_equals') cond = `lower(coalesce(${col},'')) <> ${push(v.toLowerCase())}`;
      else cond = `lower(coalesce(${col},'')) = ${push(v.toLowerCase())}`;
      if (audience.tags?.length) cond += ` AND c.tags && ${push(audience.tags.map((t) => String(t).toLowerCase()))}::text[]`;
      return cond;
    }
    case 'csv': {
      const cc = await defaultCountryCode();
      const phones = [...new Set((audience.phones || []).map((p) => toE164(p, cc)).filter(Boolean))];
      if (!phones.length) throw badRequest('No valid phone numbers in the list');
      return `c.phone = ANY(${push(phones)}::text[])`;
    }
    default:
      throw badRequest('Unknown audience type');
  }
}

export async function previewAudience(audience) {
  const vals = [];
  const where = await audienceWhere(audience, vals);
  const r = await one(
    `SELECT count(*)::int AS matched,
            count(*) FILTER (WHERE c.opted_in AND c.opted_out_at IS NULL)::int AS eligible,
            count(*) FILTER (WHERE c.opted_out_at IS NOT NULL)::int AS opted_out,
            count(*) FILTER (WHERE NOT c.opted_in AND c.opted_out_at IS NULL)::int AS no_consent
       FROM contacts c WHERE ${where}`,
    vals,
  );
  let unknown = 0;
  if (audience.type === 'csv') {
    const cc = await defaultCountryCode();
    const phones = new Set((audience.phones || []).map((p) => toE164(p, cc)).filter(Boolean));
    unknown = phones.size - r.matched;
  }
  return { ...r, unknown_numbers: unknown };
}

export async function listBroadcasts() {
  return many(`
    SELECT b.*, t.name AS template_name, t.language AS template_language, u.name AS created_by_name,
      (SELECT json_build_object(
          'total', count(*), 'pending', count(*) FILTER (WHERE r.status IN ('pending','queued')),
          'sent', count(*) FILTER (WHERE r.status IN ('sent','delivered','read')),
          'delivered', count(*) FILTER (WHERE r.status IN ('delivered','read')),
          'read', count(*) FILTER (WHERE r.status = 'read'),
          'failed', count(*) FILTER (WHERE r.status = 'failed'),
          'skipped', count(*) FILTER (WHERE r.status = 'skipped'))
        FROM broadcast_recipients r WHERE r.broadcast_id = b.id) AS stats
    FROM broadcasts b JOIN templates t ON t.id = b.template_id LEFT JOIN users u ON u.id = b.created_by
    ORDER BY b.created_at DESC LIMIT 200`);
}

export async function getBroadcast(id) {
  const b = await one(`SELECT b.*, t.name AS template_name, t.language AS template_language, t.components AS template_components FROM broadcasts b JOIN templates t ON t.id = b.template_id WHERE b.id = $1`, [id]);
  if (!b) throw notFound('Broadcast not found');
  const stats = await one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status IN ('pending','queued'))::int AS pending,
            count(*) FILTER (WHERE status IN ('sent','delivered','read'))::int AS sent,
            count(*) FILTER (WHERE status IN ('delivered','read'))::int AS delivered,
            count(*) FILTER (WHERE status = 'read')::int AS read,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped
       FROM broadcast_recipients WHERE broadcast_id = $1`,
    [id],
  );
  const failures = await many(
    `SELECT coalesce(error_message, skip_reason, 'unknown') AS reason, count(*)::int AS count FROM broadcast_recipients
      WHERE broadcast_id = $1 AND status IN ('failed','skipped') GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    [id],
  );
  return { ...b, stats, failures };
}

export async function createBroadcast(data, userId) {
  const t = await one('SELECT * FROM templates WHERE id = $1', [data.template_id]);
  if (!t) throw badRequest('Template not found');
  if (t.status !== 'APPROVED') throw badRequest('Only APPROVED templates can be broadcast');
  const header = t.components.find((c) => c.type === 'HEADER');
  if (header && header.format !== 'TEXT' && !data.header_media_url) throw badRequest(`This template needs a ${header.format.toLowerCase()} URL for its header`);
  await previewAudience(data.audience); // validates the audience
  return one(
    `INSERT INTO broadcasts (name, template_id, template_variables, header_media_url, audience, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [data.name, data.template_id, data.template_variables || {}, data.header_media_url || null, data.audience, userId],
  );
}

export async function scheduleBroadcast(id, scheduledAt) {
  const b = await getBroadcast(id);
  if (!['draft', 'scheduled'].includes(b.status)) throw badRequest(`Broadcast is ${b.status}`);
  const at = scheduledAt ? new Date(scheduledAt) : new Date();
  if (Number.isNaN(at.getTime())) throw badRequest('Invalid schedule time');
  const delay = Math.max(0, at.getTime() - Date.now());
  await query(`UPDATE broadcasts SET status = 'scheduled', scheduled_at = $2, updated_at = now() WHERE id = $1`, [id, at]);
  await enqueue('broadcast', 'start', { broadcastId: id }, { jobId: `bc-start:${id}:${at.getTime()}`, delayMs: delay });
  return getBroadcast(id);
}

export async function cancelBroadcast(id) {
  const r = await query(`UPDATE broadcasts SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1 AND status IN ('draft','scheduled','running')`, [id]);
  if (!r.rowCount) throw badRequest('Broadcast cannot be cancelled now');
  await query(`UPDATE broadcast_recipients SET status = 'skipped', skip_reason = 'cancelled', updated_at = now() WHERE broadcast_id = $1 AND status IN ('pending','queued')`, [id]);
  publish('broadcast.progress', { broadcast_id: id });
}

/** Job: resolve the audience into recipient rows and queue each one through the rate-limited queue. */
export async function startBroadcast(id, scheduledAtMs) {
  const b = await one('SELECT * FROM broadcasts WHERE id = $1', [id]);
  if (!b || b.status !== 'scheduled') return;
  if (scheduledAtMs && b.scheduled_at && new Date(b.scheduled_at).getTime() !== scheduledAtMs) return; // rescheduled
  const vals = [id];
  const where = await audienceWhere(b.audience, vals);
  await query(
    `INSERT INTO broadcast_recipients (broadcast_id, contact_id, phone, status, skip_reason)
     SELECT $1, c.id, c.phone,
            CASE WHEN c.opted_in AND c.opted_out_at IS NULL THEN 'pending' ELSE 'skipped' END,
            CASE WHEN c.opted_out_at IS NOT NULL THEN 'opted_out' WHEN NOT c.opted_in THEN 'not_opted_in' ELSE NULL END
       FROM contacts c WHERE ${where}
     ON CONFLICT (broadcast_id, phone) DO NOTHING`,
    vals,
  );
  await query(`UPDATE broadcasts SET status = 'running', started_at = now(), updated_at = now() WHERE id = $1`, [id]);
  const pending = await many(`SELECT id FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'pending' ORDER BY phone`, [id]);
  for (const r of pending) {
    await query(`UPDATE broadcast_recipients SET status = 'queued' WHERE id = $1`, [r.id]);
    await enqueue('broadcast', 'send-one', { recipientId: r.id }, { jobId: `bc:${r.id}` });
  }
  logger.info(`Broadcast ${id} started`, { recipients: pending.length });
  publish('broadcast.progress', { broadcast_id: id });
  await finalizeIfDone(id);
}

/** Job: send one recipient (rate limited by the broadcast queue limiter). */
export async function sendOne(recipientId, attempt) {
  const r = await one(
    `SELECT r.*, b.status AS b_status, b.template_id, b.template_variables, b.header_media_url
       FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id WHERE r.id = $1`,
    [recipientId],
  );
  if (!r || !['queued', 'pending'].includes(r.status)) return;
  if (r.b_status !== 'running') {
    await query(`UPDATE broadcast_recipients SET status = 'skipped', skip_reason = 'cancelled', updated_at = now() WHERE id = $1`, [r.id]);
    return finalizeIfDone(r.broadcast_id);
  }
  const contact = await one('SELECT * FROM contacts WHERE id = $1', [r.contact_id]);
  if (!contact || !contact.opted_in || contact.opted_out_at) {
    await query(`UPDATE broadcast_recipients SET status = 'skipped', skip_reason = 'opted_out', updated_at = now() WHERE id = $1`, [r.id]);
    return finalizeIfDone(r.broadcast_id);
  }
  await query(`UPDATE broadcast_recipients SET attempts = $2 WHERE id = $1`, [r.id, attempt]);

  let messageId = r.message_id;
  if (!messageId) {
    const conv = await getOrCreateConversation(contact.id);
    try {
      const msg = await sendTemplate({
        conversationId: conv.id,
        templateId: r.template_id,
        variables: r.template_variables,
        headerMedia: r.header_media_url ? { link: r.header_media_url } : undefined,
        senderType: 'broadcast',
        broadcastRecipientId: r.id,
      });
      messageId = msg.id;
      await query(`UPDATE broadcast_recipients SET message_id = $2 WHERE id = $1`, [r.id, messageId]);
    } catch (err) {
      await query(`UPDATE broadcast_recipients SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, [r.id, String(err.message).slice(0, 500)]);
      return finalizeIfDone(r.broadcast_id);
    }
  }
  try {
    await deliverMessage(messageId);
  } catch (err) {
    if (attempt >= 6 || err.permanent) {
      await failMessage({ id: messageId, broadcast_recipient_id: r.id }, err);
      await finalizeIfDone(r.broadcast_id);
    }
    throw err; // retried with backoff by the queue (Meta throttling etc.)
  }
  publish('broadcast.progress', { broadcast_id: r.broadcast_id });
  await finalizeIfDone(r.broadcast_id);
}

async function finalizeIfDone(id) {
  const r = await query(
    `UPDATE broadcasts SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'running'
        AND NOT EXISTS (SELECT 1 FROM broadcast_recipients WHERE broadcast_id = $1 AND status IN ('pending','queued'))`,
    [id],
  );
  if (r.rowCount) publish('broadcast.progress', { broadcast_id: id, completed: true });
}

export async function listRecipients(id, { status, page = 1, limit = 100 }) {
  const vals = [id];
  let w = 'r.broadcast_id = $1';
  if (status) {
    vals.push(status);
    w += ` AND r.status = $${vals.length}`;
  }
  vals.push(limit, (page - 1) * limit);
  return many(
    `SELECT r.*, c.name FROM broadcast_recipients r LEFT JOIN contacts c ON c.id = r.contact_id WHERE ${w}
      ORDER BY r.updated_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals,
  );
}
