import { Router } from 'express';
import fs from 'node:fs';
import { many, one } from '../db/pool.js';
import { ah, notFound, badRequest } from '../lib/errors.js';
import { z, queryParams } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { assertCanSee } from '../services/conversations.js';
import { getMediaFile } from '../services/media.js';
import { enqueue } from '../queue/index.js';
import { audit } from '../services/audit.js';
import { query } from '../db/pool.js';

/* ───── Media (authenticated) ───── */
export const mediaRouter = Router();

mediaRouter.get(
  '/:id',
  requirePermission('inbox.view'),
  ah(async (req, res) => {
    const m = await getMediaFile(req.params.id);
    if (!m) throw notFound('Media not available (it may still be downloading)');
    if (m.conversation_id) assertCanSee(req.user, { assigned_to: m.assigned_to });
    const safeName = String(m.file_name || `file`).replace(/[^\w.\- ]+/g, '_');
    const inline = /^(image|video|audio)\//.test(m.mime_type || '') && !/svg/.test(m.mime_type);
    res.setHeader('Content-Type', inline ? m.mime_type : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    fs.createReadStream(m.path).on('error', () => res.destroy()).pipe(res);
  }),
);

/* ───── Dead-letter queue ───── */
export const dlqRouter = Router();

dlqRouter.get(
  '/',
  requirePermission('dlq.manage'),
  ah(async (req, res) => {
    const { status } = queryParams(z.object({ status: z.enum(['open', 'retried', 'discarded']).default('open') }), req);
    const rows = await many('SELECT * FROM dead_letters WHERE status = $1 ORDER BY created_at DESC LIMIT 200', [status]);
    const counts = await one(`SELECT count(*) FILTER (WHERE status = 'open')::int AS open FROM dead_letters`);
    res.json({ rows, counts });
  }),
);

dlqRouter.post(
  '/:id/retry',
  requirePermission('dlq.manage'),
  ah(async (req, res) => {
    const row = await one('SELECT * FROM dead_letters WHERE id = $1', [req.params.id]);
    if (!row) throw notFound();
    if (row.status !== 'open') throw badRequest('Already handled');
    // Outgoing messages that failed permanently were marked failed — reset them so they can send.
    if (row.queue === 'outbound' && row.payload?.messageId) {
      await query(`UPDATE messages SET status = 'queued', error_message = NULL WHERE id = $1 AND status IN ('failed','queued')`, [row.payload.messageId]);
    }
    await enqueue(row.queue, row.job_name, row.payload, { jobId: `dlq:${row.id}:${Date.now()}` });
    await query(`UPDATE dead_letters SET status = 'retried', resolved_at = now(), resolved_by = $2 WHERE id = $1`, [row.id, req.user.id]);
    await audit({ req, action: 'dlq.retried', entityType: 'dead_letter', entityId: row.id, meta: { queue: row.queue, job: row.job_name } });
    res.json({ ok: true });
  }),
);

dlqRouter.post(
  '/:id/discard',
  requirePermission('dlq.manage'),
  ah(async (req, res) => {
    const r = await query(`UPDATE dead_letters SET status = 'discarded', resolved_at = now(), resolved_by = $2 WHERE id = $1 AND status = 'open'`, [
      req.params.id,
      req.user.id,
    ]);
    if (!r.rowCount) throw notFound();
    await audit({ req, action: 'dlq.discarded', entityType: 'dead_letter', entityId: req.params.id });
    res.json({ ok: true });
  }),
);
