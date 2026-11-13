import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, query } from '../db/pool.js';
import { ah, unauthorized, badRequest } from '../lib/errors.js';
import { z, body } from '../lib/validate.js';
import { issueSession, clearSession, requireAuth, publicUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { permissionsFor, ROLE_LABELS } from '../lib/permissions.js';
import { audit } from '../services/audit.js';

const r = Router();

// Constant-time-ish: always run bcrypt even when the user does not exist.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Use upper and lower case letters and a number');

r.post(
  '/login',
  rateLimit({ name: 'login', windowMs: 15 * 60_000, max: 20 }),
  rateLimit({ name: 'login-email', windowMs: 15 * 60_000, max: 8, key: (req) => String(req.body?.email || '').toLowerCase() }),
  ah(async (req, res) => {
    const { email, password } = body(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }), req);
    const user = await one('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
    if (!user || !ok || !user.is_active) {
      await audit({ req, action: 'auth.login_failed', meta: { email } });
      throw unauthorized('Incorrect email or password');
    }
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    issueSession(res, user);
    await audit({ req, userId: user.id, actorLabel: user.email, action: 'auth.login' });
    res.json({ user: { ...publicUser(user), permissions: permissionsFor(user.role) } });
  }),
);

r.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

r.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    res.json({ user: req.user, roleLabels: ROLE_LABELS });
  }),
);

r.post(
  '/change-password',
  requireAuth,
  ah(async (req, res) => {
    const { current_password, new_password } = body(z.object({ current_password: z.string(), new_password: passwordSchema }), req);
    const user = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!(await bcrypt.compare(current_password, user.password_hash))) throw badRequest('Current password is incorrect');
    const hash = await bcrypt.hash(new_password, 12);
    // Bumping token_version signs out all other sessions.
    const updated = await one(
      'UPDATE users SET password_hash = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1 RETURNING *',
      [user.id, hash],
    );
    issueSession(res, updated);
    await audit({ req, action: 'auth.password_changed', entityType: 'user', entityId: user.id });
    res.json({ ok: true });
  }),
);

export default r;
