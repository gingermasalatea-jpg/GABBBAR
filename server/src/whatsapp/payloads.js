/**
 * Build Cloud API message payloads. `to` is the wa_id (digits, no "+").
 * Pure functions — unit tested.
 */

const clip = (s, n) => String(s ?? '').slice(0, n);

export function textPayload(to, body, { previewUrl = true, replyTo } = {}) {
  if (!body || !String(body).trim()) throw new Error('Message text is empty');
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: clip(body, 4096), preview_url: previewUrl },
    ...(replyTo ? { context: { message_id: replyTo } } : {}),
  };
}

export function mediaPayload(to, type, { id, link, caption, filename }) {
  if (!['image', 'video', 'audio', 'document', 'sticker'].includes(type)) throw new Error(`Unsupported media type ${type}`);
  if (!id && !link) throw new Error('Media id or link is required');
  const media = id ? { id } : { link };
  if (caption && ['image', 'video', 'document'].includes(type)) media.caption = clip(caption, 1024);
  if (filename && type === 'document') media.filename = clip(filename, 240);
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type, [type]: media };
}

/** Up to 3 reply buttons (title max 20 chars). */
export function buttonsPayload(to, body, buttons, { header, footer } = {}) {
  const list = (buttons || []).slice(0, 3).map((b, i) => ({ type: 'reply', reply: { id: clip(b.id || `btn_${i + 1}`, 256), title: clip(b.title, 20) } }));
  if (!list.length) throw new Error('At least one button is required');
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clip(body, 1024) },
      ...(header ? { header: { type: 'text', text: clip(header, 60) } } : {}),
      ...(footer ? { footer: { text: clip(footer, 60) } } : {}),
      action: { buttons: list },
    },
  };
}

/** List message: up to 10 rows in total across sections. */
export function listPayload(to, body, buttonText, sections, { header, footer } = {}) {
  let remaining = 10;
  const secs = (sections || [])
    .map((s) => {
      const rows = (s.rows || []).slice(0, remaining).map((r, i) => ({ id: clip(r.id || `row_${i + 1}`, 200), title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}) }));
      remaining -= rows.length;
      return { ...(s.title ? { title: clip(s.title, 24) } : {}), rows };
    })
    .filter((s) => s.rows.length);
  if (!secs.length) throw new Error('At least one list row is required');
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: clip(body, 4096) },
      ...(header ? { header: { type: 'text', text: clip(header, 60) } } : {}),
      ...(footer ? { footer: { text: clip(footer, 60) } } : {}),
      action: { button: clip(buttonText || 'Choose', 20), sections: secs },
    },
  };
}

/**
 * Template message. `components` is the approved template definition; `values` fills body {{n}};
 * `headerValues` fills a TEXT header; `headerMedia` = { type: 'image'|'video'|'document', link|id }.
 */
export function templatePayload(to, { name, language, components = [], values = [], headerValues = [], headerMedia, buttonValues = [] }) {
  const out = [];
  const header = components.find((c) => c.type === 'HEADER');
  if (header) {
    if (header.format && header.format !== 'TEXT') {
      if (!headerMedia) throw new Error(`Template ${name} needs a ${header.format.toLowerCase()} header`);
      const t = header.format.toLowerCase();
      out.push({ type: 'header', parameters: [{ type: t, [t]: headerMedia.id ? { id: headerMedia.id } : { link: headerMedia.link } }] });
    } else if (/\{\{\s*1\s*\}\}/.test(header.text || '')) {
      out.push({ type: 'header', parameters: [{ type: 'text', text: String(headerValues[0] ?? '') }] });
    }
  }
  const body = components.find((c) => c.type === 'BODY');
  const needed = body ? [...String(body.text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].length : 0;
  if (needed) {
    const missing = [];
    const params = [];
    for (let i = 0; i < needed; i++) {
      const v = values[i];
      if (v === undefined || v === null || String(v).trim() === '') missing.push(i + 1);
      params.push({ type: 'text', text: clip(v ?? '', 1024) });
    }
    if (missing.length) throw new Error(`Template ${name}: missing value for {{${missing.join('}}, {{')}}}`);
    out.push({ type: 'body', parameters: params });
  }
  const buttons = components.find((c) => c.type === 'BUTTONS');
  (buttons?.buttons || []).forEach((b, index) => {
    if (b.type === 'URL' && /\{\{\s*1\s*\}\}/.test(b.url || '')) {
      out.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: String(buttonValues[index] ?? '') }] });
    }
  });
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name, language: { code: language || 'en' }, ...(out.length ? { components: out } : {}) },
  };
}

/** Human-readable preview of a template with values filled in. */
export function renderTemplatePreview(components = [], values = [], headerValues = []) {
  const fill = (t, vals) => String(t || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => vals[Number(n) - 1] ?? `{{${n}}}`);
  const header = components.find((c) => c.type === 'HEADER');
  const body = components.find((c) => c.type === 'BODY');
  const footer = components.find((c) => c.type === 'FOOTER');
  const buttons = components.find((c) => c.type === 'BUTTONS');
  return [
    header && header.format === 'TEXT' ? `*${fill(header.text, headerValues)}*` : header ? `[${header.format?.toLowerCase()}]` : null,
    body ? fill(body.text, values) : null,
    footer ? `_${footer.text}_` : null,
    buttons ? buttons.buttons.map((b) => `[ ${b.text} ]`).join(' ') : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Validate a template definition before submitting it to Meta. Returns a list of problems. */
export function validateTemplateComponents(components) {
  const problems = [];
  const body = components.find((c) => c.type === 'BODY');
  if (!body?.text?.trim()) problems.push('Body text is required');
  if (body?.text && body.text.length > 1024) problems.push('Body must be at most 1024 characters');
  if (body?.text && /^\s*\{\{/.test(body.text)) problems.push('Body cannot start with a variable');
  if (body?.text && /\{\{\s*\d+\s*\}\}\s*$/.test(body.text)) problems.push('Body cannot end with a variable');
  const nums = [...String(body?.text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  nums.forEach((n, i) => {
    if (n !== i + 1) problems.push('Variables must be numbered in order {{1}}, {{2}}, … without gaps');
  });
  if (nums.length && !(body?.example?.body_text?.[0]?.length >= nums.length)) problems.push('Provide an example value for every body variable');
  const header = components.find((c) => c.type === 'HEADER');
  if (header?.format === 'TEXT' && (header.text || '').length > 60) problems.push('Header text must be at most 60 characters');
  const footer = components.find((c) => c.type === 'FOOTER');
  if (footer && (footer.text || '').length > 60) problems.push('Footer must be at most 60 characters');
  const buttons = components.find((c) => c.type === 'BUTTONS');
  if (buttons && (buttons.buttons || []).length > 10) problems.push('At most 10 buttons');
  for (const b of buttons?.buttons || []) if ((b.text || '').length > 25) problems.push(`Button "${b.text}" must be at most 25 characters`);
  return [...new Set(problems)];
}
