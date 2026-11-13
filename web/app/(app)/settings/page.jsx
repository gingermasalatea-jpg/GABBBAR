'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { Page, RequirePermission } from '@/components/Shell';
import { Async, PageHeader, Tabs } from '@/components/ui';
import WhatsAppSettings from '@/components/settings/WhatsAppSettings';
import { BusinessSettings, HoursSettings } from '@/components/settings/BusinessSettings';
import AiSettings from '@/components/settings/AiSettings';
import KnowledgeSettings from '@/components/settings/KnowledgeSettings';
import TeamSettings from '@/components/settings/TeamSettings';
import { AuditLog, DeadLetters, FieldsSettings } from '@/components/settings/OpsSettings';
import ConnectorsSettings from '@/components/settings/ConnectorsSettings';

function SettingsInner() {
  const { can } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const { data, error, loading, reload } = useApi('/settings');

  const tabs = [
    { value: 'whatsapp', label: 'WhatsApp' },
    { value: 'business', label: 'Business profile' },
    { value: 'hours', label: 'Working hours' },
    { value: 'ai', label: 'AI assistant' },
    { value: 'knowledge', label: 'Knowledge base' },
    { value: 'fields', label: 'Contact fields' },
    can('users.manage') && { value: 'team', label: 'Team & roles' },
    can('connectors.manage') && { value: 'connectors', label: 'Connectors & API' },
    can('audit.view') && { value: 'audit', label: 'Audit log' },
    can('dlq.manage') && { value: 'dlq', label: 'Failed jobs' },
  ].filter(Boolean);
  const tab = tabs.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'whatsapp';
  const setTab = (t) => router.replace(`/settings?tab=${t}`);

  return (
    <Page>
      <PageHeader title="Settings" description="Connection, business profile, AI, team and integrations." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <Async loading={loading} error={error} onRetry={reload}>
        {data && (
          <>
            {tab === 'whatsapp' && <WhatsAppSettings data={data} reload={reload} />}
            {tab === 'business' && <BusinessSettings data={data} reload={reload} />}
            {tab === 'hours' && <HoursSettings data={data} reload={reload} />}
            {tab === 'ai' && <AiSettings data={data} reload={reload} />}
            {tab === 'knowledge' && <KnowledgeSettings />}
            {tab === 'fields' && <FieldsSettings />}
            {tab === 'team' && <TeamSettings />}
            {tab === 'connectors' && <ConnectorsSettings data={data} reload={reload} />}
            {tab === 'audit' && <AuditLog />}
            {tab === 'dlq' && <DeadLetters />}
          </>
        )}
      </Async>
    </Page>
  );
}

export default function SettingsPage() {
  return (
    <RequirePermission perm="settings.view">
      <Suspense fallback={null}>
        <SettingsInner />
      </Suspense>
    </RequirePermission>
  );
}
