import { config } from '../config.js';
import { query } from '../db/pool.js';
import { backoffDelay } from '../lib/backoff.js';
import { logger } from '../lib/logger.js';

/**
 * Job queue facade.
 *  - "bullmq" driver (default): Redis-backed BullMQ queues + workers, survives restarts.
 *  - "inline" driver: in-process queue with the same retry/backoff/DLQ semantics, for
 *    local development without Redis (QUEUE_DRIVER=inline) and for tests.
 * Handlers receive (data, { attempt, jobId }). Throw an error with `permanent = true`
 * to skip retries; set `retryAfterMs` to control the next delay.
 */

export const QUEUE_NAMES = ['inbound', 'outbound', 'media', 'automation', 'ai', 'broadcast', 'webhooks', 'sheets', 'maintenance'];

const DEFAULT_ATTEMPTS = { inbound: 8, outbound: 6, media: 6, automation: 3, ai: 3, broadcast: 6, webhooks: 8, sheets: 4, maintenance: 2 };

const handlers = new Map(); // queue -> Map(jobName -> fn)
const queueOpts = new Map(); // queue -> { concurrency, limiter }
let driver = null;
let bull = null;
let connection = null;
let redisFactory = null;
const bullQueues = new Map();
const workers = [];
const timers = [];

export function defineJob(queue, jobName, fn) {
  if (!QUEUE_NAMES.includes(queue)) throw new Error(`Unknown queue ${queue}`);
  if (!handlers.has(queue)) handlers.set(queue, new Map());
  handlers.get(queue).set(jobName, fn);
}

export function setQueueOptions(queue, opts) {
  queueOpts.set(queue, { ...(queueOpts.get(queue) || {}), ...opts });
}

export function queueDriver() {
  return driver;
}

/** Returns a factory for new ioredis connections (used by realtime pub/sub and rate limits), or null. */
export function getRedisFactory() {
  return redisFactory;
}

export async function initQueue() {
  const wanted = process.env.QUEUE_DRIVER || (config.isTest ? 'inline' : 'bullmq');
  if (wanted === 'inline') {
    driver = 'inline';
    logger.warn('Queue driver: inline (in-process). Use Redis + BullMQ in production.');
    return driver;
  }
  try {
    const [{ default: IORedis }, bullmq] = await Promise.all([import('ioredis'), import('bullmq')]);
    bull = bullmq;
    redisFactory = () => new IORedis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    connection = redisFactory();
    await connection.ping();
    driver = 'bullmq';
    logger.info('Queue driver: BullMQ (Redis)');
  } catch (err) {
    if (config.isProd) throw new Error(`Redis is required in production: ${err.message}`);
    logger.warn('Redis unavailable — falling back to the inline queue', { err });
    connection?.disconnect();
    connection = null;
    redisFactory = null;
    driver = 'inline';
  }
  return driver;
}

export function getRedis() {
  return connection;
}

function bullQueue(name) {
  if (!bullQueues.has(name)) bullQueues.set(name, new bull.Queue(name, { connection, prefix: 'wadesk' }));
  return bullQueues.get(name);
}

export async function deadLetter({ queue, jobName, jobId, data, error, attempts }) {
  try {
    await query(`INSERT INTO dead_letters (queue, job_name, job_id, payload, error, attempts) VALUES ($1,$2,$3,$4,$5,$6)`, [
      queue,
      jobName,
      jobId ? String(jobId) : null,
      data ?? {},
      String(error?.message || error || 'unknown error').slice(0, 4000),
      attempts ?? 0,
    ]);
    logger.error(`Job moved to dead-letter queue: ${queue}/${jobName}`, { error: error?.message });
  } catch (err) {
    logger.error('Failed to write dead letter', { err });
  }
}

/* ───────── inline driver ───────── */

const inlineSeen = new Map(); // jobId -> expiry
const inlineLanes = new Map(); // queue -> { nextAt }

