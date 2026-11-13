import { Router } from 'express';
import { config } from '../config.js';
import { one, many, query } from '../db/pool.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { z, body, uuid } from '../lib/validate.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { requirePermission } from '../middleware/auth.js';
import { API_SCOPES } from '../middleware/apiKey.js';
import { audit } from '../services/audit.js';
import { getSection, encryptValue } from '../services/settings.js';
import * as google from '../services/google.js';
import * as sheets from '../services/sheets.js';
import { OUTBOUND_EVENTS, assertSafeUrl } from '../services/webhooksOut.js';
import { enqueue } from '../queue/index.js';
import { logger } from '../lib/logger.js';

const r = Router();
const manage = requirePermission('connectors.manage');

/* ───── Google account ───── */

r.get(
  '/google',
  manage,
  ah(async (_req, res) => {
    const g = await getSection('google');
    res.json({ connected: Boolean(g.connected_email), email: g.connected_email, mock: config.mock.google, redirectUri: google.redirectUri(), clientId: g.client_id || config.google.clientId });
  }),
);

r.get(
  '/google/auth-url',
  manage,
  ah(async (req, res) => {
    res.json({ url: await google.authUrl(req.user.id) });
  }),
);

r.post(
  '/google/disconnect',
  manage,
  ah(async (req, res) => {
    await google.disconnect(req.user.id);
    await audit({ req, action: 'google.disconnected' });
    res.json({ ok: true });
  }),
);

/* ───── Sheets connections ───── */

const mappingSchema = z
  .array(
    z.object({
      column: z.string().min(1).max(200), // exact header text, never normalised
      field: z.string().regex(/^(phone|name|email|tags|opted_in|custom\.[a-z][a-z0-9_]{0,48})$/),
    }),
  )
  .min(1)
  .max(100);

const sheetInput = z.object({
  name: z.string().min(1).max(100),
  spreadsheet_id: z.string().regex(/^[\w-]{10,100}$/, 'Paste the ID from the sheet URL (between /d/ and /edit)'),
  sheet_name: z.string().min(1).max(100),
  key_column: z.string().min(1).max(200),
  mapping: mappingSchema,
  sync_direction: z.enum(['pull', 'push', 'both']).default('both'),
  interval_minutes: z.number().int().min(5).max(1440).default(15),
  default_opt_in: z.boolean().default(false),
  is_active: z.boolean().default(true),
});

r.get('/sheets', manage, ah(async (_req, res) => res.json({ connections: await sheets.listConnections() })));

r.post(
  '/sheets/inspect',
  manage,
  ah(async (req, res) => {
    const { spreadsheet_id, sheet_name } = body(z.object({ spreadsheet_id: z.string().min(5).max(100), sheet_name: z.string().max(100).optional() }), req);
    const info = await google.getSpreadsheetInfo(spreadsheet_id);
    const tab = sheet_name || info.sheets[0];
    const { headers, sample } = tab ? await sheets.readHeaders(spreadsheet_id, tab) : { headers: [], sample: [] };
    res.json({ ...info, sheet_name: tab, headers, sample });
  }),
);

