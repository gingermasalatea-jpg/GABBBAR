import { EventEmitter } from 'node:events';

/**
 * In-process domain events (contact.created, message.received, ...).
 * Connectors (outbound webhooks, Google Sheets push) subscribe here, so core
 * modules do not depend on them. Listener errors never break the caller.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function on(event, listener) {
  emitter.on(event, async (payload) => {
    try {
      await listener(payload);
    } catch (err) {
      console.error(`[hooks] listener for ${event} failed:`, err?.message || err);
    }
  });
}

export function emit(event, payload) {
  emitter.emit(event, payload);
}
