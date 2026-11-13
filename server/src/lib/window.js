/**
 * WhatsApp 24-hour customer service window.
 * Free-form messages are allowed only within 24h of the customer's last inbound message.
 * Outside it, only approved templates may be sent.
 */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export function windowInfo(lastInboundAt, now = Date.now()) {
  if (!lastInboundAt) return { open: false, expiresAt: null, remainingMs: 0 };
  const start = new Date(lastInboundAt).getTime();
  const expiresAt = start + WINDOW_MS;
  const remainingMs = Math.max(0, expiresAt - now);
  return { open: remainingMs > 0, expiresAt: new Date(expiresAt).toISOString(), remainingMs };
}

export function isWindowOpen(lastInboundAt, now = Date.now()) {
  return windowInfo(lastInboundAt, now).open;
}
