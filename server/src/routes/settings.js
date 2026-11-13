import { Router } from 'express';
import { config } from '../config.js';
import { ah, forbidden, badRequest } from '../lib/errors.js';
import { z, body } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { can } from '../lib/permissions.js';
import * as settings from '../services/settings.js';
import { audit } from '../services/audit.js';
import { publish } from '../services/realtime.js';

const r = Router();

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM');
const slots = z.array(z.object({ start: hhmm, end: hhmm })).max(4);
const strList = (max = 50, len = 300) => z.array(z.string().trim().min(1).max(len)).max(max);

const SCHEMAS = {
  general: z
    .object({
      send_live: z.boolean(),
      default_country_code: z.string().regex(/^\d{1,4}$/),
      opt_out_keywords: strList(30, 40),
      opt_in_keywords: strList(30, 40),
      opt_out_reply: z.string().max(1000),
      opt_in_reply: z.string().max(1000),
      broadcast_rate_per_sec: z.number().int().min(1).max(80),
      auto_resolve_hours: z.number().int().min(0).max(720),
    })
    .partial(),
  whatsapp: z
    .object({
      phone_number_id: z.string().regex(/^\d*$/, 'Digits only').max(40),
      waba_id: z.string().regex(/^\d*$/, 'Digits only').max(40),
      display_phone: z.string().max(30),
      graph_version: z.string().regex(/^(v\d+\.\d+)?$/).max(10),
    })
    .partial(),
  business: z
    .object({
      name: z.string().max(200),
      about: z.string().max(500),
      description: z.string().max(5000),
      address: z.string().max(500),
      email: z.string().max(200),
      website: z.string().max(300),
      timezone: z.string().max(60),
    })
    .partial(),
  working_hours: z
    .object({
      timezone: z.string().max(60),
      days: z.object({ mon: slots, tue: slots, wed: slots, thu: slots, fri: slots, sat: slots, sun: slots }),
      out_of_hours: z.object({ enabled: z.boolean(), message: z.string().max(1000) }),
    })
    .partial(),
  ai: z
    .object({
      provider: z.enum(['anthropic', 'openai', 'gemini', 'compatible']),
      model: z.string().max(100),
      base_url: z.string().max(300).refine((u) => !u || /^https?:\/\//.test(u), 'Must start with http(s)://'),
      mode: z.enum(['off', 'suggest', 'auto']),
      tone: z.string().max(1000),
      languages: strList(10, 40),
      dos: strList(40),
      donts: strList(40),
      never_say: strList(100, 100),
      fallback_message: z.string().max(1000),
      max_history: z.number().int().min(0).max(30),
      temperature: z.number().min(0).max(1),
      min_relevance: z.number().min(0).max(1),
    })
    .partial(),
  google: z.object({ client_id: z.string().max(200) }).partial(),
};

r.get(
  '/',
  requirePermission('settings.view'),
  ah(async (_req, res) => {
    res.json({
      settings: await settings.getAllSections(),
      secrets: await settings.secretStatus(),
      mock: config.mock,
      webhookUrl: `${config.apiUrl}/api/webhooks/meta`,
      googleRedirectUri: `${config.appUrl}/api/connectors/google/callback`,
    });
  }),
);

/** Lightweight status any signed-in user can read (banner in the UI). */
r.get(
  '/status',
  ah(async (_req, res) => {
    const g = await settings.getSection('general');
    const wa = await settings.getWhatsAppConfig();
    const ai = await settings.getSection('ai');
    const b = await settings.getSection('business');
    res.json({
      sendLive: await settings.isSendLive(),
      sendLiveSetting: g.send_live,
      whatsappConnected: Boolean(!config.mock.whatsapp && wa.phoneNumberId && wa.accessToken),
      mock: config.mock,
      aiMode: ai.mode,
      aiProvider: ai.provider,
      businessName: b.name,
    });
  }),
);

r.put(
  '/:section',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const section = req.params.section;
    const schema = SCHEMAS[section];
    if (!schema) throw badRequest('Unknown settings section');
    const data = body(schema, req);
    if (section === 'general' && 'send_live' in data) {
      if (!can(req.user.role, 'send_live.toggle')) throw forbidden('Only admins can change Send live');
      if (data.send_live && config.mock.whatsapp) {
        throw badRequest('WhatsApp is in mock mode (WHATSAPP_MOCK=true). Add real credentials and set WHATSAPP_MOCK=false first.');
      }
    }
    const before = await settings.getSection(section);
    const saved = await settings.setSection(section, data, req.user.id);
    await audit({
      req,
      action: section === 'general' && data.send_live !== undefined && data.send_live !== before.send_live
        ? `settings.send_live_${data.send_live ? 'on' : 'off'}`
        : 'settings.updated',
      entityType: 'settings',
      entityId: section,
      meta: { fields: Object.keys(data) },
    });
    publish('settings.updated', { section });
    res.json({ section, value: saved });
  }),
);

/** Write-only secrets. The value is encrypted and is never returned by any endpoint. */
r.put(
  '/secrets/:name',
  requirePermission('settings.secrets'),
  ah(async (req, res) => {
    const name = req.params.name;
    if (!settings.SECRET_NAMES.includes(name)) throw badRequest('Unknown secret');
    const { value } = body(z.object({ value: z.string().max(4000).nullable() }), req);
    await settings.setSecret(name, value ? value.trim() : null, req.user.id);
    await audit({ req, action: value ? 'secret.set' : 'secret.cleared', entityType: 'secret', entityId: name });
    res.json({ name, set: Boolean(value) });
  }),
);

export default r;
