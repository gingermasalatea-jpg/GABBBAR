'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, del, patch, post, qs } from '@/lib/api';
import { useApi, useDebounced } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { downloadText, fmtDateTime, readFileAsText, timeAgo } from '@/lib/format';
import { Page, RequirePermission } from '@/components/Shell';
import { Async, Badge, Button, Card, Field, Input, ListEditor, Modal, PageHeader, Pagination, Select, Table, Toggle, useToast } from '@/components/ui';

function parseHeaders(csvText) {
  const first = csvText.replace(/^﻿/, '').split(/\r?\n/)[0] || '';
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of first) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

function guessField(header) {
  const h = header.toLowerCase();
  if (/phone|mobile|whatsapp|number|contact no/.test(h)) return 'phone';
  if (/^name$|full name|customer name/.test(h)) return 'name';
  if (/e-?mail/.test(h)) return 'email';
  if (/tag|group|segment/.test(h)) return 'tags';
  if (/opt.?in|consent|subscribed/.test(h)) return 'opted_in';
  return '';
}

function ContactForm({ initial, fields, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(() => ({ phone: '', name: '', email: '', tags: [], custom: {}, opted_in: false, opt_in_source: '', ...initial }));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const body = { phone: form.phone, name: form.name || null, email: form.email || '', tags: form.tags, custom: form.custom };
      if (form.id) await patch(`/contacts/${form.id}`, body);
      else await post('/contacts', { ...body, opted_in: form.opted_in, opt_in_source: form.opt_in_source || 'manual' });
      toast('Contact saved');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={form.id ? 'Edit contact' : 'New contact'} wide footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={saving}>Save</Button></>}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Phone (WhatsApp)" hint="Stored in E.164, e.g. +919876543210"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="Name"><Input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Tags"><ListEditor value={form.tags || []} onChange={(v) => setForm({ ...form, tags: v })} /></Field>
        {fields.map((f) => (
          <Field key={f.key} label={<span>{f.label} {f.internal && <Badge color="red">internal</Badge>}</span>}>
            {f.type === 'select' ? (
              <Select value={form.custom?.[f.key] ?? ''} onChange={(e) => setForm({ ...form, custom: { ...form.custom, [f.key]: e.target.value || null } })}>
                <option value="">—</option>
                {(f.options || []).map((o) => <option key={o}>{o}</option>)}
              </Select>
            ) : f.type === 'boolean' ? (
              <Toggle checked={Boolean(form.custom?.[f.key])} onChange={(v) => setForm({ ...form, custom: { ...form.custom, [f.key]: v } })} />
            ) : (
              <Input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={form.custom?.[f.key] ?? ''} onChange={(e) => setForm({ ...form, custom: { ...form.custom, [f.key]: e.target.value } })} />
            )}
          </Field>
        ))}
        {!form.id && (
          <div className="space-y-2 md:col-span-2">
            <Toggle checked={form.opted_in} onChange={(v) => setForm({ ...form, opted_in: v })} label="Customer has opted in to WhatsApp messages" description="Only record opt-in you actually collected (form, call, store, website). Required for broadcasts." />
            {form.opted_in && <Input placeholder="Opt-in source, e.g. website_form, in_store, phone_call" value={form.opt_in_source} onChange={(e) => setForm({ ...form, opt_in_source: e.target.value })} />}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ImportModal({ fields, onClose, onDone }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [headers, setHeaders] = useState([]);
  const [mapping, setMapping] = useState({});
  const [consent, setConsent] = useState(false);
  const [tags, setTags] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const onFile = async (file) => {
    if (!file) return;
    const text = await readFileAsText(file);
    const hs = parseHeaders(text);
    setCsv(text);
    setHeaders(hs);
    setMapping(Object.fromEntries(hs.map((h) => [h, guessField(h) || (fields.find((f) => f.label.toLowerCase() === h.toLowerCase()) ? `custom.${fields.find((f) => f.label.toLowerCase() === h.toLowerCase()).key}` : '')])));
  };

  const run = async () => {
    setBusy(true);
    try {
      const r = await post('/contacts/import', { csv, mapping, consent_confirmed: consent, default_tags: tags });
      setResult(r);
      toast(`Imported: ${r.created} new, ${r.updated} updated`);
      onDone();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const targets = [['', 'Ignore'], ['phone', 'Phone'], ['name', 'Name'], ['email', 'Email'], ['tags', 'Tags'], ['opted_in', 'Opted in (yes/no)'], ...fields.map((f) => [`custom.${f.key}`, `${f.label}${f.internal ? ' (internal)' : ''}`])];

  return (
    <Modal open onClose={onClose} title="Import contacts from CSV" wide footer={<><Button variant="secondary" onClick={onClose}>Close</Button>{!result && <Button onClick={run} loading={busy} disabled={!csv || !Object.values(mapping).includes('phone')}>Import</Button>}</>}>
      {result ? (
        <div className="space-y-2 text-sm">
          <p>✅ {result.created} created · {result.updated} updated · {result.skipped} skipped</p>
          {result.errors?.length > 0 && (
            <ul className="max-h-60 overflow-y-auto rounded-lg bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
              {result.errors.slice(0, 200).map((e, i) => <li key={i}>Row {e.row}: {e.error}</li>)}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" />
          {headers.length > 0 && (
            <>
              <p className="text-xs text-slate-500">Map each CSV column (names kept exactly as in your file):</p>
              <div className="grid gap-2 md:grid-cols-2">
                {headers.map((h) => (
                  <div key={h} className="flex items-center gap-2">
                    <span className="w-40 truncate text-sm font-medium" title={h}>{h}</span>
                    <Select value={mapping[h] || ''} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}>
                      {targets.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </Select>
                  </div>
                ))}
              </div>
              <Field label="Add these tags to every imported contact"><ListEditor value={tags} onChange={setTags} /></Field>
              <Toggle checked={consent} onChange={setConsent} label="I confirm these contacts gave consent to receive WhatsApp messages" description="Only then will rows marked “opted in” be saved as opted in (source: csv_import). Without this, contacts are imported as not opted in." />
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function DuplicatesModal({ onClose, onDone }) {
  const toast = useToast();
  const { data, error, loading, reload } = useApi('/contacts/duplicates');
  const [busy, setBusy] = useState(null);
  const merge = async (group, targetId) => {
    setBusy(group.value);
    try {
      await post('/contacts/merge', { target_id: targetId, source_ids: group.contacts.filter((c) => c.id !== targetId).map((c) => c.id) });
      toast('Contacts merged');
      reload();
      onDone();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal open onClose={onClose} title="Duplicate contacts" wide>
      <Async loading={loading} error={error} onRetry={reload} empty={!data?.groups?.length} emptyProps={{ icon: '✨', title: 'No duplicates found', description: 'Contacts with the same email or name appear here.' }}>
        <div className="space-y-4">
          {data?.groups?.map((g) => (
            <div key={`${g.reason}-${g.value}`} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="mb-2 text-xs text-slate-500">Same {g.reason}: <b>{g.value}</b> — choose the contact to keep:</p>
              <ul className="space-y-1.5">
                {g.contacts.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                    <span>{c.name || '—'} · {c.phone} {c.email && `· ${c.email}`}</span>
                    <Button size="sm" variant="secondary" loading={busy === g.value} onClick={() => merge(g, c.id)}>Keep this, merge others</Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Async>
    </Modal>
  );
}

function ContactsInner() {
  const { can } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [optedIn, setOptedIn] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);
  const list = useApi(`/contacts${qs({ search: debounced, tag, opted_in: optedIn, page, limit: 50 })}`);
  const fields = useApi('/custom-fields');
  const tags = useApi('/contacts/tags');
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const [dups, setDups] = useState(false);
  const [detail, setDetail] = useState(null);

  const exportCsv = async () => {
    try {
      const res = await api('/contacts/export', { raw: true });
      downloadText(`contacts-${new Date().toISOString().slice(0, 10)}.csv`, await res.text(), 'text/csv');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const optToggle = async (c) => {
    try {
      if (c.opted_in) await post(`/contacts/${c.id}/opt-out`);
      else {
        const source = window.prompt('How did this customer opt in? (e.g. phone_call, in_store, website_form)');
        if (!source) return;
        await post(`/contacts/${c.id}/opt-in`, { source });
      }
      list.reload({ silent: true });
      if (detail?.id === c.id) setDetail(null);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const remove = async (c) => {
    if (!window.confirm(`Delete ${c.name || c.phone}? Their conversation history will be deleted too.`)) return;
    try {
      await del(`/contacts/${c.id}`);
      setDetail(null);
      list.reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const reloadAll = () => {
    list.reload();
    tags.reload();
  };

  const fieldDefs = fields.data?.fields || [];

  return (
    <Page>
      <PageHeader
        title="Contacts"
        description="Every customer who messages you is added automatically. Phone numbers are unique (E.164)."
        actions={
          <>
            {can('contacts.delete') && <Button variant="secondary" onClick={() => setDups(true)}>Find duplicates</Button>}
            {can('contacts.import') && <Button variant="secondary" onClick={exportCsv}>Export CSV</Button>}
            {can('contacts.import') && <Button variant="secondary" onClick={() => setImporting(true)}>Import CSV</Button>}
            {can('contacts.edit') && <Button onClick={() => setEditing({})}>New contact</Button>}
          </>
        }
      />
      <Card>
        <div className="mb-4 grid gap-2 md:grid-cols-4">
          <Input placeholder="Search name, phone or email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="md:col-span-2" />
          <Select value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }}>
            <option value="">All tags</option>
            {(tags.data?.tags || []).map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}
          </Select>
          <Select value={optedIn} onChange={(e) => { setOptedIn(e.target.value); setPage(1); }}>
            <option value="">Any opt-in status</option>
            <option value="true">Opted in</option>
            <option value="false">Not opted in</option>
          </Select>
        </div>
        <Async loading={list.loading} error={list.error} onRetry={list.reload} empty={!list.data?.rows?.length} emptyProps={{ icon: '👥', title: 'No contacts found', description: search || tag ? 'Try a different search.' : 'Import a CSV or wait for customers to message you.' }}>
          <Table
            rows={list.data?.rows || []}
            onRowClick={setDetail}
            columns={[
              { key: 'name', label: 'Name', render: (c) => <div><div className="font-medium">{c.name || '—'}</div><div className="text-xs text-slate-500">{c.phone}</div></div> },
              { key: 'tags', label: 'Tags', render: (c) => <div className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div> },
              { key: 'opt', label: 'Opt-in', render: (c) => (c.opted_in ? <Badge color="green">Opted in</Badge> : c.opted_out_at ? <Badge color="red">Opted out</Badge> : <Badge color="amber">No consent</Badge>) },
              { key: 'last', label: 'Last message', render: (c) => <span className="text-xs text-slate-500">{c.last_inbound_at ? timeAgo(c.last_inbound_at) : '—'}</span> },
              { key: 'source', label: 'Source', render: (c) => <span className="text-xs text-slate-500">{c.source}</span> },
            ]}
          />
          <Pagination page={page} limit={50} total={list.data?.total} onPage={setPage} />
        </Async>
      </Card>

      {detail && (
        <Modal open onClose={() => setDetail(null)} title={detail.name || detail.phone} wide footer={
          <>
            {can('contacts.delete') && <Button variant="danger" onClick={() => remove(detail)}>Delete</Button>}
            {can('contacts.edit') && <Button variant="secondary" onClick={() => optToggle(detail)}>{detail.opted_in ? 'Mark opted out' : 'Record opt-in'}</Button>}
            {can('contacts.edit') && <Button onClick={() => { setEditing(detail); setDetail(null); }}>Edit</Button>}
          </>
        }>
          <dl className="grid gap-3 text-sm md:grid-cols-2">
            <div><dt className="text-xs text-slate-500">Phone</dt><dd>{detail.phone}</dd></div>
            <div><dt className="text-xs text-slate-500">Email</dt><dd>{detail.email || '—'}</dd></div>
            <div><dt className="text-xs text-slate-500">Opt-in</dt><dd>{detail.opted_in ? `Yes — ${detail.opt_in_source} (${fmtDateTime(detail.opt_in_at)})` : detail.opted_out_at ? `Opted out ${fmtDateTime(detail.opted_out_at)}` : 'No'}</dd></div>
            <div><dt className="text-xs text-slate-500">Created</dt><dd>{fmtDateTime(detail.created_at)} via {detail.source}</dd></div>
            {fieldDefs.map((f) => (
              <div key={f.key}><dt className="text-xs text-slate-500">{f.label} {f.internal && <Badge color="red">internal</Badge>}</dt><dd>{String(detail.custom?.[f.key] ?? '—')}</dd></div>
            ))}
          </dl>
          {can('inbox.view') && <Link href={`/inbox?contact=${detail.id}`} className="mt-4 inline-block text-sm text-brand-700 underline">Open conversation →</Link>}
        </Modal>
      )}
      {editing && <ContactForm initial={editing} fields={fieldDefs} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reloadAll(); }} />}
      {importing && <ImportModal fields={fieldDefs} onClose={() => setImporting(false)} onDone={reloadAll} />}
      {dups && <DuplicatesModal onClose={() => setDups(false)} onDone={reloadAll} />}
    </Page>
  );
}

export default function ContactsPage() {
  return (
    <RequirePermission perm="contacts.view">
      <ContactsInner />
    </RequirePermission>
  );
}
