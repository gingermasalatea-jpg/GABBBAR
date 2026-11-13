'use client';

import { useEffect, useMemo, useState } from 'react';
import { post } from '@/lib/api';
import { useApi, useEvents } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { Page, RequirePermission } from '@/components/Shell';
import TemplatePreview from '@/components/TemplatePreview';
import { Async, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Table, Textarea, useToast } from '@/components/ui';

const STATUS = { draft: 'gray', scheduled: 'blue', running: 'amber', completed: 'green', cancelled: 'gray', failed: 'red' };
const FIELD_SOURCES = [
  ['first_name', 'First name'],
  ['name', 'Full name'],
  ['phone', 'Phone'],
];

function Composer({ onClose, onDone }) {
  const toast = useToast();
  const templates = useApi('/templates?status=APPROVED');
  const fields = useApi('/custom-fields');
  const tags = useApi('/contacts/tags');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [vars, setVars] = useState({});
  const [headerUrl, setHeaderUrl] = useState('');
  const [audience, setAudience] = useState({ type: 'tags', tags: [], match: 'any' });
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState(null);
  const [when, setWhen] = useState('now');
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState(false);

  const tpl = (templates.data?.templates || []).find((t) => t.id === templateId);
  const body = tpl?.components.find((c) => c.type === 'BODY');
  const header = tpl?.components.find((c) => c.type === 'HEADER');
  const nVars = body ? [...body.text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].length : 0;
  const safeFields = (fields.data?.fields || []).filter((f) => !f.internal);

  const effectiveAudience = useMemo(() => (audience.type === 'csv' ? { type: 'csv', phones: csvText.split(/[\s,;]+/).filter(Boolean) } : audience), [audience, csvText]);

  useEffect(() => {
    const ok = effectiveAudience.type === 'all' || (effectiveAudience.type === 'tags' && effectiveAudience.tags.length) || (effectiveAudience.type === 'filter' && effectiveAudience.field && effectiveAudience.value) || (effectiveAudience.type === 'csv' && effectiveAudience.phones.length);
    if (!ok) return setPreview(null);
    const t = setTimeout(() => post('/broadcasts/preview-audience', { audience: effectiveAudience }).then(setPreview).catch((e) => setPreview({ error: e.message })), 300);
    return () => clearTimeout(t);
  }, [effectiveAudience]);

  const sampleValues = Array.from({ length: nVars }, (_, i) => {
    const v = vars[String(i + 1)];
    if (!v) return '';
    return v.type === 'static' ? v.value : `[${v.value}]`;
  });

  const submit = async () => {
    setBusy(true);
    try {
      const { broadcast } = await post('/broadcasts', { name, template_id: templateId, template_variables: vars, header_media_url: headerUrl || undefined, audience: effectiveAudience });
      await post(`/broadcasts/${broadcast.id}/schedule`, { scheduled_at: when === 'later' && at ? new Date(at).toISOString() : null });
      toast(when === 'later' ? 'Broadcast scheduled' : 'Broadcast started');
      onDone();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const ready = name && templateId && preview?.eligible > 0 && Array.from({ length: nVars }, (_, i) => vars[String(i + 1)]?.value).every(Boolean) && (!header || header.format === 'TEXT' || headerUrl) && (when === 'now' || at);

  return (
    <Modal open wide onClose={onClose} title="New broadcast" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={busy} disabled={!ready}>{when === 'now' ? `Send to ${preview?.eligible ?? 0} contacts` : 'Schedule'}</Button></>}>
      <div className="grid gap-5 md:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali offer 2026" /></Field>
          <Field label="Approved template">
            <Select value={templateId} onChange={(e) => { setTemplateId(e.target.value); setVars({}); }}>
              <option value="">Choose…</option>
              {(templates.data?.templates || []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language} · {t.category.toLowerCase()})</option>)}
            </Select>
          </Field>
          {header && header.format !== 'TEXT' && <Field label={`Header ${header.format.toLowerCase()} URL`}><Input value={headerUrl} onChange={(e) => setHeaderUrl(e.target.value)} placeholder="https://…" /></Field>}
          {Array.from({ length: nVars }, (_, i) => {
            const k = String(i + 1);
            const v = vars[k] || { type: 'field', value: '' };
            return (
              <div key={k} className="grid grid-cols-[5rem_8rem_1fr] items-end gap-2">
                <span className="pb-2 text-sm font-medium">{`{{${k}}}`}</span>
                <Select value={v.type} onChange={(e) => setVars({ ...vars, [k]: { type: e.target.value, value: '' } })}>
                  <option value="field">Contact field</option>
                  <option value="static">Fixed text</option>
                </Select>
                {v.type === 'field' ? (
                  <Select value={v.value} onChange={(e) => setVars({ ...vars, [k]: { type: 'field', value: e.target.value, fallback: 'there' } })}>
                    <option value="">Choose…</option>
                    {FIELD_SOURCES.map(([fv, fl]) => <option key={fv} value={fv}>{fl}</option>)}
                    {safeFields.map((f) => <option key={f.key} value={`custom.${f.key}`}>{f.label}</option>)}
                  </Select>
                ) : (
                  <Input value={v.value} onChange={(e) => setVars({ ...vars, [k]: { type: 'static', value: e.target.value } })} />
                )}
              </div>
            );
          })}
          {nVars > 0 && <p className="text-xs text-slate-500">Internal fields are never available here. Missing values use “there” as a fallback.</p>}

          <Field label="Audience">
            <Select value={audience.type} onChange={(e) => setAudience(e.target.value === 'tags' ? { type: 'tags', tags: [], match: 'any' } : e.target.value === 'filter' ? { type: 'filter', field: 'custom.city', operator: 'equals', value: '' } : { type: e.target.value })}>
              <option value="tags">Contacts with tags</option>
              <option value="filter">Contacts matching a field</option>
              <option value="csv">Paste a list of numbers</option>
              <option value="all">All opted-in contacts</option>
            </Select>
          </Field>
          {audience.type === 'tags' && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {(tags.data?.tags || []).map((t) => {
                  const on = audience.tags.includes(t.tag);
                  return (
                    <button key={t.tag} onClick={() => setAudience({ ...audience, tags: on ? audience.tags.filter((x) => x !== t.tag) : [...audience.tags, t.tag] })} className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 dark:border-slate-600'}`}>
                      {t.tag} ({t.count})
                    </button>
                  );
                })}
              </div>
              <Select className="w-48" value={audience.match} onChange={(e) => setAudience({ ...audience, match: e.target.value })}>
                <option value="any">Has any of these tags</option>
                <option value="all">Has all of these tags</option>
              </Select>
            </div>
          )}
          {audience.type === 'filter' && (
            <div className="grid grid-cols-3 gap-2">
              <Select value={audience.field} onChange={(e) => setAudience({ ...audience, field: e.target.value })}>
                <option value="name">Name</option>
                <option value="email">Email</option>
                {(fields.data?.fields || []).map((f) => <option key={f.key} value={`custom.${f.key}`}>{f.label}</option>)}
              </Select>
              <Select value={audience.operator} onChange={(e) => setAudience({ ...audience, operator: e.target.value })}>
                <option value="equals">equals</option>
                <option value="not_equals">is not</option>
                <option value="contains">contains</option>
              </Select>
              <Input value={audience.value} onChange={(e) => setAudience({ ...audience, value: e.target.value })} />
            </div>
          )}
          {audience.type === 'csv' && <Textarea rows={4} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder="One number per line, or comma separated" />}

          {preview && (
            <div className={`rounded-lg p-3 text-sm ${preview.error ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-slate-50 dark:bg-slate-800'}`}>
              {preview.error ? preview.error : (
                <>
                  <b>{preview.eligible}</b> opted-in contacts will receive it. {preview.no_consent + preview.opted_out > 0 && <span className="text-amber-700 dark:text-amber-300">{preview.no_consent + preview.opted_out} will be skipped (no consent / opted out).</span>}
                  {preview.unknown_numbers > 0 && <span className="text-slate-500"> {preview.unknown_numbers} numbers are not contacts and will be ignored.</span>}
                </>
              )}
            </div>
          )}

          <Field label="When">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-1.5"><input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} /> Send now</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={when === 'later'} onChange={() => setWhen('later')} /> Schedule</label>
              {when === 'later' && <Input type="datetime-local" className="w-56" value={at} onChange={(e) => setAt(e.target.value)} />}
            </div>
          </Field>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-slate-500">Preview</p>
          {tpl ? <TemplatePreview components={tpl.components} values={sampleValues} /> : <p className="text-sm text-slate-400">Choose a template.</p>}
        </div>
      </div>
    </Modal>
  );
}

