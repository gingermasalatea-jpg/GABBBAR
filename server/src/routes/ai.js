import { Router } from 'express';
import { one, many, query } from '../db/pool.js';
import { ah, notFound } from '../lib/errors.js';
import { z, body, queryParams, uuid } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { testAnswer } from '../ai/assistant.js';
import { audit } from '../services/audit.js';
import * as tickets from '../services/tickets.js';

/* ───── AI logs + playground ───── */
const r = Router();

r.get(
  '/logs',
  requirePermission('ai.view_logs'),
  ah(async (req, res) => {
    const q = queryParams(
      z.object({
        decision: z.enum(['sent', 'suggested', 'held', 'fallback', 'blocked', 'error', 'skipped']).optional(),
        conversation_id: uuid.optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
      req,
    );
    const where = [];
    const vals = [];
    if (q.decision) {
      vals.push(q.decision);
      where.push(`l.decision = $${vals.length}`);
    }
    if (q.conversation_id) {
      vals.push(q.conversation_id);
      where.push(`l.conversation_id = $${vals.length}`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await one(`SELECT count(*)::int AS n FROM ai_logs l ${w}`, vals)).n;
    vals.push(q.limit, (q.page - 1) * q.limit);
    const rows = await many(
      `SELECT l.id, l.conversation_id, l.mode, l.provider, l.model, l.input->>'customer_message' AS customer_message, l.output,
              l.knowledge_titles, l.decision, l.guardrail_flags, l.latency_ms, l.error, l.created_at, ct.name AS contact_name, ct.phone AS contact_phone
         FROM ai_logs l LEFT JOIN conversations c ON c.id = l.conversation_id LEFT JOIN contacts ct ON ct.id = c.contact_id
         ${w} ORDER BY l.created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals,
    );
    const stats = await one(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE decision = 'sent')::int AS sent,
              count(*) FILTER (WHERE decision = 'suggested')::int AS suggested,
              count(*) FILTER (WHERE decision IN ('fallback','blocked'))::int AS fallback,
              count(*) FILTER (WHERE decision = 'error')::int AS errors,
              round(avg(latency_ms))::int AS avg_latency
         FROM ai_logs WHERE created_at > now() - interval '7 days' AND mode <> 'test'`,
    );
    res.json({ rows, total, page: q.page, limit: q.limit, stats });
  }),
);

r.get(
  '/logs/:id',
  requirePermission('ai.view_logs'),
  ah(async (req, res) => {
    const log = await one('SELECT * FROM ai_logs WHERE id = $1', [req.params.id]);
    if (!log) throw notFound();
    res.json({ log });
  }),
);

r.post(
  '/test',
  requirePermission('ai.manage'),
  ah(async (req, res) => {
    const d = body(z.object({ question: z.string().trim().min(1).max(2000), contact_id: uuid.optional() }), req);
    res.json({ result: await testAnswer({ question: d.question, contactId: d.contact_id }) });
  }),
);

export default r;

/* ───── Knowledge base ───── */
export const knowledgeRouter = Router();

const kInput = z.object({
  type: z.enum(['business_info', 'faq', 'document']),
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(200_000),
  tags: z.array(z.string().max(60)).max(20).default([]),
  is_active: z.boolean().default(true),
  source_file: z.string().max(240).optional(),
});

knowledgeRouter.get(
  '/',
  requirePermission('ai.view_logs'),
  ah(async (req, res) => {
    const { type } = queryParams(z.object({ type: z.enum(['business_info', 'faq', 'document']).optional() }), req);
    const rows = type
      ? await many('SELECT * FROM knowledge_items WHERE type = $1 ORDER BY updated_at DESC', [type])
      : await many('SELECT * FROM knowledge_items ORDER BY type, updated_at DESC');
    res.json({ items: rows });
  }),
);

knowledgeRouter.post(
  '/',
  requirePermission('ai.manage'),
  ah(async (req, res) => {
    const d = body(kInput, req);
    const row = await one(`INSERT INTO knowledge_items (type, title, content, tags, is_active, source_file) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
      d.type,
      d.title,
      d.content,
      d.tags,
      d.is_active,
      d.source_file || null,
    ]);
    await audit({ req, action: 'knowledge.created', entityType: 'knowledge', entityId: row.id, meta: { title: d.title } });
    res.status(201).json({ item: row });
  }),
);

knowledgeRouter.patch(
  '/:id',
  requirePermission('ai.manage'),
  ah(async (req, res) => {
    const d = body(kInput.partial(), req);
    const row = await one(
      `UPDATE knowledge_items SET type = COALESCE($2,type), title = COALESCE($3,title), content = COALESCE($4,content),
         tags = COALESCE($5,tags), is_active = COALESCE($6,is_active), updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, d.type ?? null, d.title ?? null, d.content ?? null, d.tags ?? null, d.is_active ?? null],
    );
    if (!row) throw notFound();
    await audit({ req, action: 'knowledge.updated', entityType: 'knowledge', entityId: row.id });
    res.json({ item: row });
  }),
);

knowledgeRouter.delete(
  '/:id',
  requirePermission('ai.manage'),
  ah(async (req, res) => {
    const x = await query('DELETE FROM knowledge_items WHERE id = $1', [req.params.id]);
    if (!x.rowCount) throw notFound();
    await audit({ req, action: 'knowledge.deleted', entityType: 'knowledge', entityId: req.params.id });
    res.json({ ok: true });
  }),
);

/* ───── Tickets ───── */
export const ticketsRouter = Router();

ticketsRouter.get(
  '/',
  requirePermission('tickets.view'),
  ah(async (req, res) => {
    const q = queryParams(
      z.object({
        status: z.enum(['open', 'in_progress', 'closed']).optional(),
        mine: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req,
    );
    res.json(await tickets.listTickets({ ...q, assignedTo: q.mine === 'true' ? req.user.id : undefined }));
  }),
);

ticketsRouter.post(
  '/',
  requirePermission('tickets.manage'),
  ah(async (req, res) => {
    const d = body(
      z.object({
        conversation_id: uuid.optional(),
        contact_id: uuid.optional(),
        subject: z.string().trim().min(1).max(300),
        description: z.string().max(5000).optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
      }),
      req,
    );
    const t = await tickets.createTicket({ conversationId: d.conversation_id, contactId: d.contact_id, subject: d.subject, description: d.description, priority: d.priority, source: 'manual', assignedTo: req.user.id });
    await audit({ req, action: 'ticket.created', entityType: 'ticket', entityId: t.id });
    res.status(201).json({ ticket: t });
  }),
);

ticketsRouter.patch(
  '/:id',
  requirePermission('tickets.manage'),
  ah(async (req, res) => {
    const d = body(z.object({ status: z.enum(['open', 'in_progress', 'closed']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), assigned_to: uuid.nullable().optional() }), req);
    const t = await tickets.updateTicket(req.params.id, d);
    await audit({ req, action: 'ticket.updated', entityType: 'ticket', entityId: t.id, meta: d });
    res.json({ ticket: t });
  }),
);
