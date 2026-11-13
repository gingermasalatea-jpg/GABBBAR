'use client';

import { AuthProvider } from '@/lib/auth';
import { ToastProvider } from '@/components/ui';
import Shell from '@/components/Shell';

export default function AppLayout({ children }) {
  return (
    <AuthProvider>
      <ToastProvider>
        <Shell>{children}</Shell>
      </ToastProvider>
    </AuthProvider>
  );
}
