import { one, many, query, tx } from '../db/pool.js';
import { toE164 } from '../lib/phone.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parseCsvWithHeaders, toCsv } from '../lib/csv.js';
import { getSection } from './settings.js';
import { publish } from './realtime.js';

export async function defaultCountryCode() {
  return (await getSection('general')).default_country_code || '91';
}

export async function normalizePhone(input) {
  const e164 = toE164(input, await defaultCountryCode());
  if (!e164) throw badRequest(`Invalid phone number: ${input}`);
  return e164;
}

export async function listCustomFields() {
  return many('SELECT * FROM custom_fields ORDER BY created_at');
}

function coerce(def, value) {
  if (value === null || value === undefined || value === '') return null;
  switch (def.type) {
    case 'number': {
      const n = Number(value);
      if (Number.isNaN(n)) throw badRequest(`${def.label} must be a number`);
      return n;
    }
    case 'boolean':
      return ['true', '1', 'yes', 'y', true, 1].includes(typeof value === 'string' ? value.toLowerCase() : value);
    case 'date': {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw badRequest(`${def.label} must be a date`);
      return d.toISOString().slice(0, 10);
    }
    case 'select': {
      const opts = Array.isArray(def.options) ? def.options : [];
      if (opts.length && !opts.includes(String(value))) throw badRequest(`${def.label} must be one of: ${opts.join(', ')}`);
      return String(value);
    }
    default:
      return String(value).slice(0, 2000);
  }
}

/** Validate a partial custom object against admin-defined fields. Unknown keys are rejected. */
export async function cleanCustom(custom = {}, { ignoreUnknown = false } = {}) {
  const defs = await listCustomFields();
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const out = {};
  for (const [k, v] of Object.entries(custom || {})) {
    const def = byKey.get(k);
    if (!def) {
      if (ignoreUnknown) continue;
      throw badRequest(`Unknown custom field "${k}" — create it in Settings → Contact fields first`);
    }
    out[k] = coerce(def, v);
  }
  return out;
}

export function cleanTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[;,|]/);
  return [...new Set(arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 50);
}

export async function getContact(id) {
  const c = await one('SELECT * FROM contacts WHERE id = $1', [id]);
  if (!c) throw notFound('Contact not found');
  return c;
}

export async function getContactByPhone(phone) {
  return one('SELECT * FROM contacts WHERE phone = $1', [phone]);
}

