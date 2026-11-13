import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, many } from '../db/pool.js';
import { ah, forbidden, notFound, badRequest } from '../lib/errors.js';
import { z, body } from '../lib/validate.js';
import { requirePermission, publicUser } from '../middleware/auth.js';
import { ROLES, ROLE_LABELS, PERMISSIONS, MATRIX, canManageRole } from '../lib/permissions.js';
import { passwordSchema } from './auth.js';
import { audit } from '../services/audit.js';

const r = Router();

r.get('/permissions', (_req, res) => {
  res.json({ roles: ROLES, roleLabels: ROLE_LABELS, permissions: PERMISSIONS, matrix: MATRIX });
});

// Agents need the team list for assignment.
r.get(
  '/',
  requirePermission('inbox.view'),
  ah(async (_req, res) => {
    const rows = await many('SELECT * FROM users ORDER BY is_active DESC, name');
    res.json({ users: rows.map(publicUser) });
  }),
);

r.post(
  '/',
  requirePermission('users.manage'),
  ah(async (req, res) => {
    const data = body(
      z.object({
        name: z.string().min(1).max(120),
        email: z.string().email().max(200),
        role: z.enum(ROLES),
        password: passwordSchema,
      }),
      req,
    );
    if (!canManageRole(req.user.role, data.role)) throw forbidden('Only a Super Admin can create admins');
    const hash = await bcrypt.hash(data.password, 12);
    const u = await one('INSERT INTO users (name, email, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING *', [
      data.name,
      data.email.toLowerCase(),
      data.role,
      hash,
    ]);
    await audit({ req, action: 'user.created', entityType: 'user', entityId: u.id, meta: { email: u.email, role: u.role } });
    res.status(201).json({ user: publicUser(u) });
  }),
);

r.patch(
  '/:id',
  requirePermission('users.manage'),
  ah(async (req, res) => {
    const data = body(
      z.object({
        name: z.string().min(1).max(120).optional(),
        role: z.enum(ROLES).optional(),
        is_active: z.boolean().optional(),
        password: passwordSchema.optional(),
      }),
      req,
    );
    const target = await one('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!target) throw notFound('User not found');
    if (!canManageRole(req.user.role, target.role)) throw forbidden('You cannot edit this user');
    if (data.role && !canManageRole(req.user.role, data.role)) throw forbidden('You cannot assign this role');
    if (target.id === req.user.id && (data.is_active === false || (data.role && data.role !== target.role))) {
      throw badRequest('You cannot deactivate yourself or change your own role');
    }
    if (target.role === 'super_admin' && (data.is_active === false || (data.role && data.role !== 'super_admin'))) {
      const n = (await one(`SELECT count(*)::int AS n FROM users WHERE role = 'super_admin' AND is_active`)).n;
      if (n <= 1) throw badRequest('There must be at least one active Super Admin');
    }
    const hash = data.password ? await bcrypt.hash(data.password, 12) : null;
    const bump = data.password || data.is_active === false || data.role ? 1 : 0;
    const u = await one(
      `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), is_active = COALESCE($4, is_active),
         password_hash = COALESCE($5, password_hash), token_version = token_version + $6, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [target.id, data.name ?? null, data.role ?? null, data.is_active ?? null, hash, bump],
    );
    await audit({
      req,
      action: 'user.updated',
      entityType: 'user',
      entityId: u.id,
      meta: { fields: Object.keys(data).map((k) => (k === 'password' ? 'password(reset)' : k)), role: data.role },
    });
    res.json({ user: publicUser(u) });
  }),
);

export default r;
