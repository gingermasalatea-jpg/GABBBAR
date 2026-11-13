import { registerWhatsAppJobs, scheduleWhatsAppMaintenance } from './workers.js';
import { registerConnectorJobs, scheduleConnectorJobs } from './connectorJobs.js';
import { registerAiJobs } from './aiJobs.js';
import { registerAutomationJobs, configureBroadcastRate } from './automationJobs.js';

/** Register every job handler and domain-event subscriber. Called once per process. */
export function registerAllJobs() {
  registerWhatsAppJobs();
  registerConnectorJobs();
  registerAiJobs();
  registerAutomationJobs();
}

export async function scheduleRecurringJobs() {
  await configureBroadcastRate();
  await scheduleWhatsAppMaintenance();
  await scheduleConnectorJobs();
}
