import crypto from 'node:crypto';

/**
 * AES-256-GCM encryption for secrets at rest (Meta token, AI keys, Google tokens).
 * Format: v1:<iv b64>:<tag b64>:<ciphertext b64>
 */

export function parseKey(keyMaterial, fallbackSecret = '') {
  if (keyMaterial) {
    const buf = Buffer.from(keyMaterial, 'base64');
    if (buf.length === 32) return buf;
    // allow hex as well
    const hex = Buffer.from(keyMaterial, 'hex');
    if (hex.length === 32) return hex;
    throw new Error('ENCRYPTION_KEY must be 32 bytes (base64 or hex)');
  }
  if (!fallbackSecret) throw new Error('ENCRYPTION_KEY is not set');
  // Development fallback: derive a key from the JWT secret.
  return crypto.createHash('sha256').update(`wadesk-dev-key:${fallbackSecret}`).digest();
}

export function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(payload, key) {
  const parts = String(payload || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unrecognised ciphertext format');
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hmacSha256Hex(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}