export async function createContact(data, { source = 'manual' } = {}) {
  const phone = await normalizePhone(data.phone);
  const custom = await cleanCustom(data.custom);
  const optIn = Boolean(data.opted_in);
  const c = await one(
    `INSERT INTO contacts (phone, name, email, tags, custom, opted_in, opt_in_source, opt_in_at, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      phone,
      data.name || null,
      data.email || null,
      cleanTags(data.tags),
      custom,
      optIn,
      optIn ? data.opt_in_source || source : null,
      optIn ? new Date() : null,
      source,
    ],
  );
  publish('contact.updated', { id: c.id });
  return c;
}

export async function updateContact(id, data) {
  const c = await getContact(id);
  const sets = [];
  const vals = [];
  const add = (col, v) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (data.phone !== undefined) add('phone', await normalizePhone(data.phone));
  if (data.name !== undefined) add('name', data.name || null);
  if (data.email !== undefined) add('email', data.email || null);
  if (data.tags !== undefined) add('tags', cleanTags(data.tags));
  if (data.custom !== undefined) add('custom', { ...c.custom, ...(await cleanCustom(data.custom)) });
  if (!sets.length) return c;
  vals.push(id);
  const updated = await one(`UPDATE contacts SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
  publish('contact.updated', { id });
  return updated;
}

export async function setOptIn(id, optedIn, source = 'manual') {
  const c = optedIn
    ? await one(
        `UPDATE contacts SET opted_in = true, opt_in_source = $2, opt_in_at = now(), opted_out_at = NULL, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, source],
      )
    : await one(`UPDATE contacts SET opted_in = false, opted_out_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [id]);
  if (!c) throw notFound('Contact not found');
  publish('contact.updated', { id });
  return c;
}

/**
 * Find or create by phone. Used for inbound WhatsApp messages, Sheets, webhooks and the REST API.
 * Inbound messages don't imply marketing opt-in; that is tracked separately.
 * @param {string} phoneInput
 * @param {{name?: string, email?: string, tags?: string[], custom?: object, is_demo?: boolean}} [fields]
 * @param {{source?: string, client?: any}} [opts]
 */
export async function upsertByPhone(phoneInput, fields = {}, { source = 'whatsapp', client } = {}) {
  const phone = await normalizePhone(phoneInput);
  const db = client || { query };
  const { rows } = await db.query(
    `INSERT INTO contacts (phone, name, email, tags, custom, source, is_demo)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (phone) DO UPDATE SET
       name = COALESCE(contacts.name, EXCLUDED.name),
       updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [phone, fields.name || null, fields.email || null, cleanTags(fields.tags), fields.custom || {}, source, Boolean(fields.is_demo)],
  );
  return rows[0];
}

export async function listContacts({ search, tag, optedIn, page = 1, limit = 50 }) {
  const where = [];
  const vals = [];
  if (search) {
    vals.push(`%${search.toLowerCase()}%`);
    where.push(`(lower(coalesce(name,'')) LIKE $${vals.length} OR phone LIKE $${vals.length} OR lower(coalesce(email,'')) LIKE $${vals.length})`);
  }
  if (tag) {
    vals.push(tag.toLowerCase());
    where.push(`$${vals.length} = ANY(tags)`);
  }
  if (optedIn === 'true' || optedIn === 'false') {
    vals.push(optedIn === 'true');
    where.push(`opted_in = $${vals.length}`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await one(`SELECT count(*)::int AS n FROM contacts ${w}`, vals)).n;
  vals.push(limit, (page - 1) * limit);
  const rows = await many(
    `SELECT * FROM contacts ${w} ORDER BY updated_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals,
  );
  return { rows, total, page, limit };
}

export async function allTags() {
  return many(`SELECT t AS tag, count(*)::int AS count FROM contacts, unnest(tags) t GROUP BY t ORDER BY count DESC, t`);
}

export async function deleteContact(id) {
  const r = await query('DELETE FROM contacts WHERE id = $1', [id]);
  if (!r.rowCount) throw notFound('Contact not found');
}

/**
 * Import a CSV. mapping: { "<CSV header exactly>": "phone" | "name" | "email" | "tags" | "opted_in" | "custom.<key>" | "" }
 * consentConfirmed must be true to mark rows as opted in (opt-in source = csv_import).
 */
export async function importCsv(csvText, mapping, { consentConfirmed = false, defaultTags = [] } = {}) {
  const { records } = parseCsvWithHeaders(csvText);
  const phoneHeader = Object.keys(mapping).find((h) => mapping[h] === 'phone');
  if (!phoneHeader) throw badRequest('Map one column to Phone');
  const cc = await defaultCountryCode();
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  const defs = await listCustomFields();
  const defByKey = new Map(defs.map((d) => [d.key, d]));

  for (const [idx, rec] of records.entries()) {
    const rowNo = idx + 2;
    const phone = toE164(rec[phoneHeader], cc);
    if (!phone) {
      result.skipped++;
      result.errors.push({ row: rowNo, error: `Invalid phone "${rec[phoneHeader]}"` });
      continue;
    }
    try {
      const fields = { custom: {}, tags: [...defaultTags] };
      let optIn = null;
      for (const [header, target] of Object.entries(mapping)) {
        if (!target || target === 'phone') continue;
        const v = rec[header];
        if (target === 'name' || target === 'email') fields[target] = v || undefined;
        else if (target === 'tags') fields.tags.push(...cleanTags(v));
        else if (target === 'opted_in') optIn = ['yes', 'y', 'true', '1', 'opted in', 'opt-in'].includes(String(v).toLowerCase());
        else if (target.startsWith('custom.')) {
          const def = defByKey.get(target.slice(7));
          if (def) fields.custom[def.key] = coerce(def, v);
        }
      }
      const existing = await getContactByPhone(phone);
      const tags = cleanTags([...(existing?.tags || []), ...fields.tags]);
      if (existing) {
        await query(
          `UPDATE contacts SET name = COALESCE($2, name), email = COALESCE($3, email), tags = $4,
             custom = custom || $5::jsonb, updated_at = now() WHERE id = $1`,
          [existing.id, fields.name || null, fields.email || null, tags, fields.custom],
        );
        result.updated++;
      } else {
        await query(
          `INSERT INTO contacts (phone, name, email, tags, custom, source) VALUES ($1,$2,$3,$4,$5,'csv_import')`,
          [phone, fields.name || null, fields.email || null, tags, fields.custom],
        );
        result.created++;
      }
      if (optIn === true && consentConfirmed) {
        await query(
          `UPDATE contacts SET opted_in = true, opt_in_source = 'csv_import', opt_in_at = now(), opted_out_at = NULL
           WHERE phone = $1 AND opted_out_at IS NULL`,
          [phone],
        );
      }
    } catch (err) {
      result.skipped++;
      result.errors.push({ row: rowNo, error: err.message });
    }
  }
  publish('contacts.imported', { created: result.created, updated: result.updated });
  return result;
}

export async function exportCsv() {
  const defs = await listCustomFields();
  const rows = await many('SELECT * FROM contacts ORDER BY created_at');
  const headers = ['phone', 'name', 'email', 'tags', 'opted_in', 'opt_in_source', 'opt_in_at', 'opted_out_at', 'created_at', ...defs.map((d) => d.key)];
  const records = rows.map((r) => ({
    ...r,
    tags: r.tags.join(';'),
    opt_in_at: r.opt_in_at?.toISOString?.() ?? '',
    opted_out_at: r.opted_out_at?.toISOString?.() ?? '',
    created_at: r.created_at?.toISOString?.() ?? '',
    ...Object.fromEntries(defs.map((d) => [d.key, r.custom?.[d.key] ?? ''])),
  }));
  return toCsv(headers, records);
}

/** Groups of likely duplicates: same email, or same name. (Phone is unique, so exact phone duplicates cannot exist.) */
export async function findDuplicates() {
  return many(`
    WITH g AS (
      SELECT 'email' AS reason, lower(email) AS k, array_agg(id ORDER BY created_at) AS ids
        FROM contacts WHERE email IS NOT NULL AND email <> '' GROUP BY lower(email) HAVING count(*) > 1
      UNION ALL
      SELECT 'name', lower(trim(name)), array_agg(id ORDER BY created_at)
        FROM contacts WHERE name IS NOT NULL AND trim(name) <> '' GROUP BY lower(trim(name)) HAVING count(*) > 1
    )
    SELECT g.reason, g.k AS value,
      (SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email,
              'tags', c.tags, 'created_at', c.created_at) ORDER BY c.created_at)
         FROM contacts c WHERE c.id = ANY(g.ids)) AS contacts
    FROM g ORDER BY g.reason, g.k LIMIT 200`);
}

/** Merge source contacts into the target. Conversations, messages, notes and tickets move to the target. */
export async function mergeContacts(targetId, sourceIds) {
  const sources = sourceIds.filter((s) => s !== targetId);
  if (!sources.length) throw badRequest('Choose at least one other contact to merge');
  return tx(async (c) => {
    const { rows: tRows } = await c.query('SELECT * FROM contacts WHERE id = $1 FOR UPDATE', [targetId]);
    const target = tRows[0];
    if (!target) throw notFound('Target contact not found');
    const { rows: srcRows } = await c.query('SELECT * FROM contacts WHERE id = ANY($1) FOR UPDATE', [sources]);
    if (srcRows.length !== sources.length) throw notFound('Some contacts to merge were not found');

    let tags = [...target.tags];
    let custom = { ...target.custom };
    let { name, email } = target;
    let optedIn = target.opted_in;
    let optInSource = target.opt_in_source;
    let optInAt = target.opt_in_at;
    let optedOutAt = target.opted_out_at;
    for (const s of srcRows) {
      tags = [...tags, ...s.tags];
      custom = { ...s.custom, ...custom }; // target wins
      name = name || s.name;
      email = email || s.email;
      if (s.opted_out_at && (!optedOutAt || s.opted_out_at > optedOutAt)) optedOutAt = s.opted_out_at;
      if (s.opted_in && !optedIn) {
        optedIn = true;
        optInSource = s.opt_in_source;
        optInAt = s.opt_in_at;
      }
    }
    // An opt-out anywhere wins over an older opt-in.
    if (optedOutAt && (!optInAt || optedOutAt > optInAt)) optedIn = false;

    const { rows: tConv } = await c.query('SELECT id FROM conversations WHERE contact_id = $1', [targetId]);
    let targetConvId = tConv[0]?.id;
    for (const s of srcRows) {
      const { rows: sConv } = await c.query('SELECT id FROM conversations WHERE contact_id = $1', [s.id]);
      if (sConv[0]) {
        if (!targetConvId) {
          await c.query('UPDATE conversations SET contact_id = $1 WHERE id = $2', [targetId, sConv[0].id]);
          targetConvId = sConv[0].id;
        } else {
          await c.query('UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2', [targetConvId, sConv[0].id]);
          await c.query('UPDATE notes SET conversation_id = $1 WHERE conversation_id = $2', [targetConvId, sConv[0].id]);
          await c.query('UPDATE tickets SET conversation_id = $1 WHERE conversation_id = $2', [targetConvId, sConv[0].id]);
          await c.query('UPDATE ai_logs SET conversation_id = $1 WHERE conversation_id = $2', [targetConvId, sConv[0].id]);
          await c.query(
            `INSERT INTO conversation_labels (conversation_id, label_id)
             SELECT $1, label_id FROM conversation_labels WHERE conversation_id = $2 ON CONFLICT DO NOTHING`,
            [targetConvId, sConv[0].id],
          );
          await c.query('DELETE FROM conversations WHERE id = $1', [sConv[0].id]);
        }
      }
      await c.query('UPDATE messages SET contact_id = $1 WHERE contact_id = $2', [targetId, s.id]);
      await c.query('UPDATE tickets SET contact_id = $1 WHERE contact_id = $2', [targetId, s.id]);
      await c.query('UPDATE broadcast_recipients SET contact_id = $1 WHERE contact_id = $2', [targetId, s.id]);
      await c.query('DELETE FROM contacts WHERE id = $1', [s.id]);
    }
    if (targetConvId) {
      await c.query(
        `UPDATE conversations SET
           last_message_at = (SELECT max(created_at) FROM messages WHERE conversation_id = $1),
           last_inbound_at = (SELECT max(created_at) FROM messages WHERE conversation_id = $1 AND direction = 'in')
         WHERE id = $1`,
        [targetConvId],
      );
    }
    const { rows } = await c.query(
      `UPDATE contacts SET tags = $2, custom = $3, name = $4, email = $5, opted_in = $6, opt_in_source = $7,
         opt_in_at = $8, opted_out_at = $9, updated_at = now() WHERE id = $1 RETURNING *`,
      [targetId, cleanTags(tags), custom, name, email, optedIn, optInSource, optInAt, optedOutAt],
    );
    return { contact: rows[0], merged: srcRows.length };
  });
}
