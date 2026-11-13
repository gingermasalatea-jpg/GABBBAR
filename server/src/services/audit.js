import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * @typedef {object} AuditEntry
 * @property {any} [req]
 * @property {string|null} [userId]
 * @property {'user'|'api_key'|'system'} [actorType]
 * @property {string} [actorLabel]
 * @property {string} action
 * @property {string} [entityType]
 * @property {string|number|null} [entityId]
 * @property {object} [meta]
 */

/**
 * Record an audit entry. Never throws (auditing must not break the request),
 * and never stores secret values — callers pass names, not values.
 * @param {AuditEntry} entry
 */
export async function audit({ req, userId, actorType, actorLabel, action, entityType, entityId, meta }) {
  try {
    const user = req?.user;
    const apiKey = req?.apiKey;
    await query(
      `INSERT INTO audit_logs (user_id, actor_type, actor_label, action, entity_type, entity_id, meta, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        userId ?? user?.id ?? null,
        actorType ?? (apiKey ? 'api_key' : user ? 'user' : 'system'),
        actorLabel ?? (apiKey ? `API key: ${apiKey.name}` : user ? user.email : 'system'),
        action,
        entityType ?? null,
        entityId != null ? String(entityId) : null,
        meta ?? {},
        req?.ip ?? null,
      ],
    );
  } catch (err) {
    logger.error('audit write failed', { err, action });
  }
}
