import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toE164, toWaId, fromWaId, isE164, maskPhone } from '../src/lib/phone.js';
import { encrypt, decrypt, parseKey, safeEqual, hmacSha256Hex } from '../src/lib/crypto.js';
import { signJwt, verifyJwt } from '../src/lib/jwt.js';
import { parseCsv, parseCsvWithHeaders, toCsv } from '../src/lib/csv.js';
import { can, canManageRole, MATRIX, PERMISSIONS } from '../src/lib/permissions.js';
import { isWithinWorkingHours, localTime } from '../src/lib/workingHours.js';
import { windowInfo, isWindowOpen } from '../src/lib/window.js';
import { backoffDelay, retry } from '../src/lib/backoff.js';
import { countBodyVariables, renderNumbered, customerSafeContact, buildTemplateValues, renderContactPlaceholders } from '../src/lib/templateVars.js';
import { findSensitive, redactSensitive } from '../src/lib/redact.js';

test('phone: normalises Indian and international formats to E.164', () => {
  assert.equal(toE164('9876543210'), '+919876543210');
  assert.equal(toE164('09876543210'), '+919876543210');
  assert.equal(toE164('+91 98765-43210'), '+919876543210');
  assert.equal(toE164('919876543210'), '+919876543210');
  assert.equal(toE164('0044 20 7946 0958'), '+442079460958');
  assert.equal(toE164('+1 (415) 555-2671'), '+14155552671');
  assert.equal(toE164('12345'), null);
  assert.equal(toE164(''), null);
  assert.equal(toE164('abc'), null);
  assert.equal(toWaId('+919876543210'), '919876543210');
  assert.equal(fromWaId('919876543210'), '+919876543210');
  assert.ok(isE164('+919876543210'));
  assert.ok(!isE164('919876543210'));
  assert.equal(maskPhone('+919876543210'), '+91******3210');
});

test('crypto: AES-GCM round trip and tamper detection', () => {
  const key = parseKey('', 'some-secret');
  const enc = encrypt('EAAG-secret-token', key);
  assert.notEqual(enc, 'EAAG-secret-token');
  assert.equal(decrypt(enc, key), 'EAAG-secret-token');
  const parts = enc.split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(parts.join(':'), key));
  assert.throws(() => parseKey('short'));
  const k32 = Buffer.alloc(32, 7).toString('base64');
  assert.equal(parseKey(k32).length, 32);
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.equal(hmacSha256Hex('k', 'body').length, 64);
});

test('jwt: sign, verify, expiry and tampering', () => {
  const t = signJwt({ sub: 'u1', role: 'agent' }, 'secret', { expiresInSeconds: 60 });
  assert.equal(verifyJwt(t, 'secret').sub, 'u1');
  assert.throws(() => verifyJwt(t, 'other'), /signature/);
  assert.throws(() => verifyJwt(t, 'secret', { now: Date.now() + 120_000 }), /expired/);
  const [h, , s] = t.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin', exp: 9999999999 })).toString('base64url')}.${s}`;
  assert.throws(() => verifyJwt(forged, 'secret'));
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x","exp":9999999999}').toString('base64url')}.`;
  assert.throws(() => verifyJwt(none, 'secret'));
});

