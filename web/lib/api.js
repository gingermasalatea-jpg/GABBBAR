'use client';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Fetch wrapper for the backend. Cookies carry the session; the custom header
 * satisfies the server's CSRF check on mutating requests.
 */
export async function api(path, { method = 'GET', body, headers, raw = false, signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    signal,
    headers: {
      'X-Requested-With': 'wadesk',
      ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (raw && res.ok) return res;
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login') && !path.startsWith('/auth/login')) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    const detail = data?.details?.length ? ` (${data.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message || d.error)).join('; ')})` : '';
    throw new ApiError(res.status, (data?.error || `Request failed (${res.status})`) + detail, data?.details);
  }
  return data;
}

export const get = (p, o) => api(p, o);
export const post = (p, body, o) => api(p, { ...o, method: 'POST', body: body ?? {} });
export const put = (p, body, o) => api(p, { ...o, method: 'PUT', body: body ?? {} });
export const patch = (p, body, o) => api(p, { ...o, method: 'PATCH', body: body ?? {} });
export const del = (p, o) => api(p, { ...o, method: 'DELETE' });

export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
