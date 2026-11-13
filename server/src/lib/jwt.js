import crypto from 'node:crypto';
import { safeEqual } from './crypto.js';

/** Minimal, dependency-free HS256 JWT (RFC 7519) — only what this app needs. */

const b64url = (input) => Buffer.from(input).toString('base64url');

export function signJwt(payload, secret, { expiresInSeconds = 3600, now = Date.now() } = {}) {
  if (!secret) throw new Error('JWT secret missing');
  const iat = Math.floor(now / 1000);
  const body = { ...payload, iat, exp: iat + expiresInSeconds };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyJwt(token, secret, { now = Date.now() } = {}) {
  if (!token || typeof token !== 'string') throw new Error('Missing token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [head, body, sig] = parts;
  let header;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed token header');
  }
  if (header.alg !== 'HS256') throw new Error('Unsupported algorithm');
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  if (!safeEqual(expected, sig)) throw new Error('Invalid signature');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed token payload');
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) throw new Error('Token expired');
  return payload;
}
