import http from 'node:http';
import { config, assertProductionConfig } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { initQueue, startWorkers, closeQueues, getRedisFactory, queueDriver } from './queue/index.js';
import { registerAllJobs, scheduleRecurringJobs } from './queue/register.js';
import { initRealtime, closeRealtime } from './services/realtime.js';
import { setRateLimitRedis } from './middleware/rateLimit.js';

async function main() {
  assertProductionConfig();
  if (process.env.AUTO_MIGRATE !== 'false') await migrate({ log: (m) => logger.info(m) });

  await initQueue();
  const factory = getRedisFactory();
  if (factory) {
    await initRealtime(factory);
    setRateLimitRedis(factory());
  }

  // Job handlers are registered in every process: the inline driver runs jobs wherever they are queued.
  registerAllJobs();
  if (config.runWorkers || queueDriver() === 'inline') {
    await scheduleRecurringJobs(); // also applies settings (e.g. broadcast rate) needed by the workers
    await startWorkers();
  }

  let server = null;
  if (config.runHttp) {
    const app = createApp();
    server = http.createServer(app);
    server.keepAliveTimeout = 65_000;
    server.listen(config.port, () => logger.info(`API listening on :${config.port}`, { mock: config.mock, queue: queueDriver() }));
  }

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down`);
    server?.close();
    await closeQueues();
    await closeRealtime();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', { err }));
}

main().catch((err) => {
  logger.error('Fatal startup error', { err });
  process.exit(1);
});
