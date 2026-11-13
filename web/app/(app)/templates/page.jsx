'use client';

import { useMemo, useState } from 'react';
import { del, patch, post } from '@/lib/api';
import { useApi, useEvents } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { Page, RequirePermission } from '@/components/Shell';
import TemplatePreview from '@/components/TemplatePreview';
import { Async, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Textarea, useToast } from '@/components/ui';

const STATUS_COLOR = { APPROVED: 'green', PENDING: 'amber', REJECTED: 'red', DRAFT: 'gray', PAUSED: 'amber', DISABLED: 'red', IN_APPEAL: 'blue' };

const LANGUAGES = [
  ['en', 'English'],
  ['en_US', 'English (US)'],
  ['hi', 'Hindi'],
  ['gu', 'Gujarati'],
  ['mr', 'Marathi'],
  ['ta', 'Tamil'],
  ['te', 'Telugu'],
  ['bn', 'Bengali'],
  ['kn', 'Kannada'],
  ['ml', 'Malayalam'],
  ['pa', 'Punjabi'],
];

function emptyDraft() {
  return { name: '', category: 'UTILITY', language: 'en', headerFormat: 'NONE', headerText: '', body: '', examples: [], footer: '', buttons: [] };
}

function toComponents(d) {
  const comps = [];
  if (d.headerFormat !== 'NONE') comps.push(d.headerFormat === 'TEXT' ? { type: 'HEADER', format: 'TEXT', text: d.headerText } : { type: 'HEADER', format: d.headerFormat });
  const nVars = [...d.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].length;
  comps.push({ type: 'BODY', text: d.body, ...(nVars ? { example: { body_text: [Array.from({ length: nVars }, (_, i) => d.examples[i] || '')] } } : {}) });
  if (d.footer.trim()) comps.push({ type: 'FOOTER', text: d.footer.trim() });
  if (d.buttons.length) comps.push({ type: 'BUTTONS', buttons: d.buttons.map((b) => (b.type === 'URL' ? { type: 'URL', text: b.text, url: b.url } : b.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number } : { type: 'QUICK_REPLY', text: b.text })) });
  return comps;
}

function fromTemplate(t) {
  const h = t.components.find((c) => c.type === 'HEADER');
  const b = t.components.find((c) => c.type === 'BODY');
  const f = t.components.find((c) => c.type === 'FOOTER');
  const bt = t.components.find((c) => c.type === 'BUTTONS');
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    language: t.language,
    headerFormat: h ? h.format : 'NONE',
    headerText: h?.text || '',
    body: b?.text || '',
    examples: b?.example?.body_text?.[0] || [],
    footer: f?.text || '',
    buttons: bt?.buttons || [],
  };
}

