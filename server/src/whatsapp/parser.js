/**
 * Normalise a WhatsApp Cloud API webhook payload into flat events:
 *   { kind: 'message', waMessageId, from, profileName, timestamp, type, text, media, interactive, context, raw }
 *   { kind: 'status', waMessageId, status, recipient, timestamp, errors, pricing, conversation }
 *   { kind: 'template_status', templateId, name, language, event, reason }
 *   { kind: 'template_quality', templateId, name, language, quality }
 */

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];

function textOf(msg) {
  switch (msg.type) {
    case 'text':
      return msg.text?.body ?? '';
    case 'button':
      return msg.button?.text ?? msg.button?.payload ?? '';
    case 'interactive':
      return msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? msg.interactive?.nfm_reply?.body ?? '';
    case 'location': {
      const l = msg.location || {};
      return [l.name, l.address, l.latitude !== undefined ? `📍 ${l.latitude}, ${l.longitude}` : ''].filter(Boolean).join(' — ');
    }
    case 'contacts':
      return (msg.contacts || []).map((c) => `👤 ${c.name?.formatted_name || ''} ${(c.phones || []).map((p) => p.phone).join(', ')}`).join('\n');
    case 'reaction':
      return msg.reaction?.emoji ?? '';
    case 'order':
      return `🛒 Order with ${(msg.order?.product_items || []).length} item(s)`;
    default:
      return MEDIA_TYPES.includes(msg.type) ? msg[msg.type]?.caption ?? '' : '';
  }
}

export function parseWebhook(body) {
  const events = [];
  if (!body || body.object !== 'whatsapp_business_account') return events;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (change.field === 'messages') {
        const profiles = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of v.messages || []) {
          const media = MEDIA_TYPES.includes(m.type)
            ? { id: m[m.type]?.id, mimeType: m[m.type]?.mime_type, sha256: m[m.type]?.sha256, fileName: m[m.type]?.filename, caption: m[m.type]?.caption, voice: m.audio?.voice }
            : null;
          events.push({
            kind: 'message',
            phoneNumberId: v.metadata?.phone_number_id,
            waMessageId: m.id,
            from: m.from,
            profileName: profiles.get(m.from) || null,
            timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
            type: m.type,
            text: textOf(m),
            media,
            interactive:
              m.type === 'interactive'
                ? { kind: m.interactive?.type, id: m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? null, title: textOf(m) }
                : m.type === 'button'
                  ? { kind: 'template_button', id: m.button?.payload ?? null, title: m.button?.text ?? '' }
                  : null,
            reaction: m.type === 'reaction' ? { messageId: m.reaction?.message_id, emoji: m.reaction?.emoji } : null,
            context: m.context ? { replyTo: m.context.id, from: m.context.from, forwarded: Boolean(m.context.forwarded) } : null,
            errors: m.errors || null,
            raw: m,
          });
        }
        for (const s of v.statuses || []) {
          events.push({
            kind: 'status',
            phoneNumberId: v.metadata?.phone_number_id,
            waMessageId: s.id,
            status: s.status,
            recipient: s.recipient_id,
            timestamp: s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date(),
            errors: s.errors || null,
            pricing: s.pricing || null,
            conversation: s.conversation || null,
          });
        }
      } else if (change.field === 'message_template_status_update') {
        events.push({
          kind: 'template_status',
          templateId: v.message_template_id ? String(v.message_template_id) : null,
          name: v.message_template_name,
          language: v.message_template_language,
          event: v.event,
          reason: v.reason && v.reason !== 'NONE' ? v.reason : null,
        });
      } else if (change.field === 'message_template_quality_update') {
        events.push({
          kind: 'template_quality',
          templateId: v.message_template_id ? String(v.message_template_id) : null,
          name: v.message_template_name,
          language: v.message_template_language,
          quality: v.new_quality_score,
        });
      }
    }
  }
  return events;
}

/** Status precedence so late/out-of-order webhooks never downgrade a message. */
const RANK = { queued: 0, held: 1, simulated: 1, sent: 2, delivered: 3, read: 4 };

export function shouldApplyStatus(current, next) {
  if (next === 'failed') return current !== 'read' && current !== 'delivered';
  if (current === 'failed') return false;
  return (RANK[next] ?? -1) > (RANK[current] ?? -1);
}
