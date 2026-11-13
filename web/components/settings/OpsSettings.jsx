'use client';

import { useState } from 'react';
import { del, patch, post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { Async, Badge, Button, Card, Field, Input, ListEditor, Modal, Pagination, Select, Table, Toggle, useToast } from '@/components/ui';

export function FieldsSettings() {
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = can('settings.manage');
  const { data, error, loading, reload } = useApi('/custom-fields');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      if (form.id) await patch(`/custom-fields/${form.id}`, { label: form.label, type: form.type, options: form.options, internal: form.internal });
      else await post('/custom-fields', form);
      toast('Field saved');
      setForm(null);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (f) => {
    if (!window.confirm(`Delete field “${f.label}”? Its values will be removed from every contact.`)) return;
    try {
      await del(`/custom-fields/${f.id}`);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <Card title="Contact fields" actions={canEdit && <Button size="sm" onClick={() => setForm({ key: '', label: '', type: 'text', options: [], internal: false })}>Add field</Button>}>
      <p className="mb-3 text-xs text-slate-500">
        Fields marked <b>Internal</b> are visible to your team only — they are never shown to customers, never used in templates or automations, and never passed to the AI.
      </p>
      <Async loading={loading} error={error} onRetry={reload} empty={!data?.fields?.length} emptyProps={{ icon: '🏷️', title: 'No custom fields yet' }}>
        <Table
          rows={data?.fields || []}
          columns={[
            { key: 'label', label: 'Label', render: (f) => <span className="font-medium">{f.label}</span> },
            { key: 'key', label: 'Key', render: (f) => <code className="text-xs">{f.key}</code> },
            { key: 'type', label: 'Type' },
            { key: 'internal', label: 'Visibility', render: (f) => (f.internal ? <Badge color="red">Internal</Badge> : <Badge color="green">Customer-safe</Badge>) },
            {
              key: 'a',
              label: '',
              render: (f) =>
                canEdit && (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setForm(f)}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(f)}>Delete</Button>
                  </div>
                ),
            },
          ]}
        />
      </Async>
      <Modal open={Boolean(form)} onClose={() => setForm(null)} title={form?.id ? 'Edit field' : 'New field'} footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button onClick={save} loading={saving}>Save</Button></>}>
        {form && (
          <div className="space-y-4">
            <Field label="Label"><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value, key: form.id ? form.key : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 48) })} /></Field>
            <Field label="Key" hint="Used in placeholders like {{custom.key}}">
              <Input value={form.key} disabled={Boolean(form.id)} onChange={(e) => setForm({ ...form, key: e.target.value })} />
            </Field>
            <Field label="Type">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {['text', 'number', 'date', 'boolean', 'select'].map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
            {form.type === 'select' && <Field label="Options"><ListEditor value={form.options || []} onChange={(v) => setForm({ ...form, options: v })} /></Field>}
            <Toggle checked={form.internal} onChange={(v) => setForm({ ...form, internal: v })} label="Internal" description="Hide from customers and the AI (e.g. ID numbers, payment proofs, credit limits)." />
          </div>
        )}
      </Modal>
    </Card>
  );
}

export function AuditLog() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const { data, error, loading, reload } = useApi(`/audit-logs?page=${page}&limit=50${action ? `&action=${encodeURIComponent(action)}` : ''}`);
  return (
    <Card title="Audit log">
      <div className="mb-3 max-w-xs">
        <Input placeholder="Filter by action prefix, e.g. settings." value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} />
      </div>
      <Async loading={loading} error={error} onRetry={reload} empty={!data?.rows?.length} emptyProps={{ icon: '🧾', title: 'No audit entries' }}>
        <Table
          rows={data?.rows || []}
          columns={[
            { key: 'created_at', label: 'When', render: (r) => <span className="whitespace-nowrap text-xs">{fmtDateTime(r.created_at)}</span> },
            { key: 'actor', label: 'Actor', render: (r) => <span className="text-xs">{r.user_name || r.actor_label || r.actor_type}</span> },
            { key: 'action', label: 'Action', render: (r) => <code className="text-xs">{r.action}</code> },
            { key: 'entity', label: 'Entity', render: (r) => <span className="text-xs text-slate-500">{r.entity_type ? `${r.entity_type}:${String(r.entity_id || '').slice(0, 12)}` : '—'}</span> },
            { key: 'meta', label: 'Details', render: (r) => <span className="line-clamp-2 max-w-xs break-all text-xs text-slate-500">{Object.keys(r.meta || {}).length ? JSON.stringify(r.meta) : ''}</span> },
            { key: 'ip', label: 'IP', render: (r) => <span className="text-xs text-slate-400">{r.ip}</span> },
          ]}
        />
        <Pagination page={page} limit={50} total={data?.total} onPage={setPage} />
      </Async>
    </Card>
  );
}

export function DeadLetters() {
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const { data, error, loading, reload } = useApi(`/dlq?status=${status}`);
  const [busy, setBusy] = useState(null);

  const act = async (id, action) => {
    setBusy(id);
    try {
      await post(`/dlq/${id}/${action}`);
      toast(action === 'retry' ? 'Job re-queued' : 'Job discarded');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Failed jobs (dead-letter queue)" actions={<Button size="sm" variant="secondary" onClick={() => reload()}>Refresh</Button>}>
      <p className="mb-3 text-xs text-slate-500">Jobs land here after all automatic retries (with exponential backoff) have failed. Retry them after fixing the cause.</p>
      <div className="mb-3 max-w-xs">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="retried">Retried</option>
          <option value="discarded">Discarded</option>
        </Select>
      </div>
      <Async loading={loading} error={error} onRetry={reload} empty={!data?.rows?.length} emptyProps={{ icon: '✅', title: 'No failed jobs', description: 'Everything is flowing.' }}>
        <Table
          rows={data?.rows || []}
          columns={[
            { key: 'created_at', label: 'Failed at', render: (r) => <span className="whitespace-nowrap text-xs">{fmtDateTime(r.created_at)}</span> },
            { key: 'queue', label: 'Queue', render: (r) => <Badge color="purple">{r.queue}</Badge> },
            { key: 'job_name', label: 'Job', render: (r) => <code className="text-xs">{r.job_name}</code> },
            { key: 'error', label: 'Error', render: (r) => <span className="line-clamp-3 max-w-md text-xs text-red-600">{r.error}</span> },
            { key: 'attempts', label: 'Tries' },
            {
              key: 'a',
              label: '',
              render: (r) =>
                r.status === 'open' && (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="secondary" loading={busy === r.id} onClick={() => act(r.id, 'retry')}>Retry</Button>
                    <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => act(r.id, 'discard')}>Discard</Button>
                  </div>
                ),
            },
          ]}
        />
      </Async>
    </Card>
  );
}
