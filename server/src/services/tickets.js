import { one, many } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { emit } from '../lib/hooks.js';
import { publish } from './realtime.js';

export async function createTicket({ conversationId, contactId, subject, description, priority = 'normal', source = 'manual', assignedTo = null }) {
  let cid = contactId;
  if (!cid && conversationId) cid = (await one('SELECT contact_id FROM conversations WHERE id = $1', [conversationId]))?.contact_id;
  const t = await one(
    `INSERT INTO tickets (conversation_id, contact_id, subject, description, priority, source, assigned_to) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [conversationId || null, cid || null, subject.slice(0, 300), description || null, priority, source, assignedTo],
  );
  const conv = conversationId ? await one('SELECT assigned_to FROM conversations WHERE id = $1', [conversationId]) : null;
  // Team notification: realtime toast in every open inbox + outbound webhook event.
  publish('ticket.created', { id: t.id, subject: t.subject, source: t.source, conversation_id: conversationId, assigned_to: conv?.assigned_to ?? null });
  emit('ticket.created', { ticket: t });
  return t;
}

/** An open AI-fallback ticket for this conversation from the last few hours, if any. */
export async function recentFallbackTicket(conversationId, hours = 6) {
  return one(
    `SELECT * FROM tickets WHERE conversation_id = $1 AND source = 'ai_fallback' AND status <> 'closed' AND created_at > now() - make_interval(hours => $2) ORDER BY created_at DESC LIMIT 1`,
    [conversationId, hours],
  );
}

export async function listTickets({ status, assignedTo, page = 1, limit = 50 }) {
  const where = [];
  const vals = [];
  if (status) {
    vals.push(status);
    where.push(`t.status = $${vals.length}`);
  }
  if (assignedTo) {
    vals.push(assignedTo);
    where.push(`t.assigned_to = $${vals.length}`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await one(`SELECT count(*)::int AS n FROM tickets t ${w}`, vals)).n;
  vals.push(limit, (page - 1) * limit);
  const rows = await many(
    `SELECT t.*, ct.name AS contact_name, ct.phone AS contact_phone, u.name AS assigned_name
       FROM tickets t LEFT JOIN contacts ct ON ct.id = t.contact_id LEFT JOIN users u ON u.id = t.assigned_to ${w}
      ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
               CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at DESC
      LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals,
  );
  return { rows, total, page, limit };
}

export async function updateTicket(id, patch) {
  const t = await one(
    `UPDATE tickets SET status = COALESCE($2, status), priority = COALESCE($3, priority),
       assigned_to = CASE WHEN $5 THEN $4::uuid ELSE assigned_to END,
       closed_at = CASE WHEN $2 = 'closed' THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE closed_at END, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.status ?? null, patch.priority ?? null, patch.assigned_to ?? null, patch.assigned_to !== undefined],
  );
  if (!t) throw notFound('Ticket not found');
  return t;
}

export async function openTicketCount() {
  return (await one(`SELECT count(*)::int AS n FROM tickets WHERE status <> 'closed'`)).n;
}

