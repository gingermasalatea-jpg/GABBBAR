'use client';

import { useState } from 'react';
import { api, del, post, put } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import Link from 'next/link';
import { Page, RequirePermission } from '@/components/Shell';
import { Async, Badge, Button, Card, Field, Input, ListEditor, Modal, PageHeader, Select, Textarea, Toggle, useToast } from '@/components/ui';

const TYPE_LABEL = { keyword: 'Keyword reply', welcome: 'Welcome message', out_of_hours: 'Out-of-hours reply', flow: 'Flow' };
const NODE_TYPES = [
  ['message', '💬 Send message'],
  ['buttons', '🔘 Buttons (wait for reply)'],
  ['list', '📋 List menu (wait for reply)'],
  ['condition', '❓ Condition'],
  ['assign', '👤 Assign to agent'],
  ['tag', '🏷️ Add / remove tags'],
  ['webhook', '🔗 Call webhook'],
  ['handoff', '🤝 Hand off to AI / human'],
];

function defaultNode(type, key) {
  const cfg = {
    message: { text: '' },
    buttons: { text: '', buttons: [{ id: 'opt1', title: 'Option 1' }] },
    list: { text: '', button: 'Choose', sections: [{ title: 'Options', rows: [{ id: 'row1', title: 'Option 1' }] }] },
    condition: { field: 'tags', operator: 'equals', value: '' },
    assign: { strategy: 'round_robin' },
    tag: { add: [], remove: [] },
    webhook: { url: '' },
    handoff: { to: 'human', message: '' },
  }[type];
  return { node_key: key, type, config: cfg, next: {} };
}

function NextSelect({ value, keys, onChange, label }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 truncate text-slate-500">{label} →</span>
      <Select className="py-1 text-xs" value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">(end)</option>
        {keys.map((k) => <option key={k} value={k}>{k}</option>)}
      </Select>
    </label>
  );
}

