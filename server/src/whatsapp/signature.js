import crypto from 'node:crypto';

/**
 * Verify Meta's X-Hub-Signature-256 header: "sha256=<hex HMAC of the raw body with the App Secret>".
 * Must be computed over the exact raw bytes received.
 */
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret || !header || !Buffer.isBuffer(rawBody)) return false;
  const [algo, sig] = String(header).split('=');
  if (algo !== 'sha256' || !sig || !/^[a-f0-9]{64}$/i.test(sig)) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function signMetaBody(rawBody, appSecret) {
  return `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
