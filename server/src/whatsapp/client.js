import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getWhatsAppConfig } from '../services/settings.js';
import { fromGraphResponse, MetaApiError } from './metaErrors.js';

/**
 * WhatsApp Cloud API client. Official Graph API only.
 * When WHATSAPP_MOCK=true a local mock with the same interface is used instead.
 */

async function graph(method, pathname, { body, query, form, token, cfg } = {}) {
  const c = cfg || (await getWhatsAppConfig());
  const accessToken = token || c.accessToken;
  if (!accessToken) throw new MetaApiError({ status: 401, code: 190, message: 'WhatsApp access token is not configured' });
  const url = new URL(`https://graph.facebook.com/${c.graphVersion}/${pathname.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: form || (body ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const e = new MetaApiError({ status: 503, code: 2, message: `Network error calling Meta: ${err.message}` });
    throw e;
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok || data?.error) throw fromGraphResponse(res.status, data);
  return data;
}

const real = {
  isMock: false,
  async sendMessage(payload) {
    const c = await getWhatsAppConfig();
    if (!c.phoneNumberId) throw new MetaApiError({ status: 400, code: 100, message: 'Phone Number ID is not configured' });
    const r = await graph('POST', `${c.phoneNumberId}/messages`, { body: payload, cfg: c });
    return { waMessageId: r.messages?.[0]?.id, raw: r };
  },
  async markRead(waMessageId) {
    const c = await getWhatsAppConfig();
    return graph('POST', `${c.phoneNumberId}/messages`, { body: { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId }, cfg: c });
  },
  async getPhoneNumberInfo() {
    const c = await getWhatsAppConfig();
    if (!c.phoneNumberId) throw new MetaApiError({ status: 400, code: 100, message: 'Phone Number ID is not configured' });
    return graph('GET', c.phoneNumberId, { query: { fields: 'verified_name,display_phone_number,quality_rating,code_verification_status,platform_type,throughput,name_status' }, cfg: c });
  },
  async getMediaInfo(mediaId) {
    return graph('GET', mediaId);
  },
  async downloadMedia(url, maxBytes = 100 * 1024 * 1024) {
    const c = await getWhatsAppConfig();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${c.accessToken}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new MetaApiError({ status: res.status, code: res.status === 404 ? 131052 : undefined, message: `Media download failed (${res.status})` });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new MetaApiError({ status: 413, code: 131052, message: 'Media too large' });
    return Buffer.from(await res.arrayBuffer());
  },
  async uploadMedia(buffer, mimeType, filename) {
    const c = await getWhatsAppConfig();
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', mimeType);
    form.set('file', new Blob([buffer], { type: mimeType }), filename || 'file');
    const r = await graph('POST', `${c.phoneNumberId}/media`, { form, cfg: c });
    return { id: r.id };
  },
  async createTemplate(t) {
    const c = await getWhatsAppConfig();
    if (!c.wabaId) throw new MetaApiError({ status: 400, code: 100, message: 'WABA ID is not configured' });
    return graph('POST', `${c.wabaId}/message_templates`, { body: t, cfg: c });
  },
  async listTemplates() {
    const c = await getWhatsAppConfig();
    if (!c.wabaId) throw new MetaApiError({ status: 400, code: 100, message: 'WABA ID is not configured' });
    const out = [];
    let after;
    for (let page = 0; page < 50; page++) {
      const r = await graph('GET', `${c.wabaId}/message_templates`, {
        query: { limit: 100, after, fields: 'id,name,status,category,language,components,rejected_reason,quality_score' },
        cfg: c,
      });
      out.push(...(r.data || []));
      after = r.paging?.cursors?.after;
      if (!r.paging?.next || !after) break;
    }
    return out;
  },
  async deleteTemplate(name) {
    const c = await getWhatsAppConfig();
    return graph('DELETE', `${c.wabaId}/message_templates`, { query: { name }, cfg: c });
  },
};

/* ───────────── Mock (demo mode) ───────────── */

const mockDir = () => path.join(config.mediaDir, '_mock');

const mock = {
  isMock: true,
  async sendMessage(payload) {
    if (!payload?.to) throw new MetaApiError({ status: 400, code: 100, message: 'Recipient missing' });
    return { waMessageId: `wamid.MOCK.${crypto.randomBytes(12).toString('hex')}`, raw: { mock: true } };
  },
  async markRead() {
    return { success: true };
  },
  async getPhoneNumberInfo() {
    return { verified_name: 'Demo Business (mock)', display_phone_number: '+91 90000 00000', quality_rating: 'GREEN', platform_type: 'CLOUD_API', mock: true };
  },
  async getMediaInfo(mediaId) {
    const meta = JSON.parse(await fs.readFile(path.join(mockDir(), `${mediaId}.json`), 'utf8').catch(() => '{}'));
    return { url: `mock://${mediaId}`, mime_type: meta.mime_type || 'application/octet-stream', file_size: meta.size };
  },
  async downloadMedia(url) {
    const id = String(url).replace('mock://', '');
    return fs.readFile(path.join(mockDir(), `${id}.bin`));
  },
  async uploadMedia(buffer, mimeType) {
    const id = `mockmedia${crypto.randomBytes(8).toString('hex')}`;
    await fs.mkdir(mockDir(), { recursive: true });
    await fs.writeFile(path.join(mockDir(), `${id}.bin`), buffer);
    await fs.writeFile(path.join(mockDir(), `${id}.json`), JSON.stringify({ mime_type: mimeType, size: buffer.length }));
    return { id };
  },
  async createTemplate(t) {
    return { id: `mocktpl_${crypto.randomBytes(6).toString('hex')}`, status: 'PENDING', category: t.category };
  },
  async listTemplates() {
    return null; // signal: nothing to sync from Meta in mock mode
  },
  async deleteTemplate() {
    return { success: true };
  },
};

export function getClient() {
  return config.mock.whatsapp ? mock : real;
}

export { mock as mockClient };
