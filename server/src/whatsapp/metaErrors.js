/**
 * Classify WhatsApp Cloud API errors so the queue knows whether to retry, how long
 * to wait, and what to tell the team. Codes per Meta's Cloud API error reference.
 */

const RULES = {
  // Throttling — retry with backoff
  4: { retry: true, delayMs: 60_000, message: 'App-level API call limit reached' },
  80007: { retry: true, delayMs: 60_000, message: 'WhatsApp Business Account rate limit reached' },
  130429: { retry: true, delayMs: 5_000, message: 'Cloud API throughput limit reached' },
  131056: { retry: true, delayMs: 6_000, message: 'Too many messages to this customer in a short time (pair rate limit)' },
  613: { retry: true, delayMs: 60_000, message: 'Rate limit hit' },
  // Transient
  1: { retry: true, delayMs: 5_000, message: 'Meta API unknown error' },
  2: { retry: true, delayMs: 5_000, message: 'Meta API service temporarily unavailable' },
  131000: { retry: true, delayMs: 10_000, message: 'Something went wrong on Meta\'s side' },
  131016: { retry: true, delayMs: 30_000, message: 'WhatsApp service temporarily unavailable' },
  133004: { retry: true, delayMs: 30_000, message: 'WhatsApp server temporarily unavailable' },
  // Permanent — do not retry
  0: { retry: false, message: 'Authentication failed — check the access token', alertAdmins: true },
  190: { retry: false, message: 'Access token expired or invalid — update it in Settings', alertAdmins: true },
  3: { retry: false, message: 'App lacks the capability/permission for this call', alertAdmins: true },
  10: { retry: false, message: 'Permission denied — check token permissions', alertAdmins: true },
  200: { retry: false, message: 'Permission error — check token permissions', alertAdmins: true },
  100: { retry: false, message: 'Invalid parameter in the request' },
  368: { retry: false, message: 'Number temporarily blocked for policy violations', alertAdmins: true },
  131005: { retry: false, message: 'Access denied', alertAdmins: true },
  131008: { retry: false, message: 'A required parameter is missing' },
  131009: { retry: false, message: 'A parameter value is invalid' },
  131021: { retry: false, message: 'Sender and recipient are the same number' },
  131026: { retry: false, message: 'Message undeliverable — the number may not be on WhatsApp or has not accepted the latest terms' },
  131031: { retry: false, message: 'Business account is locked', alertAdmins: true },
  131042: { retry: false, message: 'Payment issue on the WhatsApp Business Account', alertAdmins: true },
  131045: { retry: false, message: 'Phone number is not registered', alertAdmins: true },
  131047: { retry: false, message: 'More than 24 hours since the customer last replied — send an approved template instead' },
  131048: { retry: false, message: 'Spam rate limit hit — too many messages were blocked or reported', alertAdmins: true },
  131049: { retry: false, message: 'Meta limited this marketing message to keep engagement healthy (per-user marketing limit)' },
  131050: { retry: false, message: 'Customer has stopped marketing messages', optOutMarketing: true },
  131051: { retry: false, message: 'Unsupported message type' },
  131052: { retry: false, message: 'Could not download the customer\'s media' },
  131053: { retry: false, message: 'Could not upload the media — check type and size' },
  132000: { retry: false, message: 'Template parameter count does not match' },
  132001: { retry: false, message: 'Template does not exist in this language or is not approved' },
  132005: { retry: false, message: 'Template text too long after filling parameters' },
  132007: { retry: false, message: 'Template content violates WhatsApp policy' },
  132012: { retry: false, message: 'Template parameter format is wrong' },
  132015: { retry: false, message: 'Template is paused due to low quality' },
  132016: { retry: false, message: 'Template is disabled' },
  135000: { retry: false, message: 'Generic user error' },
};

export class MetaApiError extends Error {
  constructor({ status, code, subcode, message, details, fbtraceId }) {
    const rule = RULES[code];
    super(rule?.message ? `${rule.message} (Meta ${code}${details ? `: ${details}` : ''})` : message || `Meta API error ${code ?? status}`);
    this.name = 'MetaApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.metaMessage = message;
    this.details = details;
    this.fbtraceId = fbtraceId;
    const c = classifyMetaError({ status, code });
    this.retryable = c.retry;
    this.retryAfterMs = c.delayMs;
    this.permanent = !c.retry;
    this.alertAdmins = Boolean(c.alertAdmins);
    this.optOutMarketing = Boolean(c.optOutMarketing);
  }
}

/** Decide what to do with an error from the Graph API. */
export function classifyMetaError({ status, code }) {
  const rule = code !== undefined && code !== null ? RULES[Number(code)] : undefined;
  if (rule) return { retry: rule.retry, delayMs: rule.delayMs, alertAdmins: rule.alertAdmins, optOutMarketing: rule.optOutMarketing };
  if (status === 429) return { retry: true, delayMs: 30_000 };
  if (status >= 500) return { retry: true, delayMs: 10_000 };
  if (status === 401 || status === 403) return { retry: false, alertAdmins: true };
  return { retry: false };
}

export function fromGraphResponse(status, body) {
  const e = body?.error || {};
  return new MetaApiError({
    status,
    code: e.code,
    subcode: e.error_subcode,
    message: e.message,
    details: e.error_data?.details,
    fbtraceId: e.fbtrace_id,
  });
}

export function describeMetaErrorCode(code) {
  return RULES[Number(code)]?.message;
}
