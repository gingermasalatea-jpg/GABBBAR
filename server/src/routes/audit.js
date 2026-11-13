import { Router } from 'express';
import { many, one } from '../db/pool.js';
import { ah } from '../lib/errors.js';
import { z, queryParams } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';

const r = Router();

r.get(
  '/',
  requirePermission('audit.view'),
  ah(async (req, res) => {
    const q = queryParams(
      z.object({
        action: z.string().max(80).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req,
    );
    const vals = [];
    let where = '';
    if (q.action) {
      vals.push(`${q.action}%`);
      where = `WHERE a.action LIKE $1`;
    }
    const total = (await one(`SELECT count(*)::int AS n FROM audit_logs a ${where}`, vals)).n;
    vals.push(q.limit, (q.page - 1) * q.limit);
    const rows = await many(
      `SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${where}
       ORDER BY a.created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals,
    );
    res.json({ rows, total, page: q.page, limit: q.limit });
  }),
);

export default r;