function NodeEditor({ node, keys, fields, users, onChange, onRemove, isStart }) {
  const c = node.config;
  const setCfg = (patch) => onChange({ ...node, config: { ...c, ...patch } });
  const setNext = (k, v) => onChange({ ...node, next: { ...node.next, [k]: v } });
  const others = keys.filter((k) => k !== node.node_key);
  const listRows = (c.sections || []).flatMap((s) => s.rows || []);
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <div className="mb-2 flex items-center gap-2">
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">{node.node_key}</code>
        <span className="text-sm font-medium">{NODE_TYPES.find((t) => t[0] === node.type)?.[1]}</span>
        {isStart && <Badge color="green">start</Badge>}
        <button onClick={onRemove} className="ml-auto text-xs text-slate-400 hover:text-red-600">Remove</button>
      </div>
      <div className="space-y-2">
        {['message', 'buttons', 'list'].includes(node.type) && (
          <Textarea rows={2} value={c.text} onChange={(e) => setCfg({ text: e.target.value })} placeholder="Message text — use {{first_name}} or {{custom.city}}" />
        )}
        {node.type === 'buttons' && (
          <div className="space-y-1.5">
            {(c.buttons || []).map((b, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="w-40 py-1 text-xs" maxLength={20} value={b.title} placeholder="Button title" onChange={(e) => setCfg({ buttons: c.buttons.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
                <Input className="w-28 py-1 text-xs" value={b.id} placeholder="id" onChange={(e) => setCfg({ buttons: c.buttons.map((x, j) => (j === i ? { ...x, id: e.target.value.replace(/[^\w-]/g, '') } : x)) })} />
                <div className="flex-1"><NextSelect label={b.title || b.id} value={node.next[b.id]} keys={others} onChange={(v) => setNext(b.id, v)} /></div>
                <button className="text-xs text-slate-400" onClick={() => setCfg({ buttons: c.buttons.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            {(c.buttons || []).length < 3 && <Button size="sm" variant="ghost" onClick={() => setCfg({ buttons: [...(c.buttons || []), { id: `opt${(c.buttons || []).length + 1}`, title: '' }] })}>+ Button</Button>}
            <NextSelect label="Anything else" value={node.next.default} keys={others} onChange={(v) => setNext('default', v)} />
          </div>
        )}
        {node.type === 'list' && (
          <div className="space-y-1.5">
            <Input className="w-40 py-1 text-xs" maxLength={20} value={c.button} placeholder="Menu button text" onChange={(e) => setCfg({ button: e.target.value })} />
            {listRows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="w-40 py-1 text-xs" maxLength={24} value={r.title} placeholder="Row title" onChange={(e) => setCfg({ sections: [{ title: c.sections[0].title, rows: listRows.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) }] })} />
                <Input className="w-28 py-1 text-xs" value={r.id} onChange={(e) => setCfg({ sections: [{ title: c.sections[0].title, rows: listRows.map((x, j) => (j === i ? { ...x, id: e.target.value.replace(/[^\w-]/g, '') } : x)) }] })} />
                <div className="flex-1"><NextSelect label={r.title || r.id} value={node.next[r.id]} keys={others} onChange={(v) => setNext(r.id, v)} /></div>
              </div>
            ))}
            {listRows.length < 10 && <Button size="sm" variant="ghost" onClick={() => setCfg({ sections: [{ title: c.sections?.[0]?.title || 'Options', rows: [...listRows, { id: `row${listRows.length + 1}`, title: '' }] }] })}>+ Row</Button>}
            <NextSelect label="Anything else" value={node.next.default} keys={others} onChange={(v) => setNext('default', v)} />
          </div>
        )}
        {node.type === 'condition' && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Select className="py-1 text-xs" value={c.field} onChange={(e) => setCfg({ field: e.target.value })}>
                <option value="tags">Tags</option>
                <option value="name">Name</option>
                <option value="email">Email</option>
                <option value="last_message">Customer&apos;s message</option>
                {fields.map((f) => <option key={f.key} value={`custom.${f.key}`}>{f.label}{f.internal ? ' 🔒' : ''}</option>)}
              </Select>
              <Select className="py-1 text-xs" value={c.operator} onChange={(e) => setCfg({ operator: e.target.value })}>
                {['equals', 'not_equals', 'contains', 'in', 'exists', 'not_exists', 'gt', 'lt'].map((o) => <option key={o}>{o}</option>)}
              </Select>
              {!['exists', 'not_exists'].includes(c.operator) && <Input className="py-1 text-xs" value={c.value || ''} onChange={(e) => setCfg({ value: e.target.value })} />}
            </div>
            <NextSelect label="If true" value={node.next.true} keys={others} onChange={(v) => setNext('true', v)} />
            <NextSelect label="If false" value={node.next.false} keys={others} onChange={(v) => setNext('false', v)} />
          </>
        )}
        {node.type === 'assign' && (
          <div className="flex gap-2">
            <Select className="py-1 text-xs" value={c.strategy} onChange={(e) => setCfg({ strategy: e.target.value })}>
              <option value="round_robin">Round robin (least busy)</option>
              <option value="user">Specific person</option>
            </Select>
            {c.strategy === 'user' && (
              <Select className="py-1 text-xs" value={c.user_id || ''} onChange={(e) => setCfg({ user_id: e.target.value })}>
                <option value="">Choose…</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            )}
          </div>
        )}
        {node.type === 'tag' && (
          <div className="grid gap-2 md:grid-cols-2">
            <Field label="Add tags"><ListEditor value={c.add || []} onChange={(v) => setCfg({ add: v })} /></Field>
            <Field label="Remove tags"><ListEditor value={c.remove || []} onChange={(v) => setCfg({ remove: v })} /></Field>
          </div>
        )}
        {node.type === 'webhook' && <Input className="py-1 text-xs" value={c.url} placeholder="https://… (receives contact + message as JSON)" onChange={(e) => setCfg({ url: e.target.value })} />}
        {node.type === 'handoff' && (
          <div className="grid gap-2 md:grid-cols-2">
            <Select className="py-1 text-xs" value={c.to} onChange={(e) => setCfg({ to: e.target.value })}>
              <option value="human">Human agent (pauses AI)</option>
              <option value="ai">AI assistant</option>
            </Select>
            <Input className="py-1 text-xs" value={c.message || ''} placeholder="Optional message before handing off" onChange={(e) => setCfg({ message: e.target.value })} />
          </div>
        )}
        {['message', 'assign', 'tag', 'webhook'].includes(node.type) && <NextSelect label="Then" value={node.next.default} keys={others} onChange={(v) => setNext('default', v)} />}
      </div>
    </div>
  );
}

function Editor({ initial, onClose, onSaved }) {
  const toast = useToast();
  const fields = useApi('/custom-fields');
  const users = useApi('/users');
  const [a, setA] = useState(initial);
  const [adding, setAdding] = useState('message');
  const [saving, setSaving] = useState(false);
  const keys = (a.nodes || []).map((n) => n.node_key);

  const addNode = () => {
    let i = keys.length + 1;
    while (keys.includes(`step${i}`)) i++;
    const key = keys.length ? `step${i}` : 'start';
    setA({ ...a, nodes: [...(a.nodes || []), defaultNode(adding, key)], flow_start_node: a.flow_start_node || key });
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = { name: a.name, type: a.type, is_active: a.is_active, priority: Number(a.priority) || 100, trigger: a.trigger, response: a.response, flow_start_node: a.flow_start_node, nodes: a.type === 'flow' ? a.nodes : [] };
      if (a.id) await put(`/automations/${a.id}`, body);
      else await post('/automations', body);
      toast('Automation saved');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open wide onClose={onClose} title={a.id ? `Edit: ${a.name}` : `New ${TYPE_LABEL[a.type].toLowerCase()}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={saving}>Save</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Name" className="md:col-span-2"><Input value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} /></Field>
          <Field label="Priority" hint="Lower runs first"><Input type="number" value={a.priority} onChange={(e) => setA({ ...a, priority: e.target.value })} /></Field>
        </div>
        <Toggle checked={a.is_active} onChange={(v) => setA({ ...a, is_active: v })} label="Active" />
        {(a.type === 'keyword' || a.type === 'flow') && (
          <div className="grid gap-3 md:grid-cols-[1fr_12rem]">
            <Field label="Trigger keywords"><ListEditor value={a.trigger.keywords} onChange={(v) => setA({ ...a, trigger: { ...a.trigger, keywords: v } })} /></Field>
            <Field label="Match">
              <Select value={a.trigger.match} onChange={(e) => setA({ ...a, trigger: { ...a.trigger, match: e.target.value } })}>
                <option value="contains">Contains word</option>
                <option value="exact">Exact message</option>
                <option value="starts_with">Starts with</option>
                <option value="regex">Regex</option>
              </Select>
            </Field>
          </div>
        )}
        {a.type !== 'flow' && (
          <Field label="Reply text" hint={a.type === 'out_of_hours' ? 'Leave empty to use the message from Settings → Working hours. Sent at most every 12h per chat, and not when AI auto-reply is on.' : 'Placeholders: {{first_name}}, {{name}}, {{custom.city}} (internal fields are never filled)'}>
            <Textarea rows={4} value={a.response.text || ''} onChange={(e) => setA({ ...a, response: { text: e.target.value } })} />
          </Field>
        )}
        {a.type === 'flow' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Steps</span>
              {keys.length > 0 && (
                <Select className="w-40 py-1 text-xs" value={a.flow_start_node || ''} onChange={(e) => setA({ ...a, flow_start_node: e.target.value })}>
                  {keys.map((k) => <option key={k} value={k}>start at: {k}</option>)}
                </Select>
              )}
              <div className="ml-auto flex gap-2">
                <Select className="w-56 py-1 text-xs" value={adding} onChange={(e) => setAdding(e.target.value)}>
                  {NODE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
                <Button size="sm" variant="secondary" onClick={addNode}>+ Add step</Button>
              </div>
            </div>
            {!keys.length && <p className="rounded-lg bg-slate-50 p-4 text-center text-sm text-slate-500 dark:bg-slate-800">Add the first step — usually a message or buttons.</p>}
            {(a.nodes || []).map((n, i) => (
              <NodeEditor
                key={n.node_key}
                node={n}
                keys={keys}
                fields={fields.data?.fields || []}
                users={(users.data?.users || []).filter((u) => u.is_active && u.role !== 'viewer')}
                isStart={n.node_key === a.flow_start_node}
                onChange={(nn) => setA({ ...a, nodes: a.nodes.map((x, j) => (j === i ? nn : x)) })}
                onRemove={() => setA({ ...a, nodes: a.nodes.filter((_, j) => j !== i) })}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Tester() {
  const toast = useToast();
  const [text, setText] = useState('menu');
  const [res, setRes] = useState(null);
  const run = async () => {
    try {
      setRes((await post('/automations/test', { text })).result);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return (
    <Card title="Try a message" actions={<Button size="sm" onClick={run}>Test</Button>}>
      <div className="flex gap-2"><Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} /></div>
      {res && (
        <p className="mt-2 text-sm">
          {res.route === 'ai' ? (
            <>No keyword matched → goes to the <b>AI assistant</b>{res.outOfHours ? ' (and out-of-hours reply applies now)' : ''}.</>
          ) : (
            <>Handled by <b>{res.automation}</b> ({res.route}){res.reply ? `: “${res.reply}”` : ''}{res.actions ? ` — ${res.actions.map((x) => x.type).join(' → ')}${res.waiting ? ' (waits for reply)' : ''}` : ''}</>
          )}
        </p>
      )}
    </Card>
  );
}

function AutomationsInner() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi('/automations');
  const [editing, setEditing] = useState(null);
  const canEdit = can('automations.manage');

  const open = async (a) => {
    try {
      setEditing((await api(`/automations/${a.id}`)).automation);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const toggle = async (a) => {
    try {
      const full = (await api(`/automations/${a.id}`)).automation;
      await put(`/automations/${a.id}`, { ...full, is_active: !a.is_active });
      reload({ silent: true });
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const remove = async (a) => {
    if (!window.confirm(`Delete “${a.name}”?`)) return;
    await del(`/automations/${a.id}`).catch((e) => toast(e.message, 'error'));
    reload();
  };
  const create = (type) => setEditing({ name: '', type, is_active: true, priority: 100, trigger: { keywords: [], match: 'contains' }, response: { text: '' }, nodes: [], flow_start_node: null });
  const list = data?.automations || [];
  const has = (t) => list.some((a) => a.type === t);

  return (
    <Page>
      <PageHeader
        title="Automations"
        description="Order: running flow → keyword replies & flows → welcome / out-of-hours → AI assistant. A human takeover pauses everything for that chat."
        actions={
          canEdit && (
            <>
              {!has('welcome') && <Button variant="secondary" onClick={() => create('welcome')}>+ Welcome</Button>}
              {!has('out_of_hours') && <Button variant="secondary" onClick={() => create('out_of_hours')}>+ Out of hours</Button>}
              <Button variant="secondary" onClick={() => create('keyword')}>+ Keyword reply</Button>
              <Button onClick={() => create('flow')}>+ Flow</Button>
            </>
          )
        }
      />
      <div className="mb-5"><Tester /></div>
      <Card>
        <Async loading={loading} error={error} onRetry={reload} empty={!list.length} emptyProps={{ icon: '⚡', title: 'No automations yet' }}>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {list.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
                <Toggle checked={a.is_active} disabled={!canEdit} onChange={() => toggle(a)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.name}</span>
                    <Badge color={a.type === 'flow' ? 'purple' : a.type === 'keyword' ? 'blue' : 'green'}>{TYPE_LABEL[a.type]}</Badge>
                    {a.type === 'flow' && <span className="text-xs text-slate-500">{a.steps} steps</span>}
                  </div>
                  <p className="truncate text-xs text-slate-500">
                    {a.trigger?.keywords?.length ? `When: ${a.trigger.match} “${a.trigger.keywords.join('”, “')}”` : a.type === 'out_of_hours' ? <>Uses <Link href="/settings?tab=hours" className="underline">working hours</Link></> : a.type === 'welcome' ? 'First message from a new contact' : ''}
                    {a.response?.text ? ` — ${a.response.text}` : ''}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => open(a)}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(a)}>Delete</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Async>
      </Card>
      {editing && <Editor initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </Page>
  );
}

export default function AutomationsPage() {
  return (
    <RequirePermission perm="automations.view">
      <AutomationsInner />
    </RequirePermission>
  );
}
