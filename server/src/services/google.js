import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { signJwt, verifyJwt } from '../lib/jwt.js';
import { randomToken } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { getSecret, setSecret, getSection, setSection } from './settings.js';

/**
 * Google OAuth + Sheets REST v4 (no SDK). In GOOGLE_MOCK mode a local JSON "spreadsheet"
 * stands in, so mapping and two-way sync can be tried without a Google account.
 */

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/userinfo.email'];

export function redirectUri() {
  return `${config.appUrl}/api/connectors/google/callback`;
}

async function clientCreds() {
  const g = await getSection('google');
  return { clientId: g.client_id || config.google.clientId, clientSecret: await getSecret('google.client_secret') };
}

export async function authUrl(userId) {
  const state = signJwt({ sub: userId, n: randomToken(8), purpose: 'google_oauth' }, config.jwtSecret, { expiresInSeconds: 600 });
  if (config.mock.google) return `${redirectUri()}?code=mock-code&state=${encodeURIComponent(state)}`;
  const { clientId } = await clientCreds();
  if (!clientId) throw badRequest('Set the Google OAuth Client ID and secret first');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  return u.toString();
}

export function verifyState(state) {
  const p = verifyJwt(state, config.jwtSecret);
  if (p.purpose !== 'google_oauth') throw new Error('Invalid state');
  return p;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Google OAuth error: ${data.error_description || data.error || res.status}`), { permanent: res.status === 400 || res.status === 401 });
  return data;
}

export async function handleCallback(code, userId) {
  if (config.mock.google) {
    await setSecret('google.refresh_token', 'mock-refresh-token', userId);
    await setSection('google', { connected_email: 'demo-sheets@example.com' }, userId);
    return { email: 'demo-sheets@example.com' };
  }
  const { clientId, clientSecret } = await clientCreds();
  const tok = await tokenRequest({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
  if (!tok.refresh_token) throw new Error('Google did not return a refresh token — remove the app from your Google account permissions and connect again');
  await setSecret('google.refresh_token', tok.refresh_token, userId);
  const info = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json()).catch(() => ({}));
  await setSection('google', { connected_email: info.email || '' }, userId);
  accessCache = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
  return { email: info.email };
}

export async function disconnect(userId) {
  await setSecret('google.refresh_token', null, userId);
  await setSection('google', { connected_email: '' }, userId);
  accessCache = null;
}

let accessCache = null;
async function accessToken() {
  if (accessCache && accessCache.exp > Date.now()) return accessCache.token;
  const refresh = await getSecret('google.refresh_token');
  if (!refresh) throw Object.assign(new Error('Google account is not connected'), { permanent: true });
  const { clientId, clientSecret } = await clientCreds();
  const tok = await tokenRequest({ refresh_token: refresh, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' });
  accessCache = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
  return tok.access_token;
}

async function sheetsApi(method, url, body) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${url}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google Sheets error ${res.status}: ${data.error?.message || 'unknown'}`);
    err.permanent = res.status === 400 || res.status === 403 || res.status === 404;
    if (res.status === 429) err.retryAfterMs = 60_000;
    if (res.status === 401) accessCache = null;
    throw err;
  }
  return data;
}

/* ───────── Mock spreadsheet (JSON file) ───────── */

const mockFile = (id) => path.join(config.mediaDir, '_mock', 'sheets', `${id.replace(/[^\w-]/g, '_')}.json`);

const MOCK_SEED = {
  title: 'Customer Master (demo)',
  sheets: {
    Customers: [
      ['Customer Name', 'Mobile No.', 'City', 'Order Status', 'Adress', 'PAN No', 'WhatsApp Consent'],
      ['Rahul Sharma', '9000000001', 'Lucknow', 'Shipped', '12 Hazratganj, Lucknow', 'ABCDE1000F', 'Yes'],
      ['Meena Kumari', '9812300001', 'Varanasi', 'Placed', '7 Lanka, Varanasi', 'PQRSX1234Z', 'Yes'],
      ['Sanjay Rawat', '9812300002', 'Dehradun', 'Delivered', '', '', 'No'],
    ],
  },
};

async function mockRead(id) {
  try {
    return JSON.parse(await fs.readFile(mockFile(id), 'utf8'));
  } catch {
    await fs.mkdir(path.dirname(mockFile(id)), { recursive: true });
    await fs.writeFile(mockFile(id), JSON.stringify(MOCK_SEED, null, 2));
    return structuredClone(MOCK_SEED);
  }
}
async function mockWrite(id, data) {
  await fs.writeFile(mockFile(id), JSON.stringify(data, null, 2));
}

/* ───────── Public helpers ───────── */

export async function getSpreadsheetInfo(spreadsheetId) {
  if (config.mock.google) {
    const d = await mockRead(spreadsheetId);
    return { title: d.title, sheets: Object.keys(d.sheets) };
  }
  const d = await sheetsApi('GET', `${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`);
  return { title: d.properties?.title, sheets: (d.sheets || []).map((s) => s.properties.title) };
}

/** All rows as arrays of strings (row 1 = headers). */
export async function readRows(spreadsheetId, sheetName) {
  if (config.mock.google) {
    const d = await mockRead(spreadsheetId);
    if (!d.sheets[sheetName]) throw Object.assign(new Error(`Tab "${sheetName}" not found`), { permanent: true });
    return d.sheets[sheetName].map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))));
  }
  const range = encodeURIComponent(`'${sheetName.replace(/'/g, "''")}'`);
  const d = await sheetsApi('GET', `${encodeURIComponent(spreadsheetId)}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
  return (d.values || []).map((r) => r.map((v) => String(v ?? '')));
}

/** updates: [{ row: 1-based, col: 0-based, value }] */
export async function writeCells(spreadsheetId, sheetName, updates, a1) {
  if (!updates.length) return;
  if (config.mock.google) {
    const d = await mockRead(spreadsheetId);
    const rows = d.sheets[sheetName];
    for (const u of updates) {
      while (rows.length < u.row) rows.push([]);
      const r = rows[u.row - 1];
      while (r.length <= u.col) r.push('');
      r[u.col] = u.value;
    }
    await mockWrite(spreadsheetId, d);
    return;
  }
  await sheetsApi('POST', `${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, {
    valueInputOption: 'RAW',
    data: updates.map((u) => ({ range: a1(sheetName, u.col, u.row), values: [[u.value]] })),
  });
}

export async function appendRows(spreadsheetId, sheetName, rows) {
  if (!rows.length) return;
  if (config.mock.google) {
    const d = await mockRead(spreadsheetId);
    d.sheets[sheetName].push(...rows);
    await mockWrite(spreadsheetId, d);
    return;
  }
  const range = encodeURIComponent(`'${sheetName.replace(/'/g, "''")}'!A1`);
  await sheetsApi('POST', `${encodeURIComponent(spreadsheetId)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
}
