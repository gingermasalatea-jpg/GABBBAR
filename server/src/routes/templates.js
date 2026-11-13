import { Router } from 'express';
import { ah } from '../lib/errors.js';
import { z, body, queryParams, uuid } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import * as templates from '../services/templates.js';
import { audit } from '../services/audit.js';
import { renderTemplatePreview } from '../whatsapp/payloads.js';

const r = Router();

const button = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: z.string().min(1).max(25) }),
  z.object({ type: z.literal('URL'), text: z.string().min(1).max(25), url: z.string().url().max(2000), example: z.array(z.string()).optional() }),
  z.object({ type: z.literal('PHONE_NUMBER'), text: z.string().min(1).max(25), phone_number: z.string().min(5).max(20) }),
]);

const component = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('HEADER'),
    format: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']),
    text: z.string().max(60).optional(),
    example: z.any().optional(),
  }),
  z.object({ type: z.literal('BODY'), text: z.string().min(1).max(1024), example: z.object({ body_text: z.array(z.array(z.string())) }).optional() }),
  z.object({ type: z.literal('FOOTER'), text: z.string().min(1).max(60) }),
  z.object({ type: z.literal('BUTTONS'), buttons: z.array(button).min(1).max(10) }),
]);

const templateInput = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/, 'Lowercase letters, numbers and underscores only'),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).default('en'),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  components: z.array(component).min(1).max(4),
});

r.get(
  '/',
  requirePermission('templates.view'),
  ah(async (req, res) => {
    const { status } = queryParams(z.object({ status: z.string().max(30).optional() }), req);
    const rows = await templates.listTemplates({ status });
    res.json({ templates: rows.map((t) => ({ ...t, preview: renderTemplatePreview(t.components) })) });
  }),
);

r.post(
  '/',
  requirePermission('templates.manage'),
  ah(async (req, res) => {
    const data = body(templateInput, req);
    const t = await templates.createTemplate(data, req.user.id);
    await audit({ req, action: 'template.created', entityType: 'template', entityId: t.id, meta: { name: t.name } });
    res.status(201).json({ template: t });
  }),
);

r.post(
  '/sync',
  requirePermission('templates.manage'),
  ah(async (req, res) => {
    const out = await templates.syncTemplates();
    await audit({ req, action: 'template.synced', meta: out });
    res.json(out);
  }),
);

r.patch(
  '/:id',
  requirePermission('templates.manage'),
  ah(async (req, res) => {
    const data = body(templateInput.pick({ category: true, components: true }).partial(), req);
    const t = await templates.updateTemplate(req.params.id, data);
    await audit({ req, action: 'template.updated', entityType: 'template', entityId: t.id });
    res.json({ template: t });
  }),
);

r.post(
  '/:id/submit',
  requirePermission('templates.manage'),
  ah(async (req, res) => {
    const t = await templates.submitTemplate(req.params.id);
    await audit({ req, action: 'template.submitted', entityType: 'template', entityId: t.id, meta: { name: t.name } });
    res.json({ template: t });
  }),
);

r.post(
  '/:id/send',
  requirePermission('inbox.reply'),
  ah(async (req, res) => {
    const data = body(
      z.object({
        conversation_id: uuid,
        variables: z.union([z.array(z.string().max(1024)), z.record(z.any())]).default([]),
        header_values: z.array(z.string().max(60)).default([]),
        header_media: z.object({ link: z.string().url().optional(), id: z.string().optional() }).optional(),
      }),
      req,
    );
    const message = await templates.sendTemplate({
      conversationId: data.conversation_id,
      templateId: req.params.id,
      variables: data.variables,
      headerValues: data.header_values,
      headerMedia: data.header_media,
      senderType: 'agent',
      userId: req.user.id,
    });
    res.status(201).json({ message });
  }),
);

r.delete(
  '/:id',
  requirePermission('templates.manage'),
  ah(async (req, res) => {
    await templates.deleteTemplate(req.params.id);
    await audit({ req, action: 'template.deleted', entityType: 'template', entityId: req.params.id });
    res.json({ ok: true });
  }),
);

export default r;
