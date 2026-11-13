'use client';

import { useState } from 'react';
import { put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Card, Field, Input, ListEditor, Select, Textarea, useToast } from '@/components/ui';
import { SaveBar, SecretField, useSectionForm } from './common';

const PROVIDERS = [
  { value: 'anthropic', label: 'Claude (Anthropic) — default', key: 'ai.anthropic_key', model: 'claude-sonnet-5-5' },
  { value: 'openai', label: 'OpenAI', key: 'ai.openai_key', model: 'gpt-4.1-mini' },
  { value: 'gemini', label: 'Google Gemini', key: 'ai.gemini_key', model: 'gemini-2.5-flash' },
  { value: 'compatible', label: 'OpenAI-compatible endpoint', key: 'ai.compatible_key', model: '' },
];

export default function AiSettings({ data, reload }) {
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = can('ai.manage');
  const { form, set } = useSectionForm(data.settings.ai);
  const [saving, setSaving] = useState(false);
  const provider = PROVIDERS.find((p) => p.value === form.provider) || PROVIDERS[0];

  const save = async () => {
    setSaving(true);
    try {
      await put('/settings/ai', {
        ...form,
        max_history: Number(form.max_history),
        temperature: Number(form.temperature),
        min_relevance: Number(form.min_relevance),
      });
      toast('AI settings saved');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card title="Mode">
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ['off', 'Off', 'The AI never replies or suggests.'],
            ['suggest', 'Suggest', 'Drafts appear in the inbox; an agent reviews and sends.'],
            ['auto', 'Auto-reply', 'The AI replies on its own (only when Send live is on, and never during a human takeover).'],
          ].map(([v, label, desc]) => (
            <button
              key={v}
              disabled={!canEdit}
              onClick={() => set('mode', v)}
              className={`rounded-xl border p-3 text-left transition ${form.mode === v ? 'border-brand-600 bg-brand-50 dark:bg-brand-800/20' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'}`}
            >
              <div className="text-sm font-semibold">{label}</div>
              <div className="mt-1 text-xs text-slate-500">{desc}</div>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500">Each conversation can override this mode from the inbox. A human takeover always pauses the AI for that chat.</p>
      </Card>

      <Card title="Provider">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Provider">
            <Select
              value={form.provider}
              disabled={!canEdit}
              onChange={(e) => {
                const p = PROVIDERS.find((x) => x.value === e.target.value);
                set('provider', e.target.value);
                if (p?.model) set('model', p.model);
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model" hint="Exact model id from your provider">
            <Input value={form.model || ''} disabled={!canEdit} onChange={(e) => set('model', e.target.value)} />
          </Field>
          {form.provider === 'compatible' && (
            <Field label="Base URL" hint="e.g. https://api.together.xyz/v1 or http://localhost:11434/v1" className="md:col-span-2">
              <Input value={form.base_url || ''} disabled={!canEdit} onChange={(e) => set('base_url', e.target.value)} />
            </Field>
          )}
          <SecretField name={provider.key} label={`${provider.label.split(' —')[0]} API key`} status={data.secrets} canEdit={can('settings.secrets')} onSaved={reload} />
          <div className="grid grid-cols-3 gap-3">
            <Field label="Temperature">
              <Input type="number" step="0.1" min="0" max="1" value={form.temperature} disabled={!canEdit} onChange={(e) => set('temperature', e.target.value)} />
            </Field>
            <Field label="History msgs">
              <Input type="number" min="0" max="30" value={form.max_history} disabled={!canEdit} onChange={(e) => set('max_history', e.target.value)} />
            </Field>
            <Field label="Min relevance" hint="0–1">
              <Input type="number" step="0.01" min="0" max="1" value={form.min_relevance} disabled={!canEdit} onChange={(e) => set('min_relevance', e.target.value)} />
            </Field>
          </div>
        </div>
        {data.mock.ai && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">AI is in mock mode (AI_MOCK=true): replies come from a local knowledge-matching engine, no provider is called.</p>}
      </Card>

      <Card title="Behaviour rules">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Tone of voice" className="md:col-span-2">
            <Textarea value={form.tone || ''} disabled={!canEdit} onChange={(e) => set('tone', e.target.value)} />
          </Field>
          <Field label="Do">
            <ListEditor value={form.dos || []} disabled={!canEdit} onChange={(v) => set('dos', v)} placeholder="Add a rule and press Enter" />
          </Field>
          <Field label="Don't">
            <ListEditor value={form.donts || []} disabled={!canEdit} onChange={(v) => set('donts', v)} placeholder="Add a rule and press Enter" />
          </Field>
          <Field label="Never say (blocked words / phrases)" hint="Any reply containing these is blocked and handed to the team.">
            <ListEditor value={form.never_say || []} disabled={!canEdit} onChange={(v) => set('never_say', v)} />
          </Field>
          <Field label="Languages">
            <ListEditor value={form.languages || []} disabled={!canEdit} onChange={(v) => set('languages', v)} />
          </Field>
          <Field label="Fallback message (sent when the AI cannot answer from knowledge)" className="md:col-span-2" hint="A support ticket is created and the team is notified.">
            <Textarea value={form.fallback_message || ''} disabled={!canEdit} onChange={(e) => set('fallback_message', e.target.value)} />
          </Field>
        </div>
      </Card>
      {canEdit && <SaveBar onSave={save} saving={saving} />}
    </div>
  );
}
