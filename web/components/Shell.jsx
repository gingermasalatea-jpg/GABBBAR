'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { cx, LoadingState, ErrorState } from './ui';
import { initials } from '@/lib/format';

const NAV = [
  { href: '/inbox', label: 'Inbox', icon: '💬', perm: 'inbox.view' },
  { href: '/contacts', label: 'Contacts', icon: '👥', perm: 'contacts.view' },
  { href: '/templates', label: 'Templates', icon: '📝', perm: 'templates.view' },
  { href: '/broadcasts', label: 'Broadcasts', icon: '📣', perm: 'broadcasts.view' },
  { href: '/automations', label: 'Automations', icon: '⚡', perm: 'automations.view' },
  { href: '/ai', label: 'AI Assistant', icon: '🤖', perm: 'ai.view_logs' },
  { href: '/tickets', label: 'Tickets', icon: '🎫', perm: 'tickets.view' },
  { href: '/analytics', label: 'Analytics', icon: '📊', perm: 'analytics.view' },
  { href: '/settings', label: 'Settings', icon: '⚙️', perm: 'settings.view' },
];

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      /* storage blocked */
    }
  };
  return (
    <button onClick={toggle} className="rounded-lg p-2 text-lg hover:bg-slate-100 dark:hover:bg-slate-800" title="Toggle dark mode" aria-label="Toggle dark mode">
      {dark ? '☀️' : '🌙'}
    </button>
  );
}

function StatusBanner({ status }) {
  if (!status) return null;
  if (status.sendLive) return null;
  return (
    <div className="flex items-center justify-center gap-2 bg-amber-100 px-3 py-1.5 text-center text-xs font-medium text-amber-900 dark:bg-amber-900/60 dark:text-amber-100">
      <span>🧪</span>
      <span>
        {status.mock?.whatsapp
          ? 'Demo mode — WhatsApp is mocked. No real customer messages are sent.'
          : '"Send live" is OFF — replies are held and not delivered to customers.'}{' '}
        <Link href="/settings?tab=whatsapp" className="underline">
          Settings
        </Link>
      </span>
    </div>
  );
}

export default function Shell({ children }) {
  const { user, status, loading, error, can, logout, refresh } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user && !error) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [loading, user, error, router, pathname]);

  useEffect(() => setMobileOpen(false), [pathname]);

  if (loading) return <LoadingState label="Loading your workspace…" className="h-full" />;
  if (error) return <ErrorState error={error} onRetry={refresh} className="h-full" />;
  if (!user) return <LoadingState label="Redirecting to sign in…" className="h-full" />;

  const nav = NAV.filter((n) => can(n.perm));

  return (
    <div className="flex h-full flex-col">
      <StatusBanner status={status} />
      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside
          className={cx(
            'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-slate-200 bg-white transition-transform dark:border-slate-800 dark:bg-slate-900 md:static md:translate-x-0',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex items-center gap-2 px-4 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">💬</div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{status?.businessName || 'GABBBAR'}</div>
              <div className="text-xs text-slate-500">Team inbox</div>
            </div>
          </div>
          <nav className="scroll-thin flex-1 space-y-0.5 overflow-y-auto px-2">
            {nav.map((n) => {
              const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cx(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
                    active ? 'bg-brand-50 text-brand-800 dark:bg-brand-800/30 dark:text-brand-200' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                  )}
                >
                  <span className="w-5 text-center">{n.icon}</span>
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-slate-200 p-3 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold dark:bg-slate-700">{initials(user.name)}</div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{user.name}</div>
                <div className="truncate text-xs capitalize text-slate-500">{user.role.replace('_', ' ')}</div>
              </div>
              <ThemeToggle />
            </div>
            <button onClick={logout} className="mt-2 w-full rounded-lg px-3 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
              Sign out
            </button>
          </div>
        </aside>
        {mobileOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setMobileOpen(false)} />}

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar */}
          <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900 md:hidden">
            <button onClick={() => setMobileOpen(true)} className="rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Open menu">
              ☰
            </button>
            <span className="font-semibold">{nav.find((n) => pathname.startsWith(n.href))?.label || 'GABBBAR'}</span>
          </div>
          <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
    </div>
  );
}

/** Standard padded page container. */
export function Page({ children, className }) {
  return <div className={cx('mx-auto w-full max-w-7xl p-4 md:p-6', className)}>{children}</div>;
}

/** Guard a page behind a permission. */
export function RequirePermission({ perm, children }) {
  const { can } = useAuth();
  if (!can(perm)) {
    return (
      <Page>
        <div className="py-20 text-center text-sm text-slate-500">You don&apos;t have access to this page.</div>
      </Page>
    );
  }
  return children;
}
