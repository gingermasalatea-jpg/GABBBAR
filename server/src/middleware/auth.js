import { config } from '../config.js';
import { one } from '../db/pool.js';
import { signJwt, verifyJwt } from '../lib/jwt.js';
import { can, permissionsFor } from '../lib/permissions.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export const COOKIE = 'wadesk_token';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function issueSession(res, user) {
  const maxAge = config.jwtExpiresHours * 3600;
  const token = signJwt({ sub: user.id, role: user.role, tv: user.token_version }, config.jwtSecret, { expiresInSeconds: maxAge });
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (config.isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  return token;
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.isProd ? '; Secure' : ''}`);
}

export function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    is_active: u.is_active,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
  };
}

/** Requires a valid session cookie. Re-checks the user row so deactivation / role change takes effect immediately. */
export async function requireAuth(req, _res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) throw unauthorized();
    let payload;
    try {
      payload = verifyJwt(token, config.jwtSecret);
    } catch {
      throw unauthorized('Session expired — please sign in again');
    }
    const user = await one('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (!user || !user.is_active || user.token_version !== payload.tv) throw unauthorized('Session is no longer valid');

    // CSRF defence for cookie auth: mutating requests must carry a custom header
    // (cannot be set cross-site without a CORS preflight, which we do not allow).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'wadesk') {
      throw forbidden('Missing CSRF header');
    }

    req.user = { ...publicUser(user), permissions: permissionsFor(user.role) };
    next();
  } catch (err) {
    next(err);
  }
}

export function requirePermission(...perms) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    const missing = perms.filter((p) => !can(req.user.role, p));
    if (missing.length) return next(forbidden(`Missing permission: ${missing.join(', ')}`));
    next();
  };
}
