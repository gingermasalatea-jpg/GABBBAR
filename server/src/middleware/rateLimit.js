import { HttpError } from '../lib/errors.js';

/**
 * Fixed-window rate limiter. Uses Redis when available (shared across processes),
 * otherwise an in-memory map.
 */
let redis = null;
export function setRateLimitRedis(client) {
  redis = client;
}

const mem = new Map();

async function hit(key, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  const k = `rl:${key}:${bucket}`;
  if (redis) {
    try {
      const n = await redis.incr(k);
      if (n === 1) await redis.pexpire(k, windowMs);
      return n;
    } catch {
      /* fall through to memory */
    }
  }
  const n = (mem.get(k) || 0) + 1;
  mem.set(k, n);
  if (mem.size > 50_000) {
    for (const key2 of mem.keys()) if (!key2.endsWith(`:${bucket}`)) mem.delete(key2);
  }
  return n;
}

export function rateLimit({ name, windowMs, max, key = (req) => req.ip }) {
  return async (req, res, next) => {
    try {
      const n = await hit(`${name}:${key(req)}`, windowMs);
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - n)));
      if (n > max) {
        res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
        return next(new HttpError(429, 'Too many requests — please slow down'));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
