import { Router } from 'express';
import { one, many, query } from '../db/pool.js';
import { ah, notFound } from '../lib/errors.js';
import { z, body, queryParams, uuid } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import * as contacts from '../services/contacts.js';
import { audit } from '../services/audit.js';
import { emit } from '../lib/hooks.js';

const r = Router();

const contactInput = z.object({
  phone: z.string().min(5).max(30),
  name: z.string().max(200).optional().nullable(),
  email: z.string().email().max(200).optional().nullable().or(z.literal('')),
  tags: z.array(z.string().max(60)).max(50).optional(),
  custom: z.record(z.any()).optional(),
  opted_in: z.boolean().optional(),
  opt_in_source: z.string().max(100).optional(),
});

r.get(
  '/',
  requirePermission('contacts.view'),
  ah(async (req, res) => {
    const q = queryParams(
      z.object({
        search: z.string().max(100).optional(),
        tag: z.string().max(60).optional(),
        opted_in: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req,
    );
    res.json(await contacts.listContacts({ ...q, optedIn: q.opted_in }));
  }),
);

r.get('/tags', requirePermission('contacts.view'), ah(async (_req, res) => res.json({ tags: await contacts.allTags() })));

r.get(
  '/export',
  requirePermission('contacts.import'),
  ah(async (req, res) => {
    const csv = await contacts.exportCsv();
    await audit({ req, action: 'contacts.exported' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }),
);

r.get('/duplicates', requirePermission('contacts.delete'), ah(async (_req, res) => res.json({ groups: await contacts.findDuplicates() })));

r.post(
  '/merge',
  requirePermission('contacts.delete'),
  ah(async (req, res) => {
    const { target_id, source_ids } = body(z.object({ target_id: uuid, source_ids: z.array(uuid).min(1).max(20) }), req);
    const out = await contacts.mergeContacts(target_id, source_ids);
    await audit({ req, action: 'contacts.merged', entityType: 'contact', entityId: target_id, meta: { source_ids } });
    res.json(out);
  }),
);

r.post(
  '/import',
  requirePermission('contacts.import'),
  ah(async (req, res) => {
    const data = body(
      z.object({
        csv: z.string().min(1).max(10_000_000),
        mapping: z.record(z.string()),
        consent_confirmed: z.boolean().default(false),
        default_tags: z.array(z.string()).max(10).default([]),
      }),
      req,
    );
    const result = await contacts.importCsv(data.csv, data.mapping, {
      consentConfirmed: data.consent_confirmed,
      defaultTags: contacts.cleanTags(data.default_tags),
    });
    await audit({ req, action: 'contacts.imported', meta: { created: result.created, updated: result.updated, skipped: result.skipped } });
    res.json(result);
  }),
);

r.post(
  '/',
  requirePermission('contacts.edit'),
  ah(async (req, res) => {
    const data = body(contactInput, req);
    const c = await contacts.createContact(data, { source: 'manual' });
    await audit({ req, action: 'contact.created', entityType: 'contact', entityId: c.id });
    emit('contact.created', { contact: c });
    res.status(201).json({ contact: c });
  }),
);

r.get(
  '/:id',
  requirePermission('contacts.view'),
  ah(async (req, res) => {
    const c = await contacts.getContact(req.params.id);
    const conversation = await one('SELECT id, status, assigned_to, last_message_at FROM conversations WHERE contact_id = $1', [c.id]);
    const tickets = await many('SELECT id, subject, status, created_at FROM tickets WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 20', [c.id]);
    res.json({ contact: c, conversation, tickets });
  }),
);

r.patch(
  '/:id',
  requirePermission('contacts.edit'),
  ah(async (req, res) => {
    const data = body(contactInput.partial().omit({ opted_in: true, opt_in_source: true }), req);
    const c = await contacts.updateContact(req.params.id, data);
    await audit({ req, action: 'contact.updated', entityType: 'contact', entityId: c.id, meta: { fields: Object.keys(data) } });
    emit('contact.updated', { contact: c });
    res.json({ contact: c });
  }),
);

r.post(
  '/:id/opt-in',
  requirePermission('contacts.edit'),
  ah(async (req, res) => {
    const { source } = body(z.object({ source: z.string().min(2).max(100) }), req);
    const c = await contacts.setOptIn(req.params.id, true, source);
    await audit({ req, action: 'contact.opted_in', entityType: 'contact', entityId: c.id, meta: { source } });
    res.json({ contact: c });
  }),
);

r.post(
  '/:id/opt-out',
  requirePermission('contacts.edit'),
  ah(async (req, res) => {
    const c = await contacts.setOptIn(req.params.id, false);
    await audit({ req, action: 'contact.opted_out', entityType: 'contact', entityId: c.id });
    res.json({ contact: c });
  }),
);

r.delete(
  '/:id',
  requirePermission('contacts.delete'),
  ah(async (req, res) => {
    await contacts.deleteContact(req.params.id);
    await audit({ req, action: 'contact.deleted', entityType: 'contact', entityId: req.params.id });
    res.json({ ok: true });
  }),
);

/* ───── Custom fields ───── */
export const customFields = Router();

customFields.get('/', requirePermission('contacts.view'), ah(async (_req, res) => res.json({ fields: await contacts.listCustomFields() })));

const fieldInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,48}$/, 'Use lowercase letters, numbers and underscores'),
  label: z.string().min(1).max(100),
  type: z.enum(['text', 'number', 'date', 'boolean', 'select']).default('text'),
  options: z.array(z.string().max(100)).max(100).default([]),
  internal: z.boolean().default(false),
});

customFields.post(
  '/',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const f = body(fieldInput, req);
    const row = await one('INSERT INTO custom_fields (key, label, type, options, internal) VALUES ($1,$2,$3,$4,$5) RETURNING *', [
      f.key,
      f.label,
      f.type,
      JSON.stringify(f.options),
      f.internal,
    ]);
    await audit({ req, action: 'custom_field.created', entityType: 'custom_field', entityId: row.id, meta: f });
    res.status(201).json({ field: row });
  }),
);

customFields.patch(
  '/:id',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const f = body(fieldInput.omit({ key: true }).partial(), req);
    const row = await one(
      `UPDATE custom_fields SET label = COALESCE($2,label), type = COALESCE($3,type), options = COALESCE($4,options),
         internal = COALESCE($5,internal) WHERE id = $1 RETURNING *`,
      [req.params.id, f.label ?? null, f.type ?? null, f.options ? JSON.stringify(f.options) : null, f.internal ?? null],
    );
    if (!row) throw notFound();
    await audit({ req, action: 'custom_field.updated', entityType: 'custom_field', entityId: row.id, meta: f });
    res.json({ field: row });
  }),
);

customFields.delete(
  '/:id',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const row = await one('DELETE FROM custom_fields WHERE id = $1 RETURNING key', [req.params.id]);
    if (!row) throw notFound();
    await query('UPDATE contacts SET custom = custom - $1', [row.key]);
    await audit({ req, action: 'custom_field.deleted', entityType: 'custom_field', entityId: req.params.id, meta: { key: row.key } });
    res.json({ ok: true });
  }),
);

export default r;