r.post(
  '/sheets',
  manage,
  ah(async (req, res) => {
    const d = body(sheetInput, req);
    const { headers } = await sheets.readHeaders(d.spreadsheet_id, d.sheet_name);
    sheets.validateMapping(d.mapping, headers, d.key_column);
    const row = await one(
      `INSERT INTO sheet_connections (name, spreadsheet_id, sheet_name, key_column, mapping, sync_direction, interval_minutes, default_opt_in, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [d.name, d.spreadsheet_id, d.sheet_name, d.key_column, JSON.stringify(d.mapping), d.sync_direction, d.interval_minutes, d.default_opt_in, d.is_active, req.user.id],
    );
    await audit({ req, action: 'sheets.connection_created', entityType: 'sheet_connection', entityId: row.id, meta: { sheet: d.sheet_name, consent: d.default_opt_in } });
    await enqueue('sheets', 'sync', { connectionId: row.id }, { jobId: `sheet:${row.id}:first` });
    res.status(201).json({ connection: row });
  }),
);

r.put(
  '/sheets/:id',
  manage,
  ah(async (req, res) => {
    const d = body(sheetInput.partial(), req);
    const cur = await sheets.getConnection(req.params.id);
    const next = { ...cur, ...d };
    if (d.mapping || d.key_column || d.sheet_name) {
      const { headers } = await sheets.readHeaders(next.spreadsheet_id, next.sheet_name);
      sheets.validateMapping(next.mapping, headers, next.key_column);
    }
    const row = await one(
      `UPDATE sheet_connections SET name=$2, sheet_name=$3, key_column=$4, mapping=$5, sync_direction=$6, interval_minutes=$7, default_opt_in=$8, is_active=$9,
         row_state = CASE WHEN $10 THEN '{}'::jsonb ELSE row_state END, updated_at = now() WHERE id = $1 RETURNING *`,
      [cur.id, next.name, next.sheet_name, next.key_column, JSON.stringify(next.mapping), next.sync_direction, next.interval_minutes, next.default_opt_in, next.is_active, Boolean(d.mapping || d.sheet_name)],
    );
    await audit({ req, action: 'sheets.connection_updated', entityType: 'sheet_connection', entityId: row.id });
    res.json({ connection: row });
  }),
);

r.post(
  '/sheets/:id/sync',
  manage,
  ah(async (req, res) => {
    await sheets.getConnection(req.params.id);
    const stats = await sheets.syncConnection(req.params.id);
    await audit({ req, action: 'sheets.synced', entityType: 'sheet_connection', entityId: req.params.id, meta: stats });
    res.json({ stats });
  }),
);

r.delete(
  '/sheets/:id',
  manage,
  ah(async (req, res) => {
    const x = await query('DELETE FROM sheet_connections WHERE id = $1', [req.params.id]);
    if (!x.rowCount) throw notFound();
    await audit({ req, action: 'sheets.connection_deleted', entityType: 'sheet_connection', entityId: req.params.id });
    res.json({ ok: true });
  }),
);

/* ───── Webhooks (inbound + outbound) ───── */

r.get(
  '/webhooks',
  manage,
  ah(async (_req, res) => {
    const rows = await many(`SELECT id, name, direction, url, events, action, is_active, last_status, last_called_at, token_prefix, created_at FROM webhooks ORDER BY created_at`);
    res.json({ webhooks: rows, events: OUTBOUND_EVENTS, inboundBase: `${config.apiUrl}/api/hooks/in/` });
  }),
);

const inboundAction = z.object({
  type: z.enum(['upsert_contact', 'send_template']),
  template_id: uuid.optional(),
  add_tags: z.array(z.string().max(60)).max(10).default([]),
  mark_opted_in: z.boolean().default(false),
});

r.post(
  '/webhooks',
  manage,
  ah(async (req, res) => {
    const d = body(
      z.object({
        name: z.string().min(1).max(100),
        direction: z.enum(['in', 'out']),
        url: z.string().url().max(2000).optional(),
        events: z.array(z.enum(OUTBOUND_EVENTS)).default([]),
        action: inboundAction.optional(),
      }),
      req,
    );
    if (d.direction === 'out') {
      if (!d.url) throw badRequest('URL is required for outbound webhooks');
      await assertSafeUrl(d.url);
      if (!d.events.length) throw badRequest('Choose at least one event');
      const secret = `whsec_${randomToken(24)}`;
      const row = await one(
        `INSERT INTO webhooks (name, direction, url, events, secret_enc, created_by) VALUES ($1,'out',$2,$3,$4,$5) RETURNING id, name, direction, url, events, is_active`,
        [d.name, d.url, d.events, encryptValue(secret), req.user.id],
      );
      await audit({ req, action: 'webhook.created', entityType: 'webhook', entityId: row.id, meta: { direction: 'out', url: d.url } });
      return res.status(201).json({ webhook: row, secret, note: 'Copy the signing secret now — it will not be shown again.' });
    }
    if (!d.action) throw badRequest('Choose what the inbound webhook should do');
    if (d.action.type === 'send_template' && !d.action.template_id) throw badRequest('Choose a template');
    const token = `whin_${randomToken(24)}`;
    const row = await one(
      `INSERT INTO webhooks (name, direction, token_hash, token_prefix, action, created_by) VALUES ($1,'in',$2,$3,$4,$5) RETURNING id, name, direction, action, is_active, token_prefix`,
      [d.name, sha256Hex(token), token.slice(0, 10), d.action, req.user.id],
    );
    await audit({ req, action: 'webhook.created', entityType: 'webhook', entityId: row.id, meta: { direction: 'in', type: d.action.type } });
    res.status(201).json({ webhook: row, url: `${config.apiUrl}/api/hooks/in/${token}`, note: 'Copy this URL now — the token will not be shown again.' });
  }),
);

r.patch(
  '/webhooks/:id',
  manage,
  ah(async (req, res) => {
    const d = body(z.object({ is_active: z.boolean().optional(), events: z.array(z.enum(OUTBOUND_EVENTS)).optional(), name: z.string().min(1).max(100).optional() }), req);
    const row = await one(
      `UPDATE webhooks SET is_active = COALESCE($2, is_active), events = COALESCE($3, events), name = COALESCE($4, name) WHERE id = $1
       RETURNING id, name, direction, url, events, action, is_active, last_status`,
      [req.params.id, d.is_active ?? null, d.events ?? null, d.name ?? null],
    );
    if (!row) throw notFound();
    await audit({ req, action: 'webhook.updated', entityType: 'webhook', entityId: row.id, meta: d });
    res.json({ webhook: row });
  }),
);

r.delete(
  '/webhooks/:id',
  manage,
  ah(async (req, res) => {
    const x = await query('DELETE FROM webhooks WHERE id = $1', [req.params.id]);
    if (!x.rowCount) throw notFound();
    await audit({ req, action: 'webhook.deleted', entityType: 'webhook', entityId: req.params.id });
    res.json({ ok: true });
  }),
);

r.get(
  '/webhooks/:id/deliveries',
  manage,
  ah(async (req, res) => {
    res.json({ deliveries: await many('SELECT id, event, status, response_code, attempts, error, created_at FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 50', [req.params.id]) });
  }),
);

/* ───── API keys ───── */

r.get(
  '/api-keys',
  manage,
  ah(async (_req, res) => {
    const rows = await many(`SELECT k.id, k.name, k.prefix, k.scopes, k.last_used_at, k.revoked_at, k.created_at, u.name AS created_by_name
       FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.created_at DESC`);
    res.json({ keys: rows, scopes: API_SCOPES });
  }),
);

r.post(
  '/api-keys',
  manage,
  ah(async (req, res) => {
    const d = body(z.object({ name: z.string().min(1).max(100), scopes: z.array(z.enum(API_SCOPES)).min(1) }), req);
    const key = `wak_${randomToken(32)}`;
    const row = await one(`INSERT INTO api_keys (name, prefix, key_hash, scopes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, prefix, scopes, created_at`, [
      d.name,
      key.slice(0, 12),
      sha256Hex(key),
      d.scopes,
      req.user.id,
    ]);
    await audit({ req, action: 'api_key.created', entityType: 'api_key', entityId: row.id, meta: { name: d.name, scopes: d.scopes } });
    res.status(201).json({ key: row, secret: key, note: 'Copy this key now — it will not be shown again.' });
  }),
);

r.delete(
  '/api-keys/:id',
  manage,
  ah(async (req, res) => {
    const x = await query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [req.params.id]);
    if (!x.rowCount) throw notFound();
    await audit({ req, action: 'api_key.revoked', entityType: 'api_key', entityId: req.params.id });
    res.json({ ok: true });
  }),
);

export default r;

/* ───── Public Google OAuth callback (state-verified, no cookie required) ───── */
export const googleCallback = Router();

googleCallback.get('/', async (req, res) => {
  const back = (q) => res.writeHead(302, { Location: `${config.appUrl}/settings?tab=connectors&${q}` }).end();
  try {
    if (req.query.error) return back(`google=error&reason=${encodeURIComponent(String(req.query.error))}`);
    const state = google.verifyState(String(req.query.state || ''));
    await google.handleCallback(String(req.query.code || ''), state.sub);
    await audit({ req, userId: state.sub, actorType: 'user', action: 'google.connected' });
    back('google=connected');
  } catch (err) {
    logger.warn('Google OAuth callback failed', { err });
    back(`google=error&reason=${encodeURIComponent(err.message)}`);
  }
});
