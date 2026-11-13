/** Tiny structured logger (JSON in production, readable in development). */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20;
const json = process.env.NODE_ENV === 'production';

function write(level, msg, meta) {
  if (LEVELS[level] < min || process.env.NODE_ENV === 'test') return;
  const entry = { t: new Date().toISOString(), level, msg, ...(meta || {}) };
  if (meta?.err instanceof Error) entry.err = { message: meta.err.message, stack: meta.err.stack };
  const line = json ? JSON.stringify(entry) : `[${entry.t}] ${level.toUpperCase()} ${msg}${meta ? ' ' + JSON.stringify({ ...entry, t: undefined, level: undefined, msg: undefined }) : ''}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const logger = {
  debug: (m, meta) => write('debug', m, meta),
  info: (m, meta) => write('info', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
};