function TemplateEditor({ initial, onClose, onSaved }) {
  const toast = useToast();
  const [d, setD] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const nVars = useMemo(() => [...d.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].length, [d.body]);
  const components = toComponents(d);

  const save = async (submit) => {
    setSaving(true);
    try {
      let t;
      if (d.id) t = (await patch(`/templates/${d.id}`, { category: d.category, components })).template;
      else t = (await post('/templates', { name: d.name, language: d.language, category: d.category, components })).template;
      if (submit) await post(`/templates/${t.id}/submit`);
      toast(submit ? 'Submitted to Meta for review' : 'Draft saved');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={d.id ? `Edit ${d.name}` : 'New template'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" onClick={() => save(false)} loading={saving}>Save draft</Button>
          <Button onClick={() => save(true)} loading={saving}>Save &amp; submit to Meta</Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Name" hint="lowercase_with_underscores" className="md:col-span-3">
              <Input value={d.name} disabled={Boolean(d.id)} onChange={(e) => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
            </Field>
            <Field label="Category">
              <Select value={d.category} onChange={(e) => set('category', e.target.value)}>
                <option value="UTILITY">Utility</option>
                <option value="MARKETING">Marketing</option>
                <option value="AUTHENTICATION">Authentication</option>
              </Select>
            </Field>
            <Field label="Language">
              <Select value={d.language} disabled={Boolean(d.id)} onChange={(e) => set('language', e.target.value)}>
                {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
            <Field label="Header">
              <Select value={d.headerFormat} onChange={(e) => set('headerFormat', e.target.value)}>
                <option value="NONE">None</option>
                <option value="TEXT">Text</option>
                <option value="IMAGE">Image</option>
                <option value="VIDEO">Video</option>
                <option value="DOCUMENT">Document</option>
              </Select>
            </Field>
          </div>
          {d.headerFormat === 'TEXT' && (
            <Field label="Header text (max 60)"><Input maxLength={60} value={d.headerText} onChange={(e) => set('headerText', e.target.value)} /></Field>
          )}
          <Field label="Body" hint="Use {{1}}, {{2}} … for variables. Must not start or end with a variable.">
            <Textarea rows={5} maxLength={1024} value={d.body} onChange={(e) => set('body', e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => set('body', `${d.body}{{${nVars + 1}}}`)}>+ Add variable</Button>
          </div>
          {nVars > 0 && (
            <div className="grid gap-2 md:grid-cols-2">
              {Array.from({ length: nVars }, (_, i) => (
                <Field key={i} label={`Example for {{${i + 1}}}`}>
                  <Input value={d.examples[i] || ''} onChange={(e) => { const ex = [...d.examples]; ex[i] = e.target.value; set('examples', ex); }} />
                </Field>
              ))}
            </div>
          )}
          <Field label="Footer (optional, max 60)" hint={d.category === 'MARKETING' ? 'Tip: add “Reply STOP to unsubscribe”' : undefined}>
            <Input maxLength={60} value={d.footer} onChange={(e) => set('footer', e.target.value)} />
          </Field>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Buttons</span>
              <Button size="sm" variant="secondary" disabled={d.buttons.length >= 3} onClick={() => set('buttons', [...d.buttons, { type: 'QUICK_REPLY', text: '' }])}>+ Button</Button>
            </div>
            {d.buttons.map((b, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <Select className="w-36" value={b.type} onChange={(e) => set('buttons', d.buttons.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                  <option value="QUICK_REPLY">Quick reply</option>
                  <option value="URL">Website</option>
                  <option value="PHONE_NUMBER">Call</option>
                </Select>
                <Input className="w-40" maxLength={25} placeholder="Button text" value={b.text} onChange={(e) => set('buttons', d.buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                {b.type === 'URL' && <Input className="flex-1" placeholder="https://…" value={b.url || ''} onChange={(e) => set('buttons', d.buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />}
                {b.type === 'PHONE_NUMBER' && <Input className="flex-1" placeholder="+91…" value={b.phone_number || ''} onChange={(e) => set('buttons', d.buttons.map((x, j) => (j === i ? { ...x, phone_number: e.target.value } : x)))} />}
                <Button size="sm" variant="ghost" onClick={() => set('buttons', d.buttons.filter((_, j) => j !== i))}>✕</Button>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-slate-500">Preview</p>
          <TemplatePreview components={components} values={d.examples} />
        </div>
      </div>
    </Modal>
  );
}

function TemplatesInner() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi('/templates');
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState('');
  useEvents({ 'template.updated': () => reload({ silent: true }) });

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await post('/templates/sync');
      toast(r.mock ? 'Mock mode: nothing to sync from Meta' : `Synced ${r.synced} templates from Meta`);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const submit = async (t) => {
    try {
      await post(`/templates/${t.id}/submit`);
      toast('Submitted to Meta');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const remove = async (t) => {
    if (!window.confirm(`Delete template ${t.name}? It will also be deleted from Meta.`)) return;
    try {
      await del(`/templates/${t.id}`);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const rows = (data?.templates || []).filter((t) => !filter || t.status === filter);

  return (
    <Page>
      <PageHeader
        title="Message templates"
        description="Templates must be approved by Meta before use. They are the only way to message customers outside the 24-hour window."
        actions={
          can('templates.manage') && (
            <>
              <Button variant="secondary" onClick={sync} loading={syncing}>Sync from Meta</Button>
              <Button onClick={() => setEditing(emptyDraft())}>New template</Button>
            </>
          )
        }
      />
      <div className="mb-4 max-w-xs">
        <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All statuses</option>
          {['APPROVED', 'PENDING', 'REJECTED', 'DRAFT', 'PAUSED', 'DISABLED'].map((s) => <option key={s}>{s}</option>)}
        </Select>
      </div>
      <Async loading={loading} error={error} onRetry={reload} empty={!rows.length} emptyProps={{ icon: '📝', title: 'No templates', description: 'Create one or sync existing templates from Meta.' }}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((t) => (
            <Card key={t.id} className="flex flex-col">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{t.name}</p>
                  <p className="text-xs text-slate-500">{t.category} · {t.language}{t.quality_score ? ` · quality ${t.quality_score}` : ''}</p>
                </div>
                <Badge color={STATUS_COLOR[t.status] || 'gray'}>{t.status}</Badge>
              </div>
              <p className="line-clamp-4 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{t.components.find((c) => c.type === 'BODY')?.text}</p>
              {t.rejection_reason && <p className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">Rejected: {t.rejection_reason}</p>}
              <p className="mt-2 text-xs text-slate-400">{t.last_synced_at ? `Synced ${timeAgo(t.last_synced_at)}` : `Updated ${timeAgo(t.updated_at)}`}</p>
              <div className="mt-3 flex flex-wrap gap-1 border-t border-slate-100 pt-3 dark:border-slate-800">
                <Button size="sm" variant="ghost" onClick={() => setPreview(t)}>Preview</Button>
                {can('templates.manage') && ['DRAFT', 'REJECTED'].includes(t.status) && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(fromTemplate(t))}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => submit(t)}>Submit</Button>
                  </>
                )}
                {can('templates.manage') && <Button size="sm" variant="ghost" onClick={() => remove(t)}>Delete</Button>}
              </div>
            </Card>
          ))}
        </div>
      </Async>
      {editing && <TemplateEditor initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {preview && (
        <Modal open onClose={() => setPreview(null)} title={preview.name}>
          <TemplatePreview components={preview.components} values={preview.components.find((c) => c.type === 'BODY')?.example?.body_text?.[0] || []} />
        </Modal>
      )}
    </Page>
  );
}

export default function TemplatesPage() {
  return (
    <RequirePermission perm="templates.view">
      <TemplatesInner />
    </RequirePermission>
  );
}
