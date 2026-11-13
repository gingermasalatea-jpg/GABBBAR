import { one, many, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { buildTemplateValues, customerSafeContact } from '../lib/templateVars.js';
import { getClient } from '../whatsapp/client.js';
import { validateTemplateComponents, renderTemplatePreview } from '../whatsapp/payloads.js';
import { enqueue } from '../queue/index.js';
import { publish } from './realtime.js';
import { listCustomFields } from './contacts.js';
import { queueOutbound } from './messages.js';

export async function listTemplates({ status } = {}) {
  return status
    ? many('SELECT * FROM templates WHERE status = $1 ORDER BY name, language', [status])
    : many('SELECT * FROM templates ORDER BY updated_at DESC');
}

export async function getTemplate(id) {
  const t = await one('SELECT * FROM templates WHERE id = $1', [id]);
  if (!t) throw notFound('Template not found');
  return t;
}

export async function createTemplate(data, userId) {
  const problems = validateTemplateComponents(data.components);
  if (problems.length) throw badRequest('Template is not valid', problems.map((message) => ({ message })));
  return one(
    `INSERT INTO templates (name, language, category, components, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [data.name, data.language, data.category, JSON.stringify(data.components), userId],
  );
}

export async function updateTemplate(id, data) {
  const t = await getTemplate(id);
  if (!['DRAFT', 'REJECTED'].includes(t.status)) throw badRequest('Only draft or rejected templates can be edited. Create a new template instead.');
  const components = data.components || t.components;
  const problems = validateTemplateComponents(components);
  if (problems.length) throw badRequest('Template is not valid', problems.map((message) => ({ message })));
  return one(
    `UPDATE templates SET category = COALESCE($2, category), components = $3, status = 'DRAFT', rejection_reason = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, data.category ?? null, JSON.stringify(components)],
  );
}

/** Submit a draft to Meta for approval. */
export async function submitTemplate(id) {
  const t = await getTemplate(id);
  if (!['DRAFT', 'REJECTED'].includes(t.status)) throw badRequest(`Template is already ${t.status}`);
  const client = getClient();
  const r = await client.createTemplate({ name: t.name, language: t.language, category: t.category, components: t.components });
  const updated = await one(
    `UPDATE templates SET status = $2, wa_template_id = $3, category = COALESCE($4, category), rejection_reason = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, r.status || 'PENDING', r.id ? String(r.id) : null, r.category || null],
  );
  if (client.isMock) await enqueue('maintenance', 'mock-template-review', { templateId: id }, { delayMs: 5000, attempts: 1 });
  publish('template.updated', { id });
  return updated;
}

/** Demo mode: approve or reject like Meta would (rejects marketing templates without an opt-out hint). */
export async function mockReview(templateId) {
  const t = await one('SELECT * FROM templates WHERE id = $1', [templateId]);
  if (!t || t.status !== 'PENDING') return;
  const body = t.components.find((c) => c.type === 'BODY')?.text || '';
  const footer = t.components.find((c) => c.type === 'FOOTER')?.text || '';
  const rejected = t.category === 'MARKETING' && !/stop|unsubscribe/i.test(`${body} ${footer}`);
  await applyTemplateStatus({
    templateId: t.wa_template_id,
    name: t.name,
    language: t.language,
    event: rejected ? 'REJECTED' : 'APPROVED',
    reason: rejected ? 'Demo review: marketing templates should tell customers how to opt out (e.g. "Reply STOP to unsubscribe")' : null,
  });
}

/** Template status webhook / sync result. */
export async function applyTemplateStatus(evt) {
  const status = String(evt.event || '').toUpperCase();
  const allowed = ['APPROVED', 'REJECTED', 'PENDING', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED', 'FLAGGED', 'REINSTATED'];
  if (!allowed.includes(status)) return;
  const mapped = status === 'FLAGGED' ? 'PAUSED' : status === 'REINSTATED' ? 'APPROVED' : status;
  const t = await one(
    `UPDATE templates SET status = $1, rejection_reason = $2, last_synced_at = now(), updated_at = now()
      WHERE (wa_template_id = $3) OR (name = $4 AND language = $5) RETURNING id`,
    [mapped, mapped === 'REJECTED' ? evt.reason || 'Rejected by Meta (no reason given)' : null, evt.templateId, evt.name, evt.language],
  );
  if (t) publish('template.updated', { id: t.id });
}

export async function applyTemplateQuality(evt) {
  await query(`UPDATE templates SET quality_score = $1, updated_at = now() WHERE wa_template_id = $2 OR (name = $3 AND language = $4)`, [
    evt.quality,
    evt.templateId,
    evt.name,
    evt.language,
  ]);
}

/** Pull every template from Meta and upsert statuses, rejection reasons and components. */
export async function syncTemplates() {
  const remote = await getClient().listTemplates();
  if (remote === null) {
    await query(`UPDATE templates SET last_synced_at = now()`);
    return { synced: 0, mock: true };
  }
  let n = 0;
  for (const r of remote) {
    await query(
      `INSERT INTO templates (name, language, category, status, components, wa_template_id, rejection_reason, quality_score, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (name, language) DO UPDATE SET category = EXCLUDED.category, status = EXCLUDED.status,
         components = EXCLUDED.components, wa_template_id = EXCLUDED.wa_template_id,
         rejection_reason = EXCLUDED.rejection_reason, quality_score = EXCLUDED.quality_score, last_synced_at = now(), updated_at = now()`,
      [
        r.name,
        r.language,
        r.category,
        r.status,
        JSON.stringify(r.components || []),
        String(r.id),
        r.rejected_reason && r.rejected_reason !== 'NONE' ? r.rejected_reason : null,
        r.quality_score?.score || null,
      ],
    );
    n++;
  }
  logger.info(`Synced ${n} templates from Meta`);
  publish('template.updated', {});
  return { synced: n };
}

export async function deleteTemplate(id) {
  const t = await getTemplate(id);
  if (t.wa_template_id && t.status !== 'DRAFT') await getClient().deleteTemplate(t.name);
  await query('DELETE FROM templates WHERE id = $1', [id]);
}

/**
 * Resolve variable values for a contact. `variables` is { "1": {type:'field', value:'first_name'} | {type:'static', value:'x'} }
 * or a plain array of strings. Internal fields are never used.
 */
export async function resolveVariables(variables, contact) {
  if (Array.isArray(variables)) return variables.map(String);
  const safe = customerSafeContact(contact, await listCustomFields());
  return buildTemplateValues(variables || {}, safe);
}

/** Send an approved template into a conversation (works outside the 24h window). */
export async function sendTemplate({ conversationId, templateId, variables, headerValues, headerMedia, senderType = 'agent', userId, broadcastRecipientId }) {
  const t = await getTemplate(templateId);
  if (t.status !== 'APPROVED') throw badRequest(`Template "${t.name}" is ${t.status}, not APPROVED`);
  const contact = await one(`SELECT ct.* FROM contacts ct JOIN conversations c ON c.contact_id = ct.id WHERE c.id = $1`, [conversationId]);
  if (!contact) throw notFound('Conversation not found');
  const values = await resolveVariables(variables, contact);
  const hv = Array.isArray(headerValues) ? headerValues : await resolveVariables(headerValues, contact);
  return queueOutbound({
    conversationId,
    kind: 'template',
    senderType,
    userId,
    broadcastRecipientId,
    template: {
      name: t.name,
      language: t.language,
      category: t.category,
      components: t.components,
      values,
      headerValues: hv,
      headerMedia,
      preview: renderTemplatePreview(t.components, values, hv),
    },
  });
}
