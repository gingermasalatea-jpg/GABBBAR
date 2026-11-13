import { findSensitive } from '../lib/redact.js';

/**
 * Post-generation checks. Any violation means the reply is NOT sent: the conversation
 * falls back to the team (ticket) instead. Pure — unit tested.
 */

const GUARANTEE = [
  /\bguarantee(d|s)?\b/i,
  /\b100\s?%\s*(sure|guarantee|confirm)/i,
  /\bi\s+promise\b/i,
  /\bwe\s+promise\b/i,
  /\bdefinitely\s+(will|be|get|arrive|deliver|refund)/i,
  /\bpakka\b/i,
  /\bpromise\s+(karte|karta|karti)\b/i,
  /\bगारंटी\b/,
];

// Negated forms ("cannot be guaranteed", "no guarantee") are honest caveats, not promises.
const NEGATED = /\b(?:not|no|cannot|can't|can\s?not|won't|never|nahi|nahin)\s+(?:be\s+|been\s+)?(?:guarantee(?:d|s)?|promise(?:d)?)\b/gi;

/** True if a sentence makes a promise/guarantee or uses a never-say phrase (used by the mock provider too). */
export function violatesPolicy(sentence, neverSay = []) {
  const s = String(sentence || '');
  const stripped = s.replace(NEGATED, '');
  if (GUARANTEE.some((re) => re.test(stripped))) return true;
  const lower = stripped.toLowerCase();
  return neverSay.some((w) => w && lower.includes(String(w).toLowerCase()));
}

const LEAK = [/system prompt/i, /my instructions/i, /\bSTRICT RULES\b/, /\bKNOWLEDGE:\s*$/m, /as an ai language model/i];

/**
 * @param {string} reply
 * @param {object} ctx
 * @param {string[]} [ctx.neverSay]
 * @param {string[]} [ctx.internalValues]  values of internal fields/notes that must never appear
 * @param {string}   [ctx.groundingText]   knowledge + profile + customer data (to allow numbers that are grounded)
 */
export function checkReply(reply, { neverSay = [], internalValues = [], groundingText = '' } = {}) {
  const flags = [];
  const text = String(reply || '');
  if (!text.trim()) flags.push('empty_reply');
  if (text.length > 1500) flags.push('too_long');

  const lower = text.toLowerCase();
  const promiseText = text.replace(NEGATED, '');
  const promiseLower = promiseText.toLowerCase();
  for (const w of neverSay) if (w && promiseLower.includes(String(w).toLowerCase())) flags.push(`never_say:${w}`);
  if (GUARANTEE.some((re) => re.test(promiseText))) flags.push('guarantee');
  if (LEAK.some((re) => re.test(text))) flags.push('prompt_leak');

  for (const s of findSensitive(text)) flags.push(`sensitive:${s.kind}`);
  for (const v of internalValues) {
    const val = String(v ?? '').trim();
    if (val.length >= 4 && lower.includes(val.toLowerCase())) flags.push('internal_data');
  }

  // Hallucination check: any money amount or phone/URL in the reply must appear in the grounding text.
  const ground = groundingText.toLowerCase();
  const claims = [
    ...[...text.matchAll(/(?:₹|\brs\.?|\binr)\s?([\d,]+(?:\.\d+)?)/gi)].map((m) => m[1].replace(/,/g, '')),
    ...[...text.matchAll(/https?:\/\/[^\s)]+/gi)].map((m) => m[0].replace(/[.,!?]+$/, '').toLowerCase()),
    ...[...text.matchAll(/\+?\d[\d\s-]{8,}\d/g)].map((m) => m[0].replace(/\D/g, '')),
  ];
  const groundDigits = ground.replace(/[,\s-]/g, '');
  for (const c of claims) {
    const needle = c.toLowerCase();
    if (!ground.includes(needle) && !groundDigits.includes(needle.replace(/\D/g, '') || '§')) flags.push('ungrounded_fact');
  }

  return { ok: flags.length === 0, flags: [...new Set(flags)] };
}
