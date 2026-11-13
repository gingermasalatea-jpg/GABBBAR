import { defineJob, setQueueOptions, enqueue } from './index.js';
import { on } from '../lib/hooks.js';
import { one } from '../db/pool.js';
import { handleInbound } from '../automation/runner.js';
import { getSection } from '../services/settings.js';
import * as broadcasts from '../services/broadcasts.js';

/** Inbound routing (automations → AI) and rate-limited broadcasts. */
export function registerAutomationJobs() {
  setQueueOptions('automation', { concurrency: 5 });
  setQueueOptions('broadcast', { concurrency: 5, limiter: { max: 20, duration: 1000 } });

  on('message.received', async ({ message, conversation, contact, isNewContact }) => {
    await enqueue('automation', 'inbound', { messageId: message.id, conversationId: conversation.id, contactId: contact.id, isNewContact: Boolean(isNewContact) }, { jobId: `auto:${message.id}` });
  });

  defineJob('automation', 'inbound', async ({ messageId, conversationId, contactId, isNewContact }) => {
    const [message, contact, conversation] = await Promise.all([
      one('SELECT * FROM messages WHERE id = $1', [messageId]),
      one('SELECT * FROM contacts WHERE id = $1', [contactId]),
      one('SELECT * FROM conversations WHERE id = $1', [conversationId]),
    ]);
    if (!message || !contact || !conversation) return;
    await handleInbound({ message, contact, conversation, isNewContact });
  });

  defineJob('broadcast', 'start', async ({ broadcastId }, { jobId }) => {
    const ts = Number(String(jobId || '').split(/[:_]/).pop());
    await broadcasts.startBroadcast(broadcastId, Number.isFinite(ts) && ts > 1e12 ? ts : undefined);
  });
  defineJob('broadcast', 'send-one', async ({ recipientId }, { attempt }) => {
    await broadcasts.sendOne(recipientId, attempt);
  });
}

/** Apply the configured messages-per-second before workers start. */
export async function configureBroadcastRate() {
  const g = await getSection('general');
  const rate = Math.max(1, Math.min(80, Number(g.broadcast_rate_per_sec) || 20));
  setQueueOptions('broadcast', { limiter: { max: rate, duration: 1000 } });
}