async function runInline(queue, jobName, data, attempts, jobId, attempt = 1) {
  const fn = handlers.get(queue)?.get(jobName);
  if (!fn) {
    await deadLetter({ queue, jobName, jobId, data, error: new Error('No handler registered'), attempts: attempt });
    return;
  }
  // Rate limiting for queues with a limiter (e.g. broadcasts).
  const lim = queueOpts.get(queue)?.limiter;
  if (lim) {
    const lane = inlineLanes.get(queue) || { nextAt: 0 };
    const gap = lim.duration / lim.max;
    const now = Date.now();
    const at = Math.max(now, lane.nextAt);
    lane.nextAt = at + gap;
    inlineLanes.set(queue, lane);
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
  try {
    await fn(data, { attempt, jobId });
  } catch (err) {
    if (err?.permanent || attempt >= attempts) {
      await deadLetter({ queue, jobName, jobId, data, error: err, attempts: attempt });
      return;
    }
    const delay = err?.retryAfterMs ?? backoffDelay(attempt);
    logger.warn(`Retrying ${queue}/${jobName} in ${delay}ms (attempt ${attempt + 1}/${attempts})`, { error: err?.message });
    const t = setTimeout(() => runInline(queue, jobName, data, attempts, jobId, attempt + 1), delay);
    t.unref?.();
  }
}

/* ───────── public API ───────── */

/**
 * Add a job. `jobId` de-duplicates (a second job with the same id is ignored while the first exists).
 */
export async function enqueue(queue, jobName, data, { jobId, delayMs = 0, attempts, priority } = {}) {
  if (!driver) await initQueue();
  const tries = attempts ?? DEFAULT_ATTEMPTS[queue] ?? 3;
  if (driver === 'bullmq') {
    return bullQueue(queue).add(jobName, data, {
      jobId: jobId ? String(jobId).replace(/:/g, '_') : undefined,
      delay: delayMs,
      attempts: tries,
      priority,
      backoff: { type: 'custom' },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 14 * 24 * 3600 },
    });
  }
  if (jobId) {
    const now = Date.now();
    if ((inlineSeen.get(jobId) || 0) > now) return null;
    inlineSeen.set(jobId, now + 24 * 3600 * 1000);
    if (inlineSeen.size > 20_000) for (const [k, exp] of inlineSeen) if (exp < now) inlineSeen.delete(k);
  }
  const run = () => runInline(queue, jobName, data, tries, jobId).catch((err) => logger.error('inline job crashed', { err }));
  if (delayMs > 0) {
    const t = setTimeout(run, delayMs);
    t.unref?.();
  } else setImmediate(run);
  return { id: jobId || null };
}

/** Start consuming jobs. With the inline driver jobs always run in-process. */
export async function startWorkers() {
  if (!driver) await initQueue();
  if (driver !== 'bullmq') return;
  for (const [queue, map] of handlers) {
    const opts = queueOpts.get(queue) || {};
    const worker = new bull.Worker(
      queue,
      async (job) => {
        const fn = map.get(job.name);
        if (!fn) throw new bull.UnrecoverableError(`No handler for ${queue}/${job.name}`);
        try {
          return await fn(job.data, { attempt: job.attemptsMade + 1, jobId: job.id });
        } catch (err) {
          if (err?.permanent) {
            const u = new bull.UnrecoverableError(err.message);
            u.cause = err;
            throw u;
          }
          throw err;
        }
      },
      {
        connection: redisFactory(),
        prefix: 'wadesk',
        concurrency: opts.concurrency || 5,
        limiter: opts.limiter,
        settings: { backoffStrategy: (attemptsMade, _type, err) => err?.retryAfterMs ?? backoffDelay(attemptsMade) },
      },
    );
    worker.on('failed', async (job, err) => {
      if (!job) return;
      const exhausted = job.attemptsMade >= (job.opts.attempts || 1) || err?.name === 'UnrecoverableError';
      if (exhausted) await deadLetter({ queue, jobName: job.name, jobId: job.id, data: job.data, error: err, attempts: job.attemptsMade });
    });
    worker.on('error', (err) => logger.error(`Worker error on ${queue}`, { err }));
    workers.push(worker);
  }
  logger.info(`Workers started for: ${[...handlers.keys()].join(', ')}`);
}

/** Run a job on a fixed interval (deduplicated across processes with BullMQ job schedulers). */
export async function repeatEvery(queue, jobName, everyMs, data = {}) {
  if (!driver) await initQueue();
  if (driver === 'bullmq') {
    const q = bullQueue(queue);
    if (typeof q.upsertJobScheduler === 'function') {
      await q.upsertJobScheduler(`${queue}-${jobName}`, { every: everyMs }, { name: jobName, data, opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 } });
    } else {
      await q.add(jobName, data, { repeat: { every: everyMs }, jobId: `${queue}-${jobName}`, removeOnComplete: true });
    }
    return;
  }
  const t = setInterval(() => enqueue(queue, jobName, data, { attempts: 1 }), everyMs);
  t.unref?.();
  timers.push(t);
}

export async function closeQueues() {
  timers.forEach(clearInterval);
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([...bullQueues.values()].map((q) => q.close()));
  await connection?.quit().catch(() => {});
}
