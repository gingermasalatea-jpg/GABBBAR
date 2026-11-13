'use client';

import { useState } from 'react';
import Link from 'next/link';
import { post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { Page, RequirePermission } from '@/components/Shell';
import { Async, Badge, Button, Card, Modal, PageHeader, Pagination, Select, Table, Textarea, useToast } from '@/components/ui';

const DECISION_COLOR = { sent: 'green', suggested: 'blue', fallback: 'amber', blocked: 'red', error: 'red', held: 'purple', skipped: 'gray' };

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value ?? '—'}</div>
      {hint && <div className="text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

function Playground() {
  const toast = useToast();
  const [q, setQ] = useState('Mera order kab tak aayega?');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const run = async () => {
    setBusy(true);
    try {
      setRes((await post('/ai/test', { question: q })).result);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Test the assistant" actions={<Button size="sm" onClick={run} loading={busy} disabled={!q.trim()}>Ask</Button>}>
      <p className="mb-2 text-xs text-slate-500">Nothing is sent to anyone. Try English, Hindi or Hinglish — and questions that are NOT in your knowledge base.</p>
      <Textarea rows={2} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), run())} />
      {res && (
        <div className="mt-3 space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={res.ok ? 'green' : 'amber'}>{res.ok ? 'Would reply' : res.decision === 'blocked' ? 'Blocked by guardrails' : res.decision === 'error' ? 'Error' : 'Fallback → ticket'}</Badge>
            <Badge>{res.language}</Badge>
            <span className="text-xs text-slate-500">{res.provider} · {res.model}</span>
          </div>
          {res.reply && <div className="bubble-out inline-block max-w-xl rounded-lg px-3 py-2">{res.reply}</div>}
          {!res.ok && <p className="text-xs text-amber-700 dark:text-amber-300">{res.reason}</p>}
          {res.knowledge?.length > 0 && <p className="text-xs text-slate-500">Knowledge used: {res.knowledge.join(' · ')}</p>}
          {res.flags?.length > 0 && !res.ok && <p className="text-xs text-slate-500">Flags: {res.flags.join(', ')}</p>}
        </div>
      )}
    </Card>
  );
}

function LogDetail({ id, onClose }) {
  const { data, error, loading, reload } = useApi(`/ai/logs/${id}`);
  const log = data?.log;
  return (
    <Modal open wide onClose={onClose} title="AI reply log">
      <Async loading={loading} error={error} onRetry={reload}>
        {log && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge color={DECISION_COLOR[log.decision]}>{log.decision}</Badge>
              <Badge>{log.mode}</Badge>
              <Badge>{log.provider} · {log.model}</Badge>
              {log.latency_ms != null && <Badge>{log.latency_ms} ms</Badge>}
              {log.tokens_in != null && <Badge>{log.tokens_in}→{log.tokens_out} tokens</Badge>}
              <span className="text-xs text-slate-500">{fmtDateTime(log.created_at)}</span>
            </div>
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Input</h4>
              <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800">{JSON.stringify(log.input, null, 2)}</pre>
            </section>
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Knowledge used</h4>
              <p>{log.knowledge_titles?.length ? log.knowledge_titles.join(' · ') : '—'}</p>
            </section>
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Output</h4>
              <p className="whitespace-pre-wrap">{log.output || '—'}</p>
              {log.guardrail_flags?.length > 0 && <p className="mt-1 text-xs text-red-600">Guardrail flags: {log.guardrail_flags.join(', ')}</p>}
              {log.error && <p className="mt-1 text-xs text-red-600">Error: {log.error}</p>}
            </section>
            {log.raw_output && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase text-slate-500">Raw model output</summary>
                <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800">{log.raw_output}</pre>
              </details>
            )}
            {log.prompt && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase text-slate-500">Full prompt</summary>
                <pre className="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800">{log.prompt}</pre>
              </details>
            )}
            {log.conversation_id && <Link href={`/inbox?c=${log.conversation_id}`} className="text-sm text-brand-700 underline">Open conversation →</Link>}
          </div>
        )}
      </Async>
    </Modal>
  );
}

function AiInner() {
  const { can, status } = useAuth();
  const [decision, setDecision] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useApi(`/ai/logs?page=${page}&limit=30${decision ? `&decision=${decision}` : ''}`);
  const [open, setOpen] = useState(null);
  const s = data?.stats || {};

  return (
    <Page>
      <PageHeader
        title="AI assistant"
        description="Answers only from your knowledge base. Every reply is logged with its input, the knowledge it used, and the decision."
        actions={can('ai.manage') && <Link href="/settings?tab=ai"><Button variant="secondary">AI settings</Button></Link>}
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Mode" value={<span className="capitalize">{status?.aiMode || '—'}</span>} hint={status?.mock?.ai ? 'mock provider' : status?.aiProvider} />
        <Stat label="Auto-replies (7d)" value={s.sent} />
        <Stat label="Suggestions (7d)" value={s.suggested} />
        <Stat label="Handed to team (7d)" value={s.fallback} />
        <Stat label="Avg latency" value={s.avg_latency != null ? `${s.avg_latency} ms` : '—'} />
      </div>
      {can('ai.manage') && <div className="mb-5"><Playground /></div>}
      <Card title="Reply log" actions={<Button size="sm" variant="secondary" onClick={() => reload()}>Refresh</Button>}>
        <div className="mb-3 max-w-xs">
          <Select value={decision} onChange={(e) => { setDecision(e.target.value); setPage(1); }}>
            <option value="">All decisions</option>
            {Object.keys(DECISION_COLOR).map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        </div>
        <Async loading={loading} error={error} onRetry={reload} empty={!data?.rows?.length} emptyProps={{ icon: '🤖', title: 'No AI activity yet', description: 'Turn on Suggest or Auto-reply and messages will appear here.' }}>
          <Table
            rows={data?.rows || []}
            onRowClick={(r) => setOpen(r.id)}
            columns={[
              { key: 'created_at', label: 'When', render: (r) => <span className="whitespace-nowrap text-xs">{fmtDateTime(r.created_at)}</span> },
              { key: 'contact', label: 'Customer', render: (r) => <span className="text-xs">{r.contact_name || r.contact_phone || (r.mode === 'test' ? 'Playground' : '—')}</span> },
              { key: 'q', label: 'Question', render: (r) => <span className="line-clamp-2 max-w-xs text-xs">{r.customer_message}</span> },
              { key: 'out', label: 'Reply', render: (r) => <span className="line-clamp-2 max-w-xs text-xs text-slate-600 dark:text-slate-300">{r.output || r.error || '—'}</span> },
              { key: 'k', label: 'Knowledge', render: (r) => <span className="line-clamp-2 max-w-[12rem] text-xs text-slate-500">{r.knowledge_titles?.join(', ')}</span> },
              { key: 'decision', label: 'Decision', render: (r) => <div className="space-y-1"><Badge color={DECISION_COLOR[r.decision]}>{r.decision}</Badge>{r.guardrail_flags?.length > 0 && <div className="text-[10px] text-slate-400">{r.guardrail_flags.join(', ')}</div>}</div> },
            ]}
          />
          <Pagination page={page} limit={30} total={data?.total} onPage={setPage} />
        </Async>
      </Card>
      {open && <LogDetail id={open} onClose={() => setOpen(null)} />}
    </Page>
  );
}

export default function AiPage() {
  return (
    <RequirePermission perm="ai.view_logs">
      <AiInner />
    </RequirePermission>
  );
}

