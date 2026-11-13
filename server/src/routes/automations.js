import { Router } from 'express';
import { one, many, tx } from '../db/pool.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { z, body } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { validateFlow } from '../automation/engine.js';
import { dryRun } from '../automation/runner.js';
import { audit } from '../services/audit.js';
import * as analytics from '../services/analytics.js';

const r = Router();

const node = z.object({
  node_key: z.string().regex(/^[a-z0-9_]{1,40}$/, 'Step ids: lowercase letters, numbers, underscores'),
  type: z.enum(['message', 'buttons', 'list', 'condition', 'assign', 'tag', 'webhook', 'handoff']),
  config: z.record(z.any()).default({}),
  next: z.record(z.string().max(40).nullable()).default({}),
});

const automationInput = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['keyword', 'welcome', 'out_of_hours', 'flow']),
  is_active: z.boolean().default(true),
  priority: z.number().int().min(0).max(10000).default(100),
  trigger: z.object({ keywords: z.array(z.string().trim().min(1).max(200)).max(50).default([]), match: z.enum(['exact', 'contains', 'starts_with', 'regex']).default('contains') }).default({ keywords: [], match: 'contains' }),
  response: z.object({ text: z.string().max(4096).optional() }).default({}),
  flow_start_node: z.string().max(40).nullable().optional(),
  nodes: z.array(node).max(100).default([]),
});

function check(d) {
  if (d.type === 'keyword' && (!d.trigger.keywords.length || !d.response.text)) throw badRequest('Keyword replies need keywords and a reply text');
  if (d.type === 'welcome' && !d.response.text) throw badRequest('Welcome message text is required');
  if (d.type === 'flow') {
    if (!d.nodes.length) throw badRequest('Add at least one step to the flow');
    if (!d.trigger.keywords.length) throw badRequest('Flows need at least one trigger keyword');
    const problems = validateFlow(d.nodes, d.flow_start_node || d.nodes[0].node_key);
    if (problems.length) throw badRequest('Flow has problems', problems.map((message) => ({ message })));
  }
  if (d.trigger.match === 'regex') for (const k of d.trigger.keywords) {
    try {
      new RegExp(k, 'iu');
    } catch {
      throw badRequest(`Invalid pattern: ${k}`);
    }
  }
}

async function save(client, id, d) {
  const start = d.type === 'flow' ? d.flow_start_node || d.nodes[0].node_key : null;
  const { rows } = id
    ? await client.query(
        `UPDATE automations SET name=$2, type=$3, is_active=$4, priority=$5, trigger=$6, response=$7, flow_start_node=$8, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, d.name, d.type, d.is_active, d.priority, d.trigger, d.response, start],
      )
    : await client.query(
        `INSERT INTO automations (name, type, is_active, priority, trigger, response, flow_start_node) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [d.name, d.type, d.is_active, d.priority, d.trigger, d.response, start],
      );
  if (!rows[0]) throw notFound('Automation not found');
  await client.query('DELETE FROM flow_nodes WHERE automation_id = $1', [rows[0].id]);
  if (d.type === 'flow') {
    for (const [i, n] of d.nodes.entries()) {
      await client.query('INSERT INTO flow_nodes (automation_id, node_key, type, config, next, position) VALUES ($1,$2,$3,$4,$5,$6)', [rows[0].id, n.node_key, n.type, n.config, n.next, i]);
    }
  }
  return rows[0];
}

r.get(
  '/',
  requirePermission('automations.view'),
  ah(async (_req, res) => {
    res.json({ automations: await many(`SELECT a.*, (SELECT count(*)::int FROM flow_nodes f WHERE f.automation_id = a.id) AS steps FROM automations a ORDER BY a.type = 'flow', a.priority, a.created_at`) });
  }),
);

r.get(
  '/:id',
  requirePermission('automations.view'),
  ah(async (req, res) => {
    const a = await one('SELECT * FROM automations WHERE id = $1', [req.params.id]);
    if (!a) throw notFound();
    res.json({ automation: { ...a, nodes: await many('SELECT node_key, type, config, next FROM flow_nodes WHERE automation_id = $1 ORDER BY position', [a.id]) } });
  }),
);

r.post(
  '/',
  requirePermission('automations.manage'),
  ah(async (req, res) => {
    const d = body(automationInput, req);
    check(d);
    if (['welcome', 'out_of_hours'].includes(d.type)) {
      const exists = await one('SELECT id FROM automations WHERE type = $1', [d.type]);
      if (exists) throw badRequest(`There is already a ${d.type.replace(/_/g, ' ')} automation — edit that one`);
    }
    const a = await tx((c) => save(c, null, d));
    await audit({ req, action: 'automation.created', entityType: 'automation', entityId: a.id, meta: { name: a.name, type: a.type } });
    res.status(201).json({ automation: a });
  }),
);

r.put(
  '/:id',
  requirePermission('automations.manage'),
  ah(async (req, res) => {
    const d = body(automationInput, req);
    check(d);
    const a = await tx((c) => save(c, req.params.id, d));
    await audit({ req, action: 'automation.updated', entityType: 'automation', entityId: a.id, meta: { name: a.name, active: a.is_active } });
    res.json({ automation: a });
  }),
);

r.delete(
  '/:id',
  requirePermission('automations.manage'),
  ah(async (req, res) => {
    const a = await one('DELETE FROM automations WHERE id = $1 RETURNING name', [req.params.id]);
    if (!a) throw notFound();
    await audit({ req, action: 'automation.deleted', entityType: 'automation', entityId: req.params.id, meta: { name: a.name } });
    res.json({ ok: true });
  }),
);

r.post(
  '/test',
  requirePermission('automations.view'),
  ah(async (req, res) => {
    const d = body(z.object({ text: z.string().min(1).max(1000), is_new_contact: z.boolean().default(false) }), req);
    res.json({ result: await dryRun(d.text, { isNewContact: d.is_new_contact }) });
  }),
);

export default r;

export const analyticsRouter = Router();
analyticsRouter.get(
  '/overview',
  requirePermission('analytics.view'),
  ah(async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    res.json(await analytics.overview(days));
  }),
);
