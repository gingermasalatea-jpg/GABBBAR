import { Router } from 'express';
import { ah } from '../lib/errors.js';
import { z, body, queryParams, uuid } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import * as broadcasts from '../services/broadcasts.js';
import { audit } from '../services/audit.js';
import { isSendLive } from '../services/settings.js';
import { config } from '../config.js';

const r = Router();

const audience = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('tags'), tags: z.array(z.string().max(60)).min(1).max(20), match: z.enum(['any', 'all']).default('any') }),
  z.object({ type: z.literal('filter'), field: z.string().max(60), operator: z.enum(['equals', 'not_equals', 'contains']), value: z.string().max(200), tags: z.array(z.string().max(60)).max(20).optional() }),
  z.object({ type: z.literal('csv'), phones: z.array(z.string().max(30)).min(1).max(100_000) }),
]);

const varSource = z.union([
  z.object({ type: z.literal('field'), value: z.string().max(60), fallback: z.string().max(200).optional() }),
  z.object({ type: z.literal('static'), value: z.string().max(1024) }),
]);

r.get('/', requirePermission('broadcasts.view'), ah(async (_req, res) => res.json({ broadcasts: await broadcasts.listBroadcasts(), sendLive: await isSendLive(), mock: config.mock.whatsapp })));

r.post(
  '/preview-audience',
  requirePermission('broadcasts.view'),
  ah(async (req, res) => {
    const { audience: a } = body(z.object({ audience }), req);
    res.json(await broadcasts.previewAudience(a));
  }),
);

r.post(
  '/',
  requirePermission('broadcasts.manage'),
  ah(async (req, res) => {
    const d = body(
      z.object({
        name: z.string().trim().min(1).max(120),
        template_id: uuid,
        template_variables: z.record(varSource).default({}),
        header_media_url: z.string().url().max(2000).optional(),
        audience,
      }),
      req,
    );
    const b = await broadcasts.createBroadcast(d, req.user.id);
    await audit({ req, action: 'broadcast.created', entityType: 'broadcast', entityId: b.id, meta: { name: b.name } });
    res.status(201).json({ broadcast: b });
  }),
);

r.get('/:id', requirePermission('broadcasts.view'), ah(async (req, res) => res.json({ broadcast: await broadcasts.getBroadcast(req.params.id) })));

r.get(
  '/:id/recipients',
  requirePermission('broadcasts.view'),
  ah(async (req, res) => {
    const q = queryParams(z.object({ status: z.enum(['pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped']).optional(), page: z.coerce.number().int().min(1).default(1) }), req);
    res.json({ recipients: await broadcasts.listRecipients(req.params.id, q) });
  }),
);

r.post(
  '/:id/schedule',
  requirePermission('broadcasts.manage'),
  ah(async (req, res) => {
    const { scheduled_at } = body(z.object({ scheduled_at: z.string().datetime().nullable().optional() }), req);
    const b = await broadcasts.scheduleBroadcast(req.params.id, scheduled_at);
    await audit({ req, action: 'broadcast.scheduled', entityType: 'broadcast', entityId: b.id, meta: { scheduled_at: b.scheduled_at } });
    res.json({ broadcast: b });
  }),
);

r.post(
  '/:id/cancel',
  requirePermission('broadcasts.manage'),
  ah(async (req, res) => {
    await broadcasts.cancelBroadcast(req.params.id);
    await audit({ req, action: 'broadcast.cancelled', entityType: 'broadcast', entityId: req.params.id });
    res.json({ broadcast: await broadcasts.getBroadcast(req.params.id) });
  }),
);

export default r;
