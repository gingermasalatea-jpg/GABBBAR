import { EventEmitter } from 'node:events';
import { logger } from '../lib/logger.js';

/**
 * Realtime fan-out for the inbox. Events published by workers in another process
 * reach the API process through Redis pub/sub; SSE clients subscribe to `bus`.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

const CHANNEL = 'wadesk:events';
let pub = null;
let sub = null;

export async function initRealtime(redisFactory) {
  if (!redisFactory) return;
  try {
    pub = redisFactory();
    sub = redisFactory();
    await sub.subscribe(CHANNEL);
    sub.on('message', (_ch, raw) => {
      try {
        const evt = JSON.parse(raw);
        bus.emit('event', evt);
      } catch {
        /* ignore malformed */
      }
    });
  } catch (err) {
    logger.warn('Realtime via Redis unavailable; using in-process events only', { err });
    pub = null;
    sub = null;
  }
}

/** Publish an event to all connected inbox clients. Payloads must not include secrets. */
export function publish(type, data = {}) {
  const evt = { type, data, at: new Date().toISOString() };
  if (pub) {
    pub.publish(CHANNEL, JSON.stringify(evt)).catch((err) => {
      logger.warn('publish failed, delivering locally', { err });
      bus.emit('event', evt);
    });
  } else {
    bus.emit('event', evt);
  }
}

export async function closeRealtime() {
  await Promise.allSettled([pub?.quit(), sub?.quit()]);
}
