import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(here, '../../.env');
const localEnv = path.resolve(here, '../.env');

// Node 20.12+ can load .env files without a dependency.
for (const file of [localEnv, rootEnv]) {
  try {
    process.loadEnvFile(file);
  } catch {
    /* file missing — fine */
  }
}

const bool = (v, def = false) => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const int = (v, def) => (v === undefined || v === '' ? def : Number.parseInt(v, 10));

const env = process.env;
const isProd = env.NODE_ENV === 'production';

export const config = {
  env: env.NODE_ENV || 'development',
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: int(env.PORT, 4000),
  appUrl: env.APP_URL || 'http://localhost:3000',
  apiUrl: env.API_URL || 'http://localhost:4000',
  databaseUrl: env.DATABASE_URL || 'postgres://wadesk:wadesk@localhost:5432/wadesk',
  redisUrl: env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: env.JWT_SECRET || (isProd ? '' : 'dev-only-insecure-secret-dev-only-insecure-secret'),
  jwtExpiresHours: int(env.JWT_EXPIRES_IN_HOURS, 12),
  encryptionKey: env.ENCRYPTION_KEY || '',
  mediaDir: path.resolve(env.MEDIA_DIR || path.resolve(here, '../storage/media')),
  runWorkers: bool(env.RUN_WORKERS, true),
  runHttp: bool(env.RUN_HTTP, true),
  mock: {
    whatsapp: bool(env.WHATSAPP_MOCK, true),
    ai: bool(env.AI_MOCK, true),
    google: bool(env.GOOGLE_MOCK, true),
  },
  meta: {
    graphVersion: env.META_GRAPH_VERSION || 'v23.0',
    appSecret: env.META_APP_SECRET || '',
    verifyToken: env.META_VERIFY_TOKEN || '',
    phoneNumberId: env.WA_PHONE_NUMBER_ID || '',
    wabaId: env.WA_WABA_ID || '',
    accessToken: env.WA_ACCESS_TOKEN || '',
  },
  ai: {
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    openaiKey: env.OPENAI_API_KEY || '',
    geminiKey: env.GEMINI_API_KEY || '',
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
  },
  seed: {
    adminEmail: env.SEED_ADMIN_EMAIL || 'admin@wadesk.local',
    adminPassword: env.SEED_ADMIN_PASSWORD || 'ChangeMe@123',
  },
};

export function assertProductionConfig() {
  if (!config.isProd) return;
  const problems = [];
  if (!config.jwtSecret || config.jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 chars');
  if (!config.encryptionKey) problems.push('ENCRYPTION_KEY is required');
  if (problems.length) throw new Error(`Invalid production config: ${problems.join('; ')}`);
}