function Report({ id, onClose }) {
  const toast = useToast();
  const { can } = useAuth();
  const b = useApi(`/broadcasts/${id}`);
  const [status, setStatus] = useState('');
  const rec = useApi(`/broadcasts/${id}/recipients${status ? `?status=${status}` : ''}`);
  useEvents({ 'broadcast.progress': (d) => { if (!d.broadcast_id || d.broadcast_id === id) { b.reload({ silent: true }); rec.reload({ silent: true }); } } });
  const s = b.data?.broadcast?.stats;
  const cancel = async () => {
    if (!window.confirm('Cancel this broadcast? Messages not yet sent will be skipped.')) return;
    try {
      await post(`/broadcasts/${id}/cancel`);
      b.reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return (
    <Modal open wide onClose={onClose} title={b.data?.broadcast?.name || 'Broadcast'} footer={can('broadcasts.manage') && ['scheduled', 'running'].includes(b.data?.broadcast?.status) && <Button variant="danger" onClick={cancel}>Cancel broadcast</Button>}>
      <Async loading={b.loading} error={b.error} onRetry={b.reload}>
        {s && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge color={STATUS[b.data.broadcast.status]}>{b.data.broadcast.status}</Badge>
              <span className="text-slate-500">Template {b.data.broadcast.template_name} · {b.data.broadcast.scheduled_at ? `scheduled ${fmtDateTime(b.data.broadcast.scheduled_at)}` : ''}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
              {[['Recipients', s.total], ['Pending', s.pending], ['Sent', s.sent], ['Delivered', s.delivered], ['Read', s.read], ['Failed', s.failed]].map(([l, v]) => (
                <div key={l} className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800"><div className="text-lg font-semibold tabular-nums">{v}</div><div className="text-xs text-slate-500">{l}</div></div>
              ))}
            </div>
            {s.skipped > 0 && <p className="text-xs text-slate-500">{s.skipped} skipped. {b.data.broadcast.failures.map((f) => `${f.reason}: ${f.count}`).join(' · ')}</p>}
            <div className="flex items-center gap-2">
              <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All recipients</option>
                {['queued', 'sent', 'delivered', 'read', 'failed', 'skipped'].map((x) => <option key={x}>{x}</option>)}
              </Select>
            </div>
            <Async loading={rec.loading} error={rec.error} onRetry={rec.reload} empty={!rec.data?.recipients?.length} emptyProps={{ title: 'No recipients' }}>
              <Table rows={rec.data?.recipients || []} columns={[{ key: 'name', label: 'Contact', render: (r) => <div><div>{r.name || '—'}</div><div className="text-xs text-slate-500">{r.phone}</div></div> }, { key: 'status', label: 'Status', render: (r) => <Badge color={r.status === 'failed' ? 'red' : r.status === 'read' ? 'green' : r.status === 'skipped' ? 'gray' : 'blue'}>{r.status}</Badge> }, { key: 'why', label: 'Detail', render: (r) => <span className="text-xs text-slate-500">{r.error_message || r.skip_reason || ''}</span> }]} />
            </Async>
          </div>
        )}
      </Async>
    </Modal>
  );
}

function BroadcastsInner() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi('/broadcasts');
  const [composing, setComposing] = useState(false);
  const [open, setOpen] = useState(null);
  useEvents({ 'broadcast.progress': () => reload({ silent: true }) });

  return (
    <Page>
      <PageHeader title="Broadcasts" description="Send an approved template to opted-in customers. Contacts without consent are skipped automatically." actions={can('broadcasts.manage') && <Button onClick={() => setComposing(true)}>New broadcast</Button>} />
      {data && !data.sendLive && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">{data.mock ? 'Demo mode: broadcasts are simulated (nobody receives anything).' : 'Send live is OFF: broadcast messages will be held and recipients marked skipped.'}</p>}
      <Card>
        <Async loading={loading} error={error} onRetry={reload} empty={!data?.broadcasts?.length} emptyProps={{ icon: '📣', title: 'No broadcasts yet' }}>
          <Table
            rows={data?.broadcasts || []}
            onRowClick={(b) => setOpen(b.id)}
            columns={[
              { key: 'name', label: 'Broadcast', render: (b) => <div><div className="font-medium">{b.name}</div><div className="text-xs text-slate-500">{b.template_name} · by {b.created_by_name || '—'}</div></div> },
              { key: 'status', label: 'Status', render: (b) => <Badge color={STATUS[b.status]}>{b.status}</Badge> },
              { key: 'when', label: 'When', render: (b) => <span className="text-xs">{fmtDateTime(b.started_at || b.scheduled_at || b.created_at)}</span> },
              { key: 'sent', label: 'Sent', className: 'text-right tabular-nums', render: (b) => b.stats?.sent ?? 0 },
              { key: 'delivered', label: 'Delivered', className: 'text-right tabular-nums', render: (b) => b.stats?.delivered ?? 0 },
              { key: 'read', label: 'Read', className: 'text-right tabular-nums', render: (b) => b.stats?.read ?? 0 },
              { key: 'failed', label: 'Failed', className: 'text-right tabular-nums', render: (b) => b.stats?.failed ?? 0 },
              { key: 'skipped', label: 'Skipped', className: 'text-right tabular-nums', render: (b) => b.stats?.skipped ?? 0 },
            ]}
          />
        </Async>
      </Card>
      {composing && <Composer onClose={() => setComposing(false)} onDone={() => { setComposing(false); reload(); }} />}
      {open && <Report id={open} onClose={() => setOpen(null)} />}
    </Page>
  );
}

export default function BroadcastsPage() {
  return (
    <RequirePermission perm="broadcasts.view">
      <BroadcastsInner />
    </RequirePermission>
  );
}
