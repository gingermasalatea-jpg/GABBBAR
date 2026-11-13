import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyMetaSignature, signMetaBody } from '../src/whatsapp/signature.js';
import { parseWebhook, shouldApplyStatus } from '../src/whatsapp/parser.js';
import { classifyMetaError, fromGraphResponse } from '../src/whatsapp/metaErrors.js';
import { textPayload, buttonsPayload, listPayload, templatePayload, mediaPayload, validateTemplateComponents, renderTemplatePreview } from '../src/whatsapp/payloads.js';

const webhook = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID' },
        contacts: [{ profile: { name: 'Rahul' }, wa_id: '919876543210' }],
        messages: [
          { from: '919876543210', id: 'wamid.A', timestamp: '1731400000', type: 'text', text: { body: 'Hello' } },
          { from: '919876543210', id: 'wamid.B', timestamp: '1731400001', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'zip broken' } },
          { from: '919876543210', id: 'wamid.C', timestamp: '1731400002', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'track', title: 'Track order' } }, context: { id: 'wamid.PREV' } },
        ],
        statuses: [{ id: 'wamid.OUT', status: 'failed', timestamp: '1731400003', recipient_id: '919876543210', errors: [{ code: 131047, title: 'Re-engagement message' }] }],
      },
    }, {
      field: 'message_template_status_update',
      value: { event: 'REJECTED', message_template_id: 123, message_template_name: 'promo', message_template_language: 'en', reason: 'INVALID_FORMAT' },
    }],
  }],
};

test('signature: accepts valid, rejects tampered/missing', () => {
  const raw = Buffer.from(JSON.stringify(webhook));
  const sig = signMetaBody(raw, 'app-secret');
  assert.ok(verifyMetaSignature(raw, sig, 'app-secret'));
  assert.ok(!verifyMetaSignature(Buffer.from(raw.toString().replace('Hello', 'Hellp')), sig, 'app-secret'));
  assert.ok(!verifyMetaSignature(raw, sig, 'other-secret'));
  assert.ok(!verifyMetaSignature(raw, undefined, 'app-secret'));
  assert.ok(!verifyMetaSignature(raw, 'sha1=abc', 'app-secret'));
  assert.ok(!verifyMetaSignature(raw, sig, ''));
});

test('parser: messages, media, interactive, statuses, template updates', () => {
  const ev = parseWebhook(webhook);
  const msgs = ev.filter((e) => e.kind === 'message');
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].text, 'Hello');
  assert.equal(msgs[0].profileName, 'Rahul');
  assert.equal(msgs[0].timestamp.toISOString(), new Date(1731400000 * 1000).toISOString());
  assert.equal(msgs[1].media.id, 'MEDIA1');
  assert.equal(msgs[1].text, 'zip broken');
  assert.deepEqual(msgs[2].interactive, { kind: 'button_reply', id: 'track', title: 'Track order' });
  assert.equal(msgs[2].context.replyTo, 'wamid.PREV');
  const st = ev.find((e) => e.kind === 'status');
  assert.equal(st.status, 'failed');
  assert.equal(st.errors[0].code, 131047);
  const tpl = ev.find((e) => e.kind === 'template_status');
  assert.equal(tpl.event, 'REJECTED');
  assert.equal(tpl.reason, 'INVALID_FORMAT');
  assert.equal(tpl.templateId, '123');
  assert.deepEqual(parseWebhook({ object: 'page' }), []);
});

test('status ordering never downgrades', () => {
  assert.ok(shouldApplyStatus('sent', 'delivered'));
  assert.ok(shouldApplyStatus('delivered', 'read'));
  assert.ok(!shouldApplyStatus('read', 'delivered'));
  assert.ok(!shouldApplyStatus('delivered', 'sent'));
  assert.ok(shouldApplyStatus('sent', 'failed'));
  assert.ok(!shouldApplyStatus('read', 'failed'));
  assert.ok(!shouldApplyStatus('failed', 'sent'));
  assert.ok(shouldApplyStatus('queued', 'sent'));
});

test('meta errors are classified for retry vs permanent', () => {
  assert.equal(classifyMetaError({ code: 130429 }).retry, true);
  assert.equal(classifyMetaError({ code: 131056 }).retry, true);
  assert.equal(classifyMetaError({ code: 80007 }).retry, true);
  assert.equal(classifyMetaError({ code: 131047 }).retry, false);
  assert.equal(classifyMetaError({ code: 190 }).alertAdmins, true);
  assert.equal(classifyMetaError({ status: 503 }).retry, true);
  assert.equal(classifyMetaError({ status: 400 }).retry, false);
  const e = fromGraphResponse(400, { error: { code: 131050, message: 'x' } });
  assert.ok(e.permanent && e.optOutMarketing);
  const r = fromGraphResponse(429, { error: { code: 130429, message: 'throughput' } });
  assert.ok(r.retryable && r.retryAfterMs > 0);
});

test('payload builders', () => {
  assert.equal(textPayload('91', 'hi').text.body, 'hi');
  assert.throws(() => textPayload('91', '  '));
  assert.equal(textPayload('91', 'hi', { replyTo: 'w' }).context.message_id, 'w');
  const b = buttonsPayload('91', 'Pick', [{ id: 'a', title: 'A very long button title here' }, { title: 'B' }, { title: 'C' }, { title: 'D' }]);
  assert.equal(b.interactive.action.buttons.length, 3);
  assert.equal(b.interactive.action.buttons[0].reply.title.length, 20);
  const l = listPayload('91', 'Pick', 'Menu', [{ title: 'S', rows: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` })) }]);
  assert.equal(l.interactive.action.sections[0].rows.length, 10);
  assert.equal(mediaPayload('91', 'document', { id: 'M', filename: 'a.pdf', caption: 'c' }).document.filename, 'a.pdf');
  const comps = [
    { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
    { type: 'BODY', text: 'Order {{1}} is {{2}}.' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Track', url: 'https://x.com/{{1}}' }] },
  ];
  const t = templatePayload('91', { name: 'order', language: 'en', components: comps, values: ['A1', 'shipped'], headerValues: ['Ravi'], buttonValues: ['A1'] });
  assert.equal(t.template.components.length, 3);
  assert.equal(t.template.components[1].parameters[1].text, 'shipped');
  assert.throws(() => templatePayload('91', { name: 'order', components: comps, values: ['A1'] }), /missing value/);
  assert.throws(() => templatePayload('91', { name: 'img', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }] }), /image header/);
  assert.equal(renderTemplatePreview(comps, ['A1', 'shipped'], ['Ravi']).split('\n')[1], 'Order A1 is shipped.');
});

test('template validation', () => {
  assert.deepEqual(validateTemplateComponents([{ type: 'BODY', text: 'Hello {{1}}, thanks!', example: { body_text: [['Ravi']] } }]), []);
  assert.ok(validateTemplateComponents([{ type: 'BODY', text: '{{1}} hello' }]).some((p) => /start/.test(p)));
  assert.ok(validateTemplateComponents([{ type: 'BODY', text: 'Hi {{2}} there' }]).some((p) => /order/.test(p)));
  assert.ok(validateTemplateComponents([{ type: 'BODY', text: 'Hi {{1}} there' }]).some((p) => /example/.test(p)));
  assert.ok(validateTemplateComponents([]).some((p) => /required/.test(p)));
});
