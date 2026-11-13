'use client';

import Link from 'next/link';
import { useState } from 'react';
import { post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, timeAgo } from '@/lib/format';
import { Badge, Button, cx, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';

export default function ContactPanel({ detail, labels, onChanged, onClose }) {
  const { can } = useAuth();
  const toast = useToast();
  const [ticket, setTicket] = useState(null);
  const [saving, setSaving] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  if (!detail) return null;
  const { contact, conversation: conv, fields, tickets } = detail;
  const active = new Set((conv.labels || []).map((l) => l.id));

  const toggleLabel = async (id) => {
    const next = new Set(active);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      await put(`/conversations/${conv.id}/labels`, { label_ids: [...next] });
      onChanged({ silent: true });
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const createLabel = async () => {
    if (!newLabel.trim()) return;
    try {
      const { label } = await post('/labels', { name: newLabel.trim(), color: ['#3b82f6', '#ef4444', '#a855f7', '#f59e0b', '#22c55e', '#0ea5e9'][Math.floor(Math.random() * 6)] });
      setNewLabel('');
      await put(`/conversations/${conv.id}/labels`, { label_ids: [...active, label.id] });
      onChanged();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const saveTicket = async () => {
    setSaving(true);
    try {
      await post('/tickets', { conversation_id: conv.id, subject: ticket.subject, description: ticket.description, priority: ticket.priority });
      toast('Ticket created');
      setTicket(null);
      onChanged({ silent: true });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="scroll-thin h-full overflow-y-auto border-l border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <p className="text-base font-semibold">{contact.name || 'Unknown'}</p>
          <p className="text-slate-500">{contact.phone}</p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 xl:hidden dark:hover:bg-slate-800" aria-label="Close">✕</button>
      </div>

      <div className="mb-4 flex flex-wrap gap-1">
        {contact.opted_in ? <Badge color="green">Opted in · {contact.opt_in_source}</Badge> : contact.opted_out_at ? <Badge color="red">Opted out {timeAgo(contact.opted_out_at)}</Badge> : <Badge color="amber">No marketing consent</Badge>}
        {contact.tags.map((t) => <Badge key={t}>{t}</Badge>)}
      </div>

      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Details</h3>
      <dl className="mb-5 space-y-1.5">
        {contact.email && <div className="flex justify-between gap-2"><dt className="text-slate-500">Email</dt><dd className="truncate">{contact.email}</dd></div>}
        {fields.map((f) => (
          <div key={f.key} className="flex justify-between gap-2">
            <dt className={cx('text-slate-500', f.internal && 'text-red-600 dark:text-red-400')} title={f.internal ? 'Internal — never shown to customers or the AI' : undefined}>
              {f.internal && '🔒 '}{f.label}
            </dt>
            <dd className="truncate text-right">{contact.custom?.[f.key] !== undefined && contact.custom?.[f.key] !== null ? String(contact.custom[f.key]) : '—'}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-2"><dt className="text-slate-500">First contact</dt><dd>{fmtDateTime(contact.created_at)}</dd></div>
      </dl>
      {can('contacts.view') && <Link href="/contacts" className="mb-5 block text-xs text-brand-700 underline">Open in contacts →</Link>}

      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Labels</h3>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {labels.map((l) => (
          <button
            key={l.id}
            disabled={!can('inbox.reply')}
            onClick={() => toggleLabel(l.id)}
            className={cx('rounded-full border px-2 py-0.5 text-xs font-medium transition', active.has(l.id) ? 'border-transparent text-white' : 'border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300')}
            style={active.has(l.id) ? { background: l.color } : undefined}
          >
            {l.name}
          </button>
        ))}
      </div>
      {can('inbox.assign') && (
        <div className="mb-5 flex gap-1">
          <Input className="py-1 text-xs" placeholder="New label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createLabel()} />
          <Button size="sm" variant="secondary" onClick={createLabel}>Add</Button>
        </div>
      )}

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tickets</h3>
        {can('tickets.manage') && <Button size="sm" variant="ghost" onClick={() => setTicket({ subject: '', description: '', priority: 'normal' })}>+ New</Button>}
      </div>
      {tickets.length ? (
        <ul className="space-y-1.5">
          {tickets.map((t) => (
            <li key={t.id} className="rounded-lg border border-slate-200 p-2 dark:border-slate-700">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{t.subject}</span>
                <Badge color={t.status === 'closed' ? 'gray' : t.priority === 'high' || t.priority === 'urgent' ? 'red' : 'amber'}>{t.status.replace('_', ' ')}</Badge>
              </div>
              <p className="text-xs text-slate-500">{t.source === 'ai_fallback' ? '🤖 AI fallback · ' : ''}{timeAgo(t.created_at)}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-slate-400">No tickets.</p>
      )}

      {ticket && (
        <Modal open onClose={() => setTicket(null)} title="New ticket" footer={<><Button variant="secondary" onClick={() => setTicket(null)}>Cancel</Button><Button onClick={saveTicket} loading={saving} disabled={!ticket.subject.trim()}>Create</Button></>}>
          <div className="space-y-3">
            <Field label="Subject"><Input value={ticket.subject} onChange={(e) => setTicket({ ...ticket, subject: e.target.value })} /></Field>
            <Field label="Description"><Textarea value={ticket.description} onChange={(e) => setTicket({ ...ticket, description: e.target.value })} /></Field>
            <Field label="Priority">
              <Select value={ticket.priority} onChange={(e) => setTicket({ ...ticket, priority: e.target.value })}>
                {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p}>{p}</option>)}
              </Select>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
