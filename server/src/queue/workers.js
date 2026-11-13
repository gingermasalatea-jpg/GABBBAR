import { defineJob, setQueueOptions, repeatEvery } from './index.js';
import { query } from '../db/pool.js';
import { emit } from '../lib/hooks.js';
import { logger } from '../lib/logger.js';
import { parseWebhook } from '../whatsapp/parser.js';
import * as messages from '../services/messages.js';
import * as templates from '../services/templates.js';
import { downloadInboundMedia } from '../services/media.js';

/** WhatsApp pipeline jobs: inbound webhooks, outbound sends, media, template maintenance. */
export function registerWhatsAppJobs() {
  setQueueOptions('inbound', { concurrency: 10 });
  setQueueOptions('outbound', { concurrency: 10 });
  setQueueOptions('media', { concurrency: 4 });
  setQueueOptions('maintenance', { concurrency: 1 });

  defineJob('inbound', 'webhook', async ({ body }) => {
    const events = parseWebhook(body);
    for (const evt of events) {
      if (evt.kind === 'message') await processInboundMessage(evt);
      else if (evt.kind === 'status') {
        const ins = await query(`INSERT INTO processed_events (event_id, kind) VALUES ($1,'status') ON CONFLICT DO NOTHING`, [
          `st:${evt.waMessageId}:${evt.status}`,
        ]);
        if (ins.rowCount) await messages.applyStatus(evt);
      } else if (evt.kind === 'template_status') await templates.applyTemplateStatus(evt);
      else if (evt.kind === 'template_quality') await templates.applyTemplateQuality(evt);
    }
  });

  defineJob('inbound', 'mock-status', async ({ waMessageId, status }) => {
    await messages.applyStatus({ waMessageId, status, timestamp: new Date() });
  });

  defineJob('outbound', 'send', async ({ messageId }) => {
    await messages.deliverMessage(messageId);
  });

  defineJob('media', 'download', async ({ mediaId }) => {
    await downloadInboundMedia(mediaId);
  });

  defineJob('maintenance', 'mock-template-review', async ({ templateId }) => {
    await templates.mockReview(templateId);
  });

  defineJob('maintenance', 'sync-templates', async () => {
    await templates.syncTemplates();
  });

  defineJob('maintenance', 'cleanup', async () => {
    await query(`DELETE FROM processed_events WHERE created_at < now() - interval '30 days'`);
    await query(`DELETE FROM webhook_deliveries WHERE created_at < now() - interval '30 days'`);
  });
}

export async function processInboundMessage(evt) {
  const result = await messages.recordInbound(evt);
  if (result.duplicate) return;
  const { message, contact, conversation } = result;
  logger.info('Inbound WhatsApp message', { conversation: conversation.id, type: message.type });
  if (await messages.handleOptKeywords(message, contact)) return;
  if (result.isNewContact) emit('contact.created', { contact });
  if (message.type === 'reaction') return;
  // Automations, AI and connectors subscribe to this event.
  emit('message.received', {
    message,
    contact,
    conversation,
    isNewContact: result.isNewContact,
    isNewConversation: result.isNewConversation,
    reopened: result.reopened,
  });
}

export async function scheduleWhatsAppMaintenance() {
  await repeatEvery('maintenance', 'sync-templates', 30 * 60_000);
  await repeatEvery('maintenance', 'cleanup', 6 * 3600_000);
}
