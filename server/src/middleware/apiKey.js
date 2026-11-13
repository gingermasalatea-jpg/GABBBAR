import { one, query } from '../db/pool.js';
import { sha256Hex } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export const API_SCOPES = ['contacts:read', 'contacts:write', 'messages:send', 'conversations:read', 'templates:read'];

/** Authenticate public REST API requests: `Authorization: Bearer wak_...` or `X-API-Key`. */
export async function requireApiKey(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-api-key'] || '').trim();
    if (!raw || !raw.startsWith('wak_')) throw unauthorized('API key required');
    const key = await one('SELECT id, name, scopes, revoked_at FROM api_keys WHERE key_hash = $1', [sha256Hex(raw)]);
    if (!key || key.revoked_at) throw unauthorized('Invalid or revoked API key');
    req.apiKey = key;
    query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [key.id]).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
}

export function requireScope(scope) {
  return (req, _res, next) => {
    if (!req.apiKey?.scopes?.includes(scope)) return next(forbidden(`API key lacks scope ${scope}`));
    next();
  };
}
