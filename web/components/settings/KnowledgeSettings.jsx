'use client';

import { useState } from 'react';
import { del, patch, post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { readFileAsText, timeAgo } from '@/lib/format';
import { Async, Badge, Button, Card, Field, Input, Modal, Select, Textarea, Toggle, useToast } from '@/components/ui';

const TYPES = { business_info: 'Business info', faq: 'FAQ', document: 'Document' };

export default function KnowledgeSettings() {
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = can('ai.manage');
  const [filter, setFilter] = useState('');
  const { data, error, loading, reload } = useApi(`/knowledge${filter ? `?type=${filter}` : ''}`);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const body = { type: editing.type, title: editing.title, content: editing.content, tags: editing.tags || [], is_active: editing.is_active !== false };
      if (editing.id) await patch(`/knowledge/${editing.id}`, body);
      else await post('/knowledge', body);
      toast('Knowledge saved');
      setEditing(null);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file) => {
    if (!file) return;
    if (!/\.(txt|md|csv|json)$/i.test(file.name)) {
      toast('Upload a .txt, .md, .csv or .json file (paste PDF text into a Document item instead)', 'error');
      return;
    }
    const text = await readFileAsText(file);
    setEditing({ type: 'document', title: file.name.replace(/\.[^.]+$/, ''), content: text.slice(0, 200_000), source_file: file.name });
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete “${item.title}”?`)) return;
    try {
      await del(`/knowledge/${item.id}`);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const items = data?.items || [];

  return (
    <Card
      title="Knowledge base"
      actions={
        canEdit && (
          <>
            <label className="cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 ring-slate-300 hover:bg-slate-50 dark:ring-slate-700 dark:hover:bg-slate-800">
              Upload document
              <input type="file" className="hidden" accept=".txt,.md,.csv,.json" onChange={(e) => upload(e.target.files?.[0])} />
            </label>
            <Button size="sm" onClick={() => setEditing({ type: 'faq', title: '', content: '' })}>
              Add item
            </Button>
          </>
        )
      }
    >
      <p className="mb-3 text-xs text-slate-500">The AI answers ONLY from these items, the business profile and the customer&apos;s non-internal fields. Anything else goes to the team as a ticket.</p>
      <div className="mb-3 max-w-xs">
        <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All types</option>
          {Object.entries(TYPES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      <Async loading={loading} error={error} onRetry={reload} empty={!items.length} emptyProps={{ icon: '📚', title: 'No knowledge yet', description: 'Add FAQs, policies and product info so the AI can answer customers.' }}>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((k) => (
            <li key={k.id} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{k.title}</span>
                  <Badge color={k.type === 'faq' ? 'blue' : k.type === 'document' ? 'purple' : 'green'}>{TYPES[k.type]}</Badge>
                  {!k.is_active && <Badge>inactive</Badge>}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-slate-500">{k.content}</p>
                <p className="mt-1 text-xs text-slate-400">Updated {timeAgo(k.updated_at)}</p>
              </div>
              {canEdit && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(k)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(k)}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Async>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit knowledge' : 'New knowledge'}
        wide
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving} disabled={!editing?.title || !editing?.content}>
              Save
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label="Type">
              <Select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
                {Object.entries(TYPES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={editing.type === 'faq' ? 'Question' : 'Title'}>
              <Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </Field>
            <Field label={editing.type === 'faq' ? 'Answer' : 'Content'}>
              <Textarea rows={10} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
            </Field>
            <Toggle checked={editing.is_active !== false} onChange={(v) => setEditing({ ...editing, is_active: v })} label="Active" />
          </div>
        )}
      </Modal>
    </Card>
  );
}
