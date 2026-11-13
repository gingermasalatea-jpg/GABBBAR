import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { getClient } from '../whatsapp/client.js';
import { publish } from './realtime.js';

const EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

// WhatsApp outbound limits (bytes)
const LIMITS = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, audio: 16 * 1024 * 1024, document: 100 * 1024 * 1024, sticker: 500 * 1024 };
const OUTBOUND_MIME = {
  image: ['image/jpeg', 'image/png'],
  video: ['video/mp4', 'video/3gpp'],
  audio: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
  document: null, // any
  sticker: ['image/webp'],
};

export function mediaTypeForMime(mime) {
  if (/^image\/webp$/.test(mime)) return 'image';
  if (/^image\//.test(mime)) return 'image';
  if (/^video\//.test(mime)) return 'video';
  if (/^audio\//.test(mime)) return 'audio';
  return 'document';
}

async function storeBuffer(buffer, mimeType) {
  const now = new Date();
  const dir = path.join(config.mediaDir, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.${EXT[mimeType] || 'bin'}`;
  const full = path.join(dir, name);
  await fs.writeFile(full, buffer, { mode: 0o640 });
  return { storagePath: full, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), size: buffer.length };
}

/** Worker: download an inbound media file from Meta right away (download URLs expire after ~5 minutes). */
export async function downloadInboundMedia(mediaId) {
  const media = await one('SELECT * FROM media WHERE id = $1', [mediaId]);
  if (!media || media.status === 'stored') return;
  const client = getClient();
  try {
    const info = await client.getMediaInfo(media.wa_media_id);
    const buf = await client.downloadMedia(info.url);
    const mime = info.mime_type || media.mime_type || 'application/octet-stream';
    if (media.sha256 && info.sha256 && media.sha256 !== info.sha256) {
      // Meta sends sha256 of the file; mismatch means a corrupted download — retry.
      const e = new Error('Media checksum mismatch');
      throw e;
    }
    const stored = await storeBuffer(buf, mime);
    await query(`UPDATE media SET status = 'stored', storage_path = $2, sha256 = $3, size_bytes = $4, mime_type = $5, error = NULL WHERE id = $1`, [
      media.id,
      stored.storagePath,
      stored.sha256,
      stored.size,
      mime,
    ]);
    const msg = await one('SELECT conversation_id FROM messages WHERE id = $1', [media.message_id]);
    publish('message.status', { conversation_id: msg?.conversation_id, message_id: media.message_id, media_ready: true });
  } catch (err) {
    await query(`UPDATE media SET error = $2 WHERE id = $1`, [media.id, String(err.message).slice(0, 500)]);
    if (err.permanent) await query(`UPDATE media SET status = 'failed' WHERE id = $1`, [media.id]);
    throw err;
  }
}

/** Save a file uploaded by an agent so it can be sent (and shown in the chat). */
export async function saveOutboundUpload({ base64, mimeType, fileName, type }) {
  const t = type || mediaTypeForMime(mimeType);
  const allowed = OUTBOUND_MIME[t];
  if (allowed && !allowed.includes(mimeType)) throw badRequest(`WhatsApp does not accept ${mimeType} as ${t}`);
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw badRequest('File is empty');
  if (buf.length > LIMITS[t]) throw badRequest(`File too large for ${t} (max ${Math.round(LIMITS[t] / 1024 / 1024)} MB)`);
  const stored = await storeBuffer(buf, mimeType);
  const row = await one(
    `INSERT INTO media (mime_type, file_name, size_bytes, sha256, storage_path, status) VALUES ($1,$2,$3,$4,$5,'stored') RETURNING *`,
    [mimeType, fileName || null, stored.size, stored.sha256, stored.storagePath],
  );
  return { media: row, type: t };
}

export async function getMediaFile(id) {
  const m = await one(
    `SELECT md.*, msg.conversation_id, c.assigned_to FROM media md
       LEFT JOIN messages msg ON msg.id = md.message_id LEFT JOIN conversations c ON c.id = msg.conversation_id WHERE md.id = $1`,
    [id],
  );
  if (!m || m.status !== 'stored' || !m.storage_path) return null;
  const resolved = path.resolve(m.storage_path);
  if (!resolved.startsWith(path.resolve(config.mediaDir))) return null; // path traversal guard
  return { ...m, path: resolved };
}
