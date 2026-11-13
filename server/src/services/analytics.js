import { one, many } from '../db/pool.js';
import { getSection } from './settings.js';

/**
 * Analytics for the last N days, bucketed by day in the business timezone.
 * Response time = customer "turn" (first inbound after our last outbound) → first agent/AI reply.
 */
export async function overview(days = 30) {
  const tz = (await getSection('business')).timezone || 'Asia/Kolkata';
  const since = `${Math.max(1, Math.min(365, days))} days`;

  const perDay = await many(
    `WITH d AS (SELECT generate_series((now() AT TIME ZONE $1)::date - ($2::interval) + interval '1 day', (now() AT TIME ZONE $1)::date, interval '1 day')::date AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
       (SELECT count(DISTINCT m.conversation_id) FROM messages m WHERE (m.created_at AT TIME ZONE $1)::date = d.day)::int AS conversations,
       (SELECT count(*) FROM messages m WHERE m.direction = 'in' AND (m.created_at AT TIME ZONE $1)::date = d.day)::int AS inbound,
       (SELECT count(*) FROM messages m WHERE m.direction = 'out' AND (m.created_at AT TIME ZONE $1)::date = d.day)::int AS outbound,
       (SELECT count(*) FROM contacts c WHERE (c.created_at AT TIME ZONE $1)::date = d.day)::int AS new_contacts
     FROM d ORDER BY d.day`,
    [tz, since],
  );

  const response = await one(
    `WITH m AS (
        SELECT id, conversation_id, direction, created_at,
               lag(direction) OVER (PARTITION BY conversation_id ORDER BY created_at) AS prev_dir
          FROM messages WHERE created_at > now() - $1::interval AND type <> 'reaction'),
     turns AS (SELECT conversation_id, created_at AS asked_at FROM m WHERE direction = 'in' AND (prev_dir IS NULL OR prev_dir = 'out')),
     resp AS (
        SELECT t.asked_at, r.created_at AS answered_at, r.sender_type
          FROM turns t
          LEFT JOIN LATERAL (SELECT x.created_at, x.sender_type FROM messages x
                              WHERE x.conversation_id = t.conversation_id AND x.direction = 'out' AND x.sender_type IN ('agent','ai')
                                AND x.created_at > t.asked_at ORDER BY x.created_at LIMIT 1) r ON true)
     SELECT count(*)::int AS turns,
            count(answered_at)::int AS answered,
            round(avg(extract(epoch FROM answered_at - asked_at)))::int AS avg_seconds,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - asked_at)))::int AS median_seconds,
            round(avg(extract(epoch FROM answered_at - asked_at)) FILTER (WHERE sender_type = 'ai'))::int AS ai_avg_seconds,
            round(avg(extract(epoch FROM answered_at - asked_at)) FILTER (WHERE sender_type = 'agent'))::int AS agent_avg_seconds
       FROM resp`,
    [since],
  );

  const resolution = await one(
    `SELECT count(*)::int AS resolved,
            round(avg(extract(epoch FROM resolved_at - created_at)))::int AS avg_seconds,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at)))::int AS median_seconds,
            (SELECT count(*)::int FROM conversations WHERE status = 'open') AS open_now,
            (SELECT count(*)::int FROM conversations WHERE status = 'open' AND assigned_to IS NULL) AS unassigned_now
       FROM conversations WHERE resolved_at > now() - $1::interval AND resolved_at >= created_at`,
    [since],
  );

  const share = await many(
    `SELECT sender_type, count(*)::int AS count FROM messages WHERE direction = 'out' AND created_at > now() - $1::interval GROUP BY sender_type ORDER BY count DESC`,
    [since],
  );

  const agents = await many(
    `WITH m AS (
        SELECT conversation_id, direction, created_at, lag(direction) OVER (PARTITION BY conversation_id ORDER BY created_at) AS prev_dir
          FROM messages WHERE created_at > now() - $1::interval),
     turns AS (SELECT conversation_id, created_at AS asked_at FROM m WHERE direction = 'in' AND (prev_dir IS NULL OR prev_dir = 'out')),
     firsts AS (
        SELECT r.sender_user_id, extract(epoch FROM r.created_at - t.asked_at) AS secs FROM turns t
          JOIN LATERAL (SELECT x.sender_user_id, x.created_at, x.sender_type FROM messages x WHERE x.conversation_id = t.conversation_id
                          AND x.direction = 'out' AND x.sender_type IN ('agent','ai') AND x.created_at > t.asked_at ORDER BY x.created_at LIMIT 1) r ON r.sender_type = 'agent')
     SELECT u.id, u.name, u.role,
       (SELECT count(*) FROM messages x WHERE x.sender_user_id = u.id AND x.created_at > now() - $1::interval)::int AS messages_sent,
       (SELECT count(*) FROM conversations c WHERE c.resolved_by = u.id AND c.resolved_at > now() - $1::interval)::int AS resolved,
       (SELECT count(*) FROM conversations c WHERE c.assigned_to = u.id AND c.status = 'open')::int AS open_assigned,
       (SELECT round(avg(secs))::int FROM firsts f WHERE f.sender_user_id = u.id) AS avg_first_response_seconds
     FROM users u WHERE u.is_active AND u.role IN ('super_admin','admin','agent')
     ORDER BY messages_sent DESC, u.name`,
    [since],
  );

  const templates = await many(
    `SELECT template_name AS name,
            count(*)::int AS sent,
            count(*) FILTER (WHERE status IN ('delivered','read'))::int AS delivered,
            count(*) FILTER (WHERE status = 'read')::int AS read,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'held')::int AS held
       FROM messages WHERE template_name IS NOT NULL AND direction = 'out' AND created_at > now() - $1::interval
      GROUP BY template_name ORDER BY sent DESC LIMIT 20`,
    [since],
  );

  const ai = await one(
    `SELECT count(*) FILTER (WHERE decision = 'sent')::int AS auto_replies,
            count(*) FILTER (WHERE decision = 'suggested')::int AS suggestions,
            count(*) FILTER (WHERE decision IN ('fallback','blocked'))::int AS handed_to_team,
            count(*) FILTER (WHERE decision = 'error')::int AS errors
       FROM ai_logs WHERE created_at > now() - $1::interval AND mode <> 'test'`,
    [since],
  );

  const tickets = await one(
    `SELECT count(*) FILTER (WHERE created_at > now() - $1::interval)::int AS created,
            count(*) FILTER (WHERE status <> 'closed')::int AS open_now,
            count(*) FILTER (WHERE source = 'ai_fallback' AND created_at > now() - $1::interval)::int AS from_ai
       FROM tickets`,
    [since],
  );

  return { days, timezone: tz, perDay, response, resolution, share, agents, templates, ai, tickets };
}