test('csv: quotes, newlines, headers kept exactly, formula injection neutralised', () => {
  const text = '﻿Customer Name,Mobile No.,Notes\r\n"Sharma, Rahul",9876543210,"said ""hi""\nthere"\nPriya,9876500000,\n';
  const { headers, records } = parseCsvWithHeaders(text);
  assert.deepEqual(headers, ['Customer Name', 'Mobile No.', 'Notes']);
  assert.equal(records.length, 2);
  assert.equal(records[0]['Customer Name'], 'Sharma, Rahul');
  assert.equal(records[0].Notes, 'said "hi"\nthere');
  assert.equal(parseCsv('a,b\n\n').length, 1);
  const out = toCsv(['a', 'b'], [{ a: '=HYPERLINK("x")', b: 'x,y' }]);
  assert.ok(out.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(out.includes('"x,y"'));
});

test('permissions: matrix rules', () => {
  assert.ok(can('super_admin', 'users.manage_admins'));
  assert.ok(!can('admin', 'users.manage_admins'));
  assert.ok(can('admin', 'send_live.toggle'));
  assert.ok(!can('agent', 'send_live.toggle'));
  assert.ok(can('agent', 'inbox.reply'));
  assert.ok(!can('viewer', 'inbox.reply'));
  assert.ok(!can('viewer', 'settings.secrets'));
  assert.ok(canManageRole('admin', 'agent'));
  assert.ok(!canManageRole('admin', 'admin'));
  assert.ok(canManageRole('super_admin', 'admin'));
  assert.ok(!canManageRole('agent', 'viewer'));
  for (const role of Object.keys(MATRIX)) for (const p of MATRIX[role]) assert.ok(p in PERMISSIONS, `${p} defined`);
});

test('working hours in business timezone', () => {
  const hours = { timezone: 'Asia/Kolkata', days: { mon: [{ start: '09:30', end: '18:30' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [{ start: '22:00', end: '02:00' }] } };
  // Monday 2026-11-09 10:00 IST = 04:30 UTC
  assert.equal(localTime(new Date('2026-11-09T04:30:00Z'), 'Asia/Kolkata').day, 'mon');
  assert.ok(isWithinWorkingHours(hours, new Date('2026-11-09T04:30:00Z')));
  assert.ok(!isWithinWorkingHours(hours, new Date('2026-11-09T13:30:00Z'))); // 19:00 IST
  assert.ok(!isWithinWorkingHours(hours, new Date('2026-11-10T04:30:00Z'))); // Tuesday closed
  assert.ok(isWithinWorkingHours(hours, new Date('2026-11-08T17:00:00Z'))); // Sun 22:30 IST overnight slot
});

test('24-hour window', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  assert.ok(isWindowOpen('2026-11-13T00:00:00Z', now));
  assert.ok(!isWindowOpen('2026-11-12T11:59:00Z', now));
  assert.ok(!isWindowOpen(null, now));
  assert.equal(windowInfo('2026-11-13T00:00:00Z', now).remainingMs, 12 * 3600 * 1000);
});

test('backoff grows exponentially and retry stops on permanent errors', async () => {
  assert.equal(backoffDelay(1, { jitter: false, baseMs: 1000 }), 1000);
  assert.equal(backoffDelay(4, { jitter: false, baseMs: 1000 }), 8000);
  assert.equal(backoffDelay(30, { jitter: false, baseMs: 1000, maxMs: 60000 }), 60000);
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error('perm'); }, { attempts: 5, baseMs: 1, shouldRetry: () => false }));
  assert.equal(calls, 1);
  calls = 0;
  const v = await retry(async () => { calls++; if (calls < 3) throw new Error('t'); return 'ok'; }, { attempts: 5, baseMs: 1 });
  assert.equal(v, 'ok');
});

test('template variables never expose internal fields', () => {
  assert.equal(countBodyVariables('Hi {{1}}, order {{2}} is {{3}}'), 3);
  assert.equal(renderNumbered('Hi {{1}} {{2}}', ['Ravi']), 'Hi Ravi {{2}}');
  const fields = [{ key: 'city', internal: false }, { key: 'pan_number', internal: true }];
  const safe = customerSafeContact({ name: 'Ravi Kumar', phone: '+91', custom: { city: 'Pune', pan_number: 'ABCDE1234F' } }, fields);
  assert.equal(safe.first_name, 'Ravi');
  assert.equal(safe.custom.city, 'Pune');
  assert.equal(safe.custom.pan_number, undefined);
  assert.deepEqual(buildTemplateValues({ 1: { type: 'field', value: 'first_name' }, 2: { type: 'field', value: 'custom.pan_number', fallback: 'n/a' }, 3: { type: 'static', value: 'X' } }, safe), ['Ravi', 'n/a', 'X']);
  assert.equal(renderContactPlaceholders('Hi {{first_name}} from {{custom.city}} {{custom.pan_number}} {{unknown}}', safe), 'Hi Ravi from Pune  {{unknown}}');
});

test('redaction of ID numbers and payment data', () => {
  const text = 'PAN ABCDE1234F, Aadhaar 2345 6789 0123, card 4111 1111 1111 1111, IFSC HDFC0001234, UTR: 412345678901, phone 9876543210';
  const kinds = findSensitive(text).map((f) => f.kind);
  for (const k of ['pan', 'aadhaar', 'card', 'ifsc', 'upi_ref']) assert.ok(kinds.includes(k), k);
  const red = redactSensitive(text);
  assert.ok(!red.includes('ABCDE1234F'));
  assert.ok(!red.includes('4111 1111 1111 1111'));
  assert.ok(red.includes('9876543210'), 'plain 10-digit phone is not redacted');
  assert.ok(!findSensitive('Order SUN1023 ships in 3-7 days').length);
});
