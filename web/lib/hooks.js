'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Load data from the API with loading / error state and a reload function. */
export function useApi(path, { deps = [], skip = false } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!skip);
  const ctrl = useRef(null);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (skip || !path) return;
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const d = await api(path, { signal: c.signal });
        if (!c.signal.aborted) setData(d);
      } catch (e) {
        if (e.name !== 'AbortError' && !c.signal.aborted) setError(e);
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, skip, ...deps],
  );

  useEffect(() => {
    load();
    return () => ctrl.current?.abort();
  }, [load]);

  return { data, error, loading, reload: load, setData };
}

/**
 * Subscribe to server-sent events. `handlers` maps event type -> fn(data).
 * Reconnects automatically (EventSource does this natively).
 */
export function useEvents(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SSE_URL || '/api/events';
    const es = new EventSource(url, { withCredentials: true });
    const types = new Set();
    const listen = (type) => {
      if (types.has(type)) return;
      types.add(type);
      es.addEventListener(type, (e) => {
        let data = {};
        try {
          data = JSON.parse(e.data || '{}');
        } catch {
          /* ignore */
        }
        ref.current?.[type]?.(data);
        ref.current?.['*']?.(type, data);
      });
    };
    [
      'ready',
      'message.new',
      'message.status',
      'conversation.updated',
      'note.new',
      'ai.suggestion',
      'ticket.created',
      'contact.updated',
      'broadcast.progress',
      'settings.updated',
      'template.updated',
      'system.alert',
    ].forEach(listen);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  return connected;
}

export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
