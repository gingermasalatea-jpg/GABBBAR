import { defineJob, setQueueOptions } from './index.js';
import { runForMessage } from '../ai/assistant.js';

export function registerAiJobs() {
  setQueueOptions('ai', { concurrency: 4 });
  defineJob('ai', 'reply', async ({ conversationId, messageId }) => {
    await runForMessage({ conversationId, messageId });
  });
}
