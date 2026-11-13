/**
 * Phone helpers. Contacts are keyed by E.164 (e.g. +919876543210).
 * WhatsApp Cloud API sends and expects numbers without the leading "+".
 */

/**
 * Normalise user input to E.164.
 * @param {string|number} input
 * @param {string} defaultCountryCode digits only, e.g. "91"
 * @returns {string|null} "+<digits>" or null when it cannot be a valid number
 */
export function toE164(input, defaultCountryCode = '91') {
  if (input === null || input === undefined) return null;
  let raw = String(input).trim();
  if (!raw) return null;
  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (hasPlus) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else {
    // drop trunk prefix "0" used in national formats (e.g. 09876543210)
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
    const cc = String(defaultCountryCode || '').replace(/\D/g, '');
    // A 10-digit national number (India and many others) gets the default country code.
    if (cc && digits.length <= 10) digits = cc + digits;
  }

  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith('0')) return null;
  return `+${digits}`;
}

/** "+919876543210" -> "919876543210" (format used by the Cloud API) */
export function toWaId(e164) {
  return String(e164 || '').replace(/^\+/, '');
}

/** "919876543210" -> "+919876543210" */
export function fromWaId(waId) {
  const d = String(waId || '').replace(/\D/g, '');
  return d ? `+${d}` : null;
}

export function isE164(value) {
  return /^\+[1-9]\d{7,14}$/.test(String(value || ''));
}

/** Mask for logs: +91******3210 */
export function maskPhone(e164) {
  const s = String(e164 || '');
  if (s.length < 7) return s;
  return s.slice(0, 3) + '*'.repeat(Math.max(0, s.length - 7)) + s.slice(-4);
}
