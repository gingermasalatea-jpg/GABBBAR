import { config } from '../config.js';
import { one, many, query } from '../db/pool.js';
import { encrypt, decrypt, parseKey } from '../lib/crypto.js';
import { DEFAULT_WORKING_HOURS } from '../lib/workingHours.js';

export const DEFAULTS = {
  general: {
    send_live: false,
    default_country_code: '91',
    opt_out_keywords: ['STOP', 'UNSUBSCRIBE', 'OPT OUT', 'OPTOUT', 'BAND KARO', 'STOP ALL'],
    opt_in_keywords: ['START', 'SUBSCRIBE', 'OPT IN'],
    opt_out_reply: 'You have been unsubscribed and will not receive further messages from us. Reply START to subscribe again.',
    opt_in_reply: 'Thanks! You are subscribed again.',
    broadcast_rate_per_sec: 20,
    auto_resolve_hours: 0,
  },
  whatsapp: {
    phone_number_id: '',
    waba_id: '',
    display_phone: '',
    graph_version: '',
  },
  business: {
    name: 'Demo Company',
    about: '',
    description: '',
    address: '',
    email: '',
    website: '',
    timezone: 'Asia/Kolkata',
  },
  working_hours: {
    ...DEFAULT_WORKING_HOURS,
    out_of_hours: {
      enabled: true,
      message: 'Thanks for reaching out! Our team is available Mon–Fri 9:30–18:30 and Sat 10:00–14:00 IST. We will reply as soon as we are back.',
    },
  },
  ai: {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    base_url: '',
    mode: 'suggest',
    tone: 'Warm, polite and concise. Sound like a helpful human team member, not a robot.',
    languages: ['English', 'Hindi', 'Hinglish'],
    dos: [
      'Reply in the same language and script the customer uses (English, Hindi or Hinglish).',
      'Keep replies short — 1 to 4 sentences — suitable for WhatsApp.',
      'Use the customer\'s first name when it is known.',
    ],
    donts: [
      'Do not promise delivery dates, refunds, discounts or outcomes.',
      'Do not share internal notes, ID numbers or payment proofs.',
      'Do not answer questions that are not covered by the knowledge base.',
    ],
    never_say: ['100% guaranteed', '100% sure', 'I promise', 'best price in India'],
    fallback_message: 'Thanks for your question! Let me check this with our team — someone will get back to you shortly.',
    max_history: 8,
    temperature: 0.3,
    min_relevance: 0.12,
  },
  google: {
    client_id: '',
    connected_email: '',
  },
};

export const SECRET_NAMES = [
  'whatsapp.access_token',
  'whatsapp.app_secret',
  'whatsapp.verify_token',
  'ai.anthropic_key',
  'ai.openai_key',
  'ai.gemini_key',
  'ai.compatible_key',
  'google.client_secret',
  'google.refresh_token',
];

let keyCache;
function key() {
  if (!keyCache) keyCache = parseKey(config.encryptionKey, config.jwtSecret);
  return keyCache;
}

const cache = new Map();
const TTL = 3000;

export function clearSettingsCache() {
  cache.clear();
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object' || !base || !over) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

export async function getSection(section) {
  const hit = cache.get(section);
  if (hit && hit.t > Date.now() - TTL) return hit.v;
  const row = await one('SELECT value FROM settings WHERE key = $1', [section]);
  const v = deepMerge(DEFAULTS[section] || {}, row?.value || {});
  cache.set(section, { v, t: Date.now() });
  return v;
}

export async function setSection(section, value, userId) {
  if (!(section in DEFAULTS)) throw new Error(`Unknown settings section ${section}`);
  const current = await getSection(section);
  const merged = deepMerge(current, value);
  await query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [section, merged, userId || null],
  );
  cache.delete(section);
  return merged;
}

export async function getAllSections() {
  const out = {};
  for (const s of Object.keys(DEFAULTS)) out[s] = await getSection(s);
  return out;
}

const ENV_SECRET = {
  'whatsapp.access_token': () => config.meta.accessToken,
  'whatsapp.app_secret': () => config.meta.appSecret,
  'whatsapp.verify_token': () => config.meta.verifyToken,
  'ai.anthropic_key': () => config.ai.anthropicKey,
  'ai.openai_key': () => config.ai.openaiKey,
  'ai.gemini_key': () => config.ai.geminiKey,
  'google.client_secret': () => config.google.clientSecret,
};

/** Server-side only. Never send the return value to the browser. */
export async function getSecret(name) {
  if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret ${name}`);
  const ck = `secret:${name}`;
  const hit = cache.get(ck);
  if (hit && hit.t > Date.now() - TTL) return hit.v;
  const row = await one('SELECT secret_enc FROM settings WHERE key = $1', [ck]);
  let v = '';
  if (row?.secret_enc) v = decrypt(row.secret_enc, key());
  if (!v && ENV_SECRET[name]) v = ENV_SECRET[name]() || '';
  cache.set(ck, { v, t: Date.now() });
  return v;
}

export async function setSecret(name, value, userId) {
  if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret ${name}`);
  const ck = `secret:${name}`;
  if (value === null || value === '') {
    await query('DELETE FROM settings WHERE key = $1', [ck]);
  } else {
    await query(
      `INSERT INTO settings (key, value, secret_enc, updated_by, updated_at) VALUES ($1, '{}', $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ck, encrypt(value, key()), userId || null],
    );
  }
  cache.delete(ck);
}

/** Which secrets are set — booleans only, safe for the frontend. */
export async function secretStatus() {
  const rows = await many(`SELECT key FROM settings WHERE key LIKE 'secret:%' AND secret_enc IS NOT NULL`);
  const stored = new Set(rows.map((r) => r.key.slice(7)));
  const out = {};
  for (const n of SECRET_NAMES) out[n] = { set: stored.has(n) || Boolean(ENV_SECRET[n]?.()), source: stored.has(n) ? 'settings' : ENV_SECRET[n]?.() ? 'env' : null };
  return out;
}

export function encryptValue(v) {
  return encrypt(v, key());
}
export function decryptValue(v) {
  return decrypt(v, key());
}

/** Resolved WhatsApp connection (settings override env). Server-side only. */
export async function getWhatsAppConfig() {
  const s = await getSection('whatsapp');
  return {
    phoneNumberId: s.phone_number_id || config.meta.phoneNumberId,
    wabaId: s.waba_id || config.meta.wabaId,
    graphVersion: s.graph_version || config.meta.graphVersion,
    accessToken: await getSecret('whatsapp.access_token'),
    appSecret: await getSecret('whatsapp.app_secret'),
    verifyToken: await getSecret('whatsapp.verify_token'),
  };
}

/** True when the app is allowed to deliver real messages to customers. */
export async function isSendLive() {
  if (config.mock.whatsapp) return false;
  const g = await getSection('general');
  return Boolean(g.send_live);
}
