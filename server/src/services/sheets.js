import { one, many, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { toE164 } from '../lib/phone.js';
import { cellRange, rowFingerprint } from '../lib/a1.js';
import { enqueue } from '../queue/index.js';
import * as google from './google.js';
import { cleanTags, defaultCountryCode, listCustomFields } from './contacts.js';

/**
 * Two-way Google Sheets ↔ contacts sync.
 * mapping: [{ column: "<header text exactly as in the sheet>", field: "phone"|"name"|"email"|"tags"|"opted_in"|"custom.<key>" }]
 * Header names are stored and matched exactly (including spelling and spacing).
 *
 * Conflict rule per row: if the sheet row changed since the last sync, the sheet wins (pull);
 * otherwise, if the contact changed since the last sync, the contact wins (push).
 */

const YES = ['yes', 'y', 'true', '1', 'opted in', 'opt-in', 'haan', 'ha'];

export async function listConnections() {
  return many('SELECT id, name, spreadsheet_id, sheet_name, key_column, mapping, sync_direction, interval_minutes, default_opt_in, is_active, last_synced_at, last_status, last_error, created_at FROM sheet_connections ORDER BY created_at');
}

export async function getConnection(id) {
  const c = await one('SELECT * FROM sheet_connections WHERE id = $1', [id]);
  if (!c) throw notFound('Sheet connection not found');
  return c;
}

export async function readHeaders(spreadsheetId, sheetName) {
  const rows = await google.readRows(spreadsheetId, sheetName);
  return { headers: rows[0] || [], sample: rows.slice(1, 4) };
}

export function validateMapping(mapping, headers, keyColumn) {
  if (!headers.includes(keyColumn)) throw badRequest(`Key column "${keyColumn}" was not found in the sheet header row`);
  for (const m of mapping) if (!headers.includes(m.column)) throw badRequest(`Column "${m.column}" was not found in the sheet header row`);
  const phoneMap = mapping.find((m) => m.field === 'phone');
  if (!phoneMap || phoneMap.column !== keyColumn) throw badRequest('Map the key column to Phone');
}

function readField(contact, field) {
  if (field === 'phone') return contact.phone;
  if (field === 'name') return contact.name || '';
  if (field === 'email') return contact.email || '';
  if (field === 'tags') return (contact.tags || []).join(', ');
  if (field === 'opted_in') return contact.opted_in ? 'Yes' : 'No';
  if (field.startsWith('custom.')) {
    const v = contact.custom?.[field.slice(7)];
    return v === null || v === undefined ? '' : String(v);
  }
  return '';
}

function coerceCustom(def, raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  if (def.type === 'number') {
    const n = Number(String(raw).replace(/[,₹\s]/g, ''));
    return Number.isNaN(n) ? null : n;
  }
  if (def.type === 'boolean') return YES.includes(String(raw).toLowerCase());
  return String(raw).slice(0, 2000);
}

export async function syncConnection(id) {
  const conn = await getConnection(id);
  if (!conn.is_active) return { skipped: true };
  const started = new Date();
  try {
    const rows = await google.readRows(conn.spreadsheet_id, conn.sheet_name);
    const headers = rows[0] || [];
    validateMapping(conn.mapping, headers, conn.key_column);
    const keyIdx = headers.indexOf(conn.key_column);
    const cols = conn.mapping.map((m) => ({ ...m, idx: headers.indexOf(m.column) }));
    const cc = await defaultCountryCode();
    const defs = new Map((await listCustomFields()).map((d) => [d.key, d]));
    const prevState = conn.row_state || {};
    const nextState = {};
    const lastSync = conn.last_synced_at ? new Date(conn.last_synced_at) : new Date(0);
    const pull = conn.sync_direction !== 'push';
    const push = conn.sync_direction !== 'pull';
    const stats = { pulled: 0, pushed: 0, appended: 0, created: 0, skipped: 0 };
    const updates = [];
    const seenPhones = new Set();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const phone = toE164(row[keyIdx], cc);
      if (!phone) {
        if (String(row[keyIdx] || '').trim()) stats.skipped++;
        continue;
      }
      if (seenPhones.has(phone)) {
        stats.skipped++;
        continue;
      }
      seenPhones.add(phone);
      const sheetVals = cols.map((c) => row[c.idx] ?? '');
      const fp = rowFingerprint(sheetVals);
      const sheetChanged = prevState[phone] !== fp;
      let contact = await one('SELECT * FROM contacts WHERE phone = $1', [phone]);

      if (pull && (sheetChanged || !contact)) {
        const fields = { custom: {} };
        let optIn = null;
        for (const c of cols) {
          const v = String(row[c.idx] ?? '').trim();
          if (c.field === 'name') fields.name = v || null;
          else if (c.field === 'email') fields.email = v || null;
          else if (c.field === 'tags') fields.tags = cleanTags(v);
          else if (c.field === 'opted_in') optIn = YES.includes(v.toLowerCase());
          else if (c.field.startsWith('custom.')) {
            const def = defs.get(c.field.slice(7));
            if (def) fields.custom[def.key] = coerceCustom(def, v);
          }
        }
        if (!contact) {
          contact = await one(
            `INSERT INTO contacts (phone, name, email, tags, custom, source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [phone, fields.name ?? null, fields.email ?? null, fields.tags ?? [], fields.custom, `google_sheet`],
          );
          stats.created++;
        } else {
          contact = await one(
            `UPDATE contacts SET name = COALESCE($2, name), email = CASE WHEN $6 THEN $3 ELSE email END,
               tags = CASE WHEN $7 THEN $4 ELSE tags END, custom = custom || $5::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
            [contact.id, fields.name ?? null, fields.email ?? null, fields.tags ?? [], fields.custom, 'email' in fields, 'tags' in fields],
          );
          stats.pulled++;
        }
        // Consent only counts when the admin confirmed this sheet records real WhatsApp opt-in.
        if (optIn === true && conn.default_opt_in && !contact.opted_in && !contact.opted_out_at) {
          contact = await one(`UPDATE contacts SET opted_in = true, opt_in_source = 'google_sheet', opt_in_at = now() WHERE id = $1 RETURNING *`, [contact.id]);
        }
        nextState[phone] = fp;
        continue;
      }

      if (push && contact && new Date(contact.updated_at) > lastSync) {
        const newVals = cols.map((c) => readField(contact, c.field));
        newVals.forEach((v, k) => {
          if (cols[k].field === 'phone') return; // never rewrite the key cell format
          if (String(sheetVals[k] ?? '') !== v) updates.push({ row: i + 1, col: cols[k].idx, value: v });
        });
        nextState[phone] = rowFingerprint(newVals.map((v, k) => (cols[k].field === 'phone' ? sheetVals[k] : v)));
        stats.pushed++;
        continue;
      }
      nextState[phone] = fp;
    }

    if (updates.length) await google.writeCells(conn.spreadsheet_id, conn.sheet_name, updates, cellRange);

    // Push: append contacts created since the connection was set up that are not in the sheet yet.
    if (push) {
      const fresh = await many(
        `SELECT * FROM contacts WHERE created_at > $1 AND source <> 'google_sheet' AND NOT (phone = ANY($2)) ORDER BY created_at LIMIT 500`,
        [conn.created_at, [...seenPhones]],
      );
      const width = headers.length;
      const newRows = fresh.map((c) => {
        const r = Array(width).fill('');
        for (const m of cols) r[m.idx] = readField(c, m.field);
        nextState[c.phone] = rowFingerprint(cols.map((m) => readField(c, m.field)));
        return r;
      });
      await google.appendRows(conn.spreadsheet_id, conn.sheet_name, newRows);
      stats.appended = newRows.length;
    }

    await query(`UPDATE sheet_connections SET last_synced_at = $2, last_status = $3, last_error = NULL, row_state = $4, updated_at = now() WHERE id = $1`, [
      id,
      started,
      `ok: ${stats.created} new, ${stats.pulled} pulled, ${stats.pushed} pushed, ${stats.appended} appended${stats.skipped ? `, ${stats.skipped} skipped` : ''}`,
      { ...prevState, ...nextState },
    ]);
    logger.info('Sheets sync complete', { id, ...stats });
    return stats;
  } catch (err) {
    await query(`UPDATE sheet_connections SET last_status = 'error', last_error = $2, updated_at = now() WHERE id = $1`, [id, String(err.message).slice(0, 1000)]);
    throw err;
  }
}

/** Run every active connection whose interval has elapsed (called by the scheduler every few minutes). */
export async function syncDue() {
  const due = await many(
    `SELECT id FROM sheet_connections WHERE is_active AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(mins => interval_minutes))`,
  );
  for (const c of due) await enqueue('sheets', 'sync', { connectionId: c.id }, { jobId: `sheet:${c.id}:${Math.floor(Date.now() / 60_000)}` });
  return due.length;
}

/** Contact changed in the app — schedule a push soon (coalesced per minute). */
export async function queueSheetPush() {
  const active = await many(`SELECT id FROM sheet_connections WHERE is_active AND sync_direction <> 'pull'`);
  for (const c of active) {
    await enqueue('sheets', 'sync', { connectionId: c.id }, { jobId: `sheet:${c.id}:${Math.floor(Date.now() / 60_000)}`, delayMs: 30_000 });
  }
}
