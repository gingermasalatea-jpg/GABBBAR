'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api('/auth/me');
      setUser(me.user);
      setError(null);
      const st = await api('/settings/status').catch(() => null);
      setStatus(st);
    } catch (e) {
      if (e.status !== 401) setError(e);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const can = useCallback((perm) => Boolean(user?.permissions?.includes(perm)), [user]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    window.location.href = '/login';
  }, []);

  return <AuthCtx.Provider value={{ user, status, loading, error, can, refresh, logout }}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
