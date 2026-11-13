import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { ah, badRequest, forbidden } from '../lib/errors.js';
import { z, body } from '../lib/validate.js';
import { toE164, toWaId } from '../lib/phone.js';
import { requirePermission } from '../middleware/auth.js';
import { getClient, mockClient } from '../whatsapp/client.js';
import { enqueue } from '../queue/index.js';
import { audit } from '../services/audit.js';
import { getSection } from '../services/settings.js';

const r = Router();

/** "Test connection": reads the phone number from the Graph API with the stored token. */
r.post(
  '/test',
  requirePermission('settings.view'),
  ah(async (req, res) => {
    try {
      const info = await getClient().getPhoneNumberInfo();
      await audit({ req, action: 'whatsapp.test_connection', meta: { ok: true } });
      res.json({ ok: true, mock: config.mock.whatsapp, ...info });
    } catch (err) {
      await audit({ req, action: 'whatsapp.test_connection', meta: { ok: false, code: err.code } });
      res.json({ ok: false, error: err.message, code: err.code });
    }
  }),
);

/**
 * Demo mode only: simulate a customer message exactly as Meta would deliver it,
 * through the same queue and pipeline as real webhooks.
 */
r.post(
  '/simulate-inbound',
  requirePermission('inbox.reply'),
  ah(async (req, res) => {
    if (!config.mock.whatsapp) throw forbidden('Simulation is only available while WHATSAPP_MOCK=true');
    const data = body(
      z.object({
        phone: z.string().min(5).max(30),
        name: z.string().max(100).optional(),
        text: z.string().max(4096).optional(),
        button_reply: z.object({ id: z.string().max(256), title: z.string().max(40) }).optional(),
        media: z.object({ base64: z.string().max(14_000_000), mime_type: z.string().max(100), file_name: z.string().max(200).optional(), caption: z.string().max(1024).optional() }).optional(),
      }),
      req,
    );
    const cc = (await getSection('general')).default_country_code;
    const e164 = toE164(data.phone, cc);
    if (!e164) throw badRequest('Invalid phone number');
    const from = toWaId(e164);
    const id = `wamid.SIM.${crypto.randomBytes(10).toString('hex')}`;
    let message;
    if (data.media) {
      const buf = Buffer.from(data.media.base64, 'base64');
      const up = await mockClient.uploadMedia(buf, data.media.mime_type);
      const kind = data.media.mime_type.startsWith('image/') ? 'image' : data.media.mime_type.startsWith('audio/') ? 'audio' : data.media.mime_type.startsWith('video/') ? 'video' : 'document';
      message = { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: kind, [kind]: { id: up.id, mime_type: data.media.mime_type, caption: data.media.caption, filename: data.media.file_name } };
    } else if (data.button_reply) {
      message = { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'button_reply', button_reply: data.button_reply } };
    } else {
      if (!data.text?.trim()) throw badRequest('Enter a message');
      message = { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: data.text } };
    }
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'MOCK_WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '919000000000', phone_number_id: 'MOCK' },
                contacts: [{ profile: { name: data.name || 'Demo Customer' }, wa_id: from }],
                messages: [message],
              },
            },
          ],
        },
      ],
    };
    await enqueue('inbound', 'webhook', { body: payload, simulated: true }, { jobId: `wh:${id}` });
    res.json({ ok: true, wamid: id, phone: e164 });
  }),
);

export default r;
