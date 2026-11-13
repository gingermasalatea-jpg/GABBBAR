import { defineJob, setQueueOptions, repeatEvery } from './index.js';
import { on } from '../lib/hooks.js';
import * as sheets from '../services/sheets.js';
import { OUTBOUND_EVENTS, emitWebhookEvent, deliver, markDeliveryFailed } from '../services/webhooksOut.js';

const WEBHOOK_ATTEMPTS = 8;

/** Google Sheets sync + outbound webhook delivery. */
export function registerConnectorJobs() {
  setQueueOptions('sheets', { concurrency: 1 });
  setQueueOptions('webhooks', { concurrency: 5 });

  defineJob('sheets', 'sync', async ({ connectionId }) => {
    await sheets.syncConnection(connectionId);
  });
  defineJob('sheets', 'sync-due', async () => {
    await sheets.syncDue();
  });

  defineJob('webhooks', 'deliver', async ({ deliveryId }, { attempt }) => {
    try {
      await deliver(deliveryId, attempt);
    } catch (err) {
      if (err.permanent || attempt >= WEBHOOK_ATTEMPTS) await markDeliveryFailed(deliveryId);
      throw err;
    }
  });

  // Domain events -> outbound webhooks
  for (const event of OUTBOUND_EVENTS) on(event, (payload) => emitWebhookEvent(event, payload));

  // Contact changes -> push to Google Sheets (coalesced)
  on('contact.created', () => sheets.queueSheetPush());
  on('contact.updated', () => sheets.queueSheetPush());
}

export async function scheduleConnectorJobs() {
  await repeatEvery('sheets', 'sync-due', 5 * 60_000);
}
