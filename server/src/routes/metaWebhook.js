import express, { Router } from 'express';
import { config } from '../config.js';
import { getWhatsAppConfig } from '../services/settings.js';
import { verifyMetaSignature } from '../whatsapp/signature.js';
import { enqueue } from '../queue/index.js';
import { logger } from '../lib/logger.js';
import { safeEqual } from '../lib/crypto.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * Meta WhatsApp webhook.
 *  GET  — subscription verification (hub.challenge)
 *  POST — events. Signature verified on EVERY request against the raw body, then
 *         the payload is queued and 200 is returned immediately.
 */
const r = Router();

r.get('/', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  const { verifyToken } = await getWhatsAppConfig();
  if (mode === 'subscribe' && verifyToken && safeEqual(token, verifyToken)) {
    logger.info('Meta webhook verified');
    return res.status(200).type('text/plain').send(challenge);
  }
  logger.warn('Meta webhook verification failed');
  res.sendStatus(403);
});

r.post(
  '/',
  rateLimit({ name: 'meta-webhook', windowMs: 60_000, max: 6000 }),
  express.raw({ type: '*/*', limit: '3mb' }),
  async (req, res) => {
    try {
      const { appSecret } = await getWhatsAppConfig();
      if (!appSecret) {
        logger.error('Rejected Meta webhook: App Secret is not configured (Settings → WhatsApp)');
        return res.sendStatus(401);
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      if (!verifyMetaSignature(raw, req.headers['x-hub-signature-256'], appSecret)) {
        logger.warn('Rejected Meta webhook: bad signature', { ip: req.ip });
        return res.sendStatus(401);
      }
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return res.sendStatus(400);
      }
      if (body.object !== 'whatsapp_business_account') return res.sendStatus(200);

      // De-duplicate retries of the same delivery at the queue level; per-message dedup happens in the worker.
      const ids = [];
      for (const e of body.entry || []) for (const c of e.changes || []) {
        for (const m of c.value?.messages || []) ids.push(m.id);
        for (const s of c.value?.statuses || []) ids.push(`${s.id}.${s.status}`);
      }
      const jobId = ids.length === 1 ? `wh:${ids[0]}` : undefined;
      await enqueue('inbound', 'webhook', { body, receivedAt: new Date().toISOString() }, { jobId });
      res.sendStatus(200);
    } catch (err) {
      // Could not queue (e.g. Redis down): return 500 so Meta retries later instead of losing the event.
      logger.error('Failed to queue Meta webhook', { err });
      res.sendStatus(500);
    }
  },
);

export default r;
export const META_WEBHOOK_PATH = '/api/webhooks/meta';
export const metaMockEnabled = () => config.mock.whatsapp;
