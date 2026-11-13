/**
 * Detect and redact sensitive identifiers (Indian + generic) before text reaches
 * a customer or an AI provider: Aadhaar, PAN, card numbers, bank account / IFSC,
 * UPI transaction refs. Used by the AI guardrails.
 */

const PATTERNS = [
  { kind: 'aadhaar', re: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g },
  { kind: 'pan', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { kind: 'card', re: /\b(?:\d[ -]?){13,19}\b/g, check: luhn },
  { kind: 'ifsc', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  { kind: 'bank_account', re: /\b(?:a\/c|acct|account)(?:\s*(?:no\.?|number))?\s*[:#-]?\s*\d{9,18}\b/gi },
  { kind: 'upi_ref', re: /\b(?:utr|upi\s*ref(?:erence)?|txn\s*id)\s*[:#-]?\s*[A-Z0-9]{10,22}\b/gi },
];

function luhn(match) {
  const digits = match.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function findSensitive(text) {
  const found = [];
  const s = String(text || '');
  for (const p of PATTERNS) {
    for (const m of s.matchAll(p.re)) {
      if (p.check && !p.check(m[0])) continue;
      found.push({ kind: p.kind, value: m[0] });
    }
  }
  return found;
}

export function redactSensitive(text) {
  let s = String(text || '');
  for (const p of PATTERNS) {
    s = s.replace(p.re, (m) => (p.check && !p.check(m) ? m : `[redacted ${p.kind}]`));
  }
  return s;
}
