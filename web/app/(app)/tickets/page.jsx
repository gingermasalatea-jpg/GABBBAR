'use client';

import { useState } from 'react';
import Link from 'next/link';
import { patch } from '@/lib/api';
import { useApi, useEvents } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { Page, RequirePermission } from '@/components/Shell';
import { Async, Badge, Card, PageHeader, Pagination, Select, Table, useToast } from '@/components/ui';

const PRIORITY = { urgent: 'red', high: 'red', normal: 'amber', low: 'gray' };
const STATUS = { open: 'amber', in_progress: 'blue', closed: 'gray' };

function TicketsInner() {
  const { can, user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useApi(`/tickets?page=${page}${status ? `&status=${status}` : ''}${mine ? '&mine=true' : ''}`);
  const users = useApi('/users');
  useEvents({ 'ticket.created': () => reload({ silent: true }) });

  const update = async (t, body) => {
    try {
      await patch(`/tickets/${t.id}`, body);
      reload({ silent: true });
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const editable = can('tickets.manage');

  return (
    <Page>
      <PageHeader title="Tickets" description="Questions the AI could not answer from the knowledge base land here automatically, along with tickets your team creates." />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <Select className="w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="closed">Closed</option>
          </Select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Assigned to me</label>
        </div>
        <Async loading={loading} error={error} onRetry={reload} empty={!data?.rows?.length} emptyProps={{ icon: '🎫', title: 'No tickets', description: status === 'open' ? 'Nothing waiting — nice!' : 'No tickets match.' }}>
          <Table
            rows={data?.rows || []}
            columns={[
              { key: 'subject', label: 'Ticket', render: (t) => <div><div className="font-medium">{t.subject}</div>{t.description && <div className="line-clamp-2 max-w-md text-xs text-slate-500">{t.description}</div>}</div> },
              { key: 'contact', label: 'Customer', render: (t) => (t.conversation_id ? <Link className="text-xs text-brand-700 underline" href={`/inbox?c=${t.conversation_id}`}>{t.contact_name || t.contact_phone}</Link> : <span className="text-xs">{t.contact_name || '—'}</span>) },
              { key: 'source', label: 'Source', render: (t) => <Badge color={t.source === 'ai_fallback' ? 'blue' : 'gray'}>{t.source === 'ai_fallback' ? '🤖 AI fallback' : t.source}</Badge> },
              { key: 'priority', label: 'Priority', render: (t) => (editable ? <Select className="w-28 py-1 text-xs" value={t.priority} onChange={(e) => update(t, { priority: e.target.value })}>{['low', 'normal', 'high', 'urgent'].map((p) => <option key={p}>{p}</option>)}</Select> : <Badge color={PRIORITY[t.priority]}>{t.priority}</Badge>) },
              { key: 'assignee', label: 'Assignee', render: (t) => (editable ? <Select className="w-32 py-1 text-xs" value={t.assigned_to || ''} onChange={(e) => update(t, { assigned_to: e.target.value || null })}><option value="">—</option>{(users.data?.users || []).filter((u) => u.is_active && u.role !== 'viewer').map((u) => <option key={u.id} value={u.id}>{u.id === user.id ? 'Me' : u.name}</option>)}</Select> : <span className="text-xs">{t.assigned_name || '—'}</span>) },
              { key: 'status', label: 'Status', render: (t) => (editable ? <Select className="w-32 py-1 text-xs" value={t.status} onChange={(e) => update(t, { status: e.target.value })}><option value="open">open</option><option value="in_progress">in progress</option><option value="closed">closed</option></Select> : <Badge color={STATUS[t.status]}>{t.status}</Badge>) },
              { key: 'age', label: 'Age', render: (t) => <span className="text-xs text-slate-500">{timeAgo(t.created_at)}</span> },
            ]}
          />
          <Pagination page={page} limit={50} total={data?.total} onPage={setPage} />
        </Async>
      </Card>
    </Page>
  );
}

export default function TicketsPage() {
  return (
    <RequirePermission perm="tickets.view">
      <TicketsInner />
    </RequirePermission>
  );
}
