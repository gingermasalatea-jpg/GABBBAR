/**
 * Helpers for WhatsApp template variables ({{1}}, {{2}} …) and for
 * {{contact.field}} placeholders in automation messages.
 *
 * Fields marked `internal` are NEVER substituted into customer-facing text.
 */

export function countBodyVariables(text) {
  const nums = [...String(text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

export function renderNumbered(text, values = []) {
  return String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
    const v = values[Number(n) - 1];
    return v === undefined || v === null || v === '' ? `{{${n}}}` : String(v);
  });
}

/**
 * Return a copy of the contact containing only customer-safe data.
 * @param {object} contact
 * @param {Array<{key:string, internal:boolean}>} fieldDefs
 */
export function customerSafeContact(contact, fieldDefs = []) {
  if (!contact) return {};
  const internal = new Set(fieldDefs.filter((f) => f.internal).map((f) => f.key));
  const custom = {};
  for (const [k, v] of Object.entries(contact.custom || {})) {
    if (!internal.has(k)) custom[k] = v;
  }
  return {
    name: contact.name || '',
    first_name: (contact.name || '').split(/\s+/)[0] || '',
    phone: contact.phone || '',
    email: contact.email || '',
    tags: contact.tags || [],
    custom,
  };
}

/** Resolve a single variable source against a safe contact. */
export function resolveSource(source, safe) {
  if (!source) return '';
  if (source.type === 'static') return String(source.value ?? '');
  if (source.type === 'field') {
    const key = String(source.value || '');
    if (key.startsWith('custom.')) return String(safe.custom?.[key.slice(7)] ?? source.fallback ?? '');
    return String(safe[key] ?? source.fallback ?? '');
  }
  return '';
}

/** Build ordered values for numbered template variables from a mapping {"1": source, "2": source}. */
export function buildTemplateValues(mapping = {}, safe = {}) {
  const keys = Object.keys(mapping).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  const max = keys.length ? keys[keys.length - 1] : 0;
  const out = [];
  for (let i = 1; i <= max; i++) out.push(resolveSource(mapping[String(i)], safe));
  return out;
}

/** Replace {{name}}, {{first_name}}, {{custom.city}} in automation text using a SAFE contact only. */
export function renderContactPlaceholders(text, safe) {
  return String(text || '').replace(/\{\{\s*([a-z_][\w.]*)\s*\}\}/gi, (whole, key) => {
    if (key.startsWith('custom.')) {
      const v = safe.custom?.[key.slice(7)];
      return v === undefined || v === null ? '' : String(v);
    }
    if (['name', 'first_name', 'phone', 'email'].includes(key)) return String(safe[key] ?? '');
    return whole;
  });
}
