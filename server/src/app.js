import express from 'express';
import { config } from './config.js';
import { securityHeaders, cors, notFoundHandler, errorHandler } from './middleware/security.js';
import { requireAuth, requirePermission } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { bus } from './services/realtime.js';
import { can } from './lib/permissions.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import settingsRoutes from './routes/settings.js';
import contactRoutes, { customFields } from './routes/contacts.js';
import auditRoutes from './routes/audit.js';
import metaWebhook from './routes/metaWebhook.js';
import whatsappRoutes from './routes/whatsapp.js';
import templateRoutes from './routes/templates.js';
import { mediaRouter, dlqRouter } from './routes/ops.js';
import conversationRoutes, { labelsRouter } from './routes/conversations.js';
import connectorRoutes, { googleCallback } from './routes/connectors.js';
import publicApi from './routes/publicApi.js';
import hooksIn from './routes/hooksIn.js';
import aiRoutes, { knowledgeRouter, ticketsRouter } from './routes/ai.js';
import automationRoutes, { analyticsRouter } from './routes/automations.js';
import broadcastRoutes from './routes/broadcasts.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : 1);

  app.use(securityHeaders);
  app.use(cors);

  app.get('/api/health', (_req, res) => res.json({ ok: true, env: config.env, mock: config.mock, time: new Date().toISOString() }));

  // Meta webhook needs the raw body for signature verification, so it is mounted before JSON parsing.
  app.use('/api/webhooks/meta', metaWebhook);

  // Small bodies everywhere; large bodies only where files are uploaded (media, CSV import, knowledge docs).
  const smallJson = express.json({ limit: '1mb' });
  const largeJson = express.json({ limit: '25mb' });
  const LARGE = [/^\/api\/conversations\/[^/]+\/messages$/, /^\/api\/contacts\/import$/, /^\/api\/knowledge/, /^\/api\/whatsapp\/simulate-inbound$/, /^\/api\/broadcasts$/];
  app.use((req, res, next) => (LARGE.some((re) => re.test(req.path)) ? largeJson : smallJson)(req, res, next));

  app.use('/api', rateLimit({ name: 'api', windowMs: 60_000, max: 600 }));
  app.use('/api/auth', authRoutes);
  // Public, separately authenticated endpoints
  app.use('/api/v1', publicApi);
  app.use('/api/hooks/in', hooksIn);
  app.use('/api/connectors/google/callback', googleCallback);

  const authed = express.Router();
  authed.use(requireAuth);
  authed.use('/users', userRoutes);
  authed.use('/settings', settingsRoutes);
  authed.use('/contacts', contactRoutes);
  authed.use('/custom-fields', customFields);
  authed.use('/audit-logs', auditRoutes);
  authed.use('/whatsapp', whatsappRoutes);
  authed.use('/templates', templateRoutes);
  authed.use('/media', mediaRouter);
  authed.use('/dlq', dlqRouter);
  authed.use('/conversations', conversationRoutes);
  authed.use('/labels', labelsRouter);
  authed.use('/connectors', connectorRoutes);
  authed.use('/ai', aiRoutes);
  authed.use('/knowledge', knowledgeRouter);
  authed.use('/tickets', ticketsRouter);
  authed.use('/automations', automationRoutes);
  authed.use('/broadcasts', broadcastRoutes);
  authed.use('/analytics', analyticsRouter);

  // Server-sent events for the live inbox.
  authed.get('/events', requirePermission('inbox.view'), (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: {}\n\n`);
    const viewAll = can(req.user.role, 'inbox.view_all');
    const onEvent = (evt) => {
      // Agents without view-all only receive events for unassigned or their own conversations.
      const assigned = evt.data?.assigned_to;
      if (!viewAll && assigned && assigned !== req.user.id) return;
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`);
    };
    bus.on('event', onEvent);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      bus.off('event', onEvent);
    });
  });

  app.use('/api', authed);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
