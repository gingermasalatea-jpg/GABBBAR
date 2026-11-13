/** Exponential backoff with full jitter. attempt starts at 1. */
export function backoffDelay(attempt, { baseMs = 2000, maxMs = 10 * 60 * 1000, jitter = true, random = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return jitter ? Math.round(exp / 2 + random() * (exp / 2)) : exp;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry an async function with exponential backoff. `shouldRetry(err)` decides if an error is transient.
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{attempts?: number, baseMs?: number, shouldRetry?: (err: any) => boolean}} [opts]
 * @returns {Promise<T>}
 */
export async function retry(fn, { attempts = 3, baseMs = 500, shouldRetry = () => true } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i === attempts || !shouldRetry(err)) throw err;
      await sleep(err?.retryAfterMs ?? backoffDelay(i, { baseMs }));
    }
  }
  throw lastErr;
}
