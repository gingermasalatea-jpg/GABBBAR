import { one, many, query } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { can } from '../lib/permissions.js';
import { windowInfo } from '../lib/window.js';
import { publish } from './realtime.js';
import { emit } from '../lib/hooks.js';

const CONV_SELECT = `
  SELECT c.*,
    json_build_object('id', ct.id, 'name', ct.name, 'phone', ct.phone, 'tags', ct.tags, 'opted_in', ct.opted_in,
                      'opted_out_at', ct.opted_out_at, 'is_demo', ct.is_demo) AS contact,
    u.name AS assigned_name,
    COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color) ORDER BY l.name)
              FROM conversation_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.conversation_id = c.id), '[]') AS labels
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN users u ON u.id = c.assigned_to`;

export function decorate(conv) {
  if (!conv) return conv;
  return { ...conv, window: windowInfo(conv.last_inbound_at) };
}

export async function getOrCreateConversation(contactId, client) {
  const db = client || { query };
  const { rows } = await db.query(
    `INSERT INTO conversations (contact_id) VALUES ($1)
     ON CONFLICT (contact_id) DO UPDATE SET updated_at = conversations.updated_at
     RETURNING *, (xmax = 0) AS inserted`,
    [contactId],
  );
  return rows[0];
}

export async function getConversation(id) {
  const c = await one(`${CONV_SELECT} WHERE c.id = $1`, [id]);
  if (!c) throw notFound('Conversation not found');
  return decorate(c);
}

export function assertCanSee(user, conv) {
  if (can(user.role, 'inbox.view_all')) return;
  if (conv.assigned_to && conv.assigned_to !== user.id) throw forbidden('This conversation is assigned to someone else');
}

const FILTERS = {
  all: '',
  open: `c.status = 'open'`,
  resolved: `c.status = 'resolved'`,
  unread: `c.unread_count > 0`,
  mine: `c.assigned_to = $USER`,
  unassigned: `c.assigned_to IS NULL AND c.status = 'open'`,
  ai: `c.last_handler = 'ai'`,
  human: `c.last_handler = 'human'`,
  takeover: `c.human_takeover = true`,
};

export async function listConversations(user, { filter = 'open', search, label, before, limit = 40 }) {
  const where = [];
  const vals = [];
  const push = (v) => {
    vals.push(v);
    return `$${vals.length}`;
  };
  const f = FILTERS[filter] ?? FILTERS.open;
  if (f) where.push(f.includes('$USER') ? f.replace('$USER', push(user.id)) : f);
  if (!can(user.role, 'inbox.view_all')) {
    where.push(`(c.assigned_to IS NULL OR c.assigned_to = ${push(user.id)})`);
  }
  if (search) {
    const p = push(`%${search.toLowerCase()}%`);
    where.push(`(lower(coalesce(ct.name,'')) LIKE ${p} OR ct.phone LIKE ${p} OR lower(coalesce(c.last_message_preview,'')) LIKE ${p})`);
  }
  if (label) where.push(`EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id = c.id AND cl.label_id = ${push(label)})`);
  if (before) where.push(`c.last_message_at < ${push(before)}`);
  const sql = `${CONV_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.last_message_at DESC NULLS LAST LIMIT ${push(Math.min(100, limit))}`;
  const rows = await many(sql, vals);

  const counts = await one(
    `SELECT count(*) FILTER (WHERE c.status = 'open')::int AS open,
            count(*) FILTER (WHERE c.unread_count > 0)::int AS unread,
            count(*) FILTER (WHERE c.assigned_to = $1 AND c.status = 'open')::int AS mine,
            count(*) FILTER (WHERE c.assigned_to IS NULL AND c.status = 'open')::int AS unassigned
       FROM conversations c ${!can(user.role, 'inbox.view_all') ? 'WHERE (c.assigned_to IS NULL OR c.assigned_to = $1)' : ''}`,
    [user.id],
  );
  return { rows: rows.map(decorate), counts };
}

async function broadcastUpdate(id) {
  const conv = await getConversation(id);
  publish('conversation.updated', { id, assigned_to: conv.assigned_to, conversation: conv });
  return conv;
}

export async function updateConversation(id, patch, actor) {
  const conv = await getConversation(id);
  const sets = [];
  const vals = [id];
  const add = (sql, v) => {
    vals.push(v);
    sets.push(sql.replace('?', `$${vals.length}`));
  };
  if (patch.status && patch.status !== conv.status) {
    add('status = ?', patch.status);
    sets.push(patch.status === 'resolved' ? 'resolved_at = now()' : 'resolved_at = NULL');
    if (patch.status === 'resolved') add('resolved_by = ?', actor?.id || null);
    if (patch.status === 'resolved') sets.push('flow_state = NULL');
  }
  if (patch.assigned_to !== undefined) {
    if (patch.assigned_to) {
      const u = await one('SELECT id, is_active FROM users WHERE id = $1', [patch.assigned_to]);
      if (!u || !u.is_active) throw badRequest('Assignee not found or inactive');
    }
    add('assigned_to = ?', patch.assigned_to || null);
  }
  if (patch.ai_mode_override !== undefined) add('ai_mode_override = ?', patch.ai_mode_override || null);
  if (!sets.length) return conv;
  await query(`UPDATE conversations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
  const updated = await broadcastUpdate(id);
  if (patch.status === 'resolved' && conv.status !== 'resolved') emit('conversation.resolved', { conversation: updated, actor });
  return updated;
}

/** Human takeover: pause the AI and any running flow for this conversation immediately. */
export async function takeover(id, userId) {
  await getConversation(id);
  await query(
    `UPDATE conversations SET human_takeover = true, takeover_by = $2, takeover_at = now(), flow_state = NULL,
       assigned_to = COALESCE(assigned_to, $2), status = 'open', resolved_at = NULL, updated_at = now() WHERE id = $1`,
    [id, userId],
  );
  return broadcastUpdate(id);
}

export async function release(id) {
  await query(`UPDATE conversations SET human_takeover = false, takeover_by = NULL, takeover_at = NULL, updated_at = now() WHERE id = $1`, [id]);
  return broadcastUpdate(id);
}

export async function markRead(id) {
  await query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [id]);
  publish('conversation.updated', { id, unread_count: 0 });
}

export async function setLabels(id, labelIds) {
  await query('DELETE FROM conversation_labels WHERE conversation_id = $1', [id]);
  if (labelIds.length) {
    await query(`INSERT INTO conversation_labels (conversation_id, label_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [id, labelIds]);
  }
  return broadcastUpdate(id);
}

/** Round-robin among active agents (fewest open conversations first). */
export async function pickAgentRoundRobin() {
  const row = await one(
    `SELECT u.id FROM users u
       LEFT JOIN conversations c ON c.assigned_to = u.id AND c.status = 'open'
      WHERE u.is_active AND u.role IN ('agent','admin')
      GROUP BY u.id ORDER BY count(c.id) ASC, max(c.updated_at) ASC NULLS FIRST LIMIT 1`,
  );
  return row?.id || null;
}

export { broadcastUpdate };
