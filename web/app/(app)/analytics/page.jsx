'use client';

import { useState } from 'react';
import { useApi } from '@/lib/hooks';
import { fmtDuration } from '@/lib/format';
import { Page, RequirePermission } from '@/components/Shell';
import { Async, Card, PageHeader, Select, Table } from '@/components/ui';

/** Single-series vertical bars with hover tooltips (one hue, thin rounded marks, recessive axis). */
function BarChart({ data, valueKey, label, height = 160 }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...data.map((d) => d[valueKey]));
  const w = 100 / data.length;
  return (
    <div className="relative">
      <svg viewBox={`0 0 100 ${height / 4}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={label}>
        <line x1="0" y1={height / 4} x2="100" y2={height / 4} stroke="currentColor" strokeOpacity="0.15" strokeWidth="0.3" />
        {data.map((d, i) => {
          const h = (d[valueKey] / max) * (height / 4 - 2);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={i * w} y="0" width={w} height={height / 4} fill="transparent" />
              <rect x={i * w + w * 0.18} y={height / 4 - h} width={w * 0.64} height={Math.max(h, d[valueKey] ? 0.4 : 0)} rx="0.6" className={hover === i ? 'fill-brand-700' : 'fill-brand-500'} />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{data[0]?.day.slice(5)}</span>
        <span>{data[data.length - 1]?.day.slice(5)}</span>
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute -top-2 rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow" style={{ left: `${Math.min(80, (hover / data.length) * 100)}%` }}>
          {data[hover].day}: <b>{data[hover][valueKey]}</b> {label.toLowerCase()}
        </div>
      )}
    </div>
  );
}

/** Horizontal magnitude bars with direct value labels. */
function HBars({ rows, labelKey, valueKey, format = (v) => v }) {
  const max = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r[labelKey]} className="grid grid-cols-[7rem_1fr_3.5rem] items-center gap-2 text-sm" title={`${r[labelKey]}: ${format(r[valueKey])}`}>
          <span className="truncate capitalize text-slate-600 dark:text-slate-300">{r[labelKey]}</span>
          <span className="h-2.5 rounded-full bg-slate-100 dark:bg-slate-800">
            <span className="block h-2.5 rounded-full bg-brand-500" style={{ width: `${((r[valueKey] || 0) / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums">{format(r[valueKey])}</span>
        </li>
      ))}
    </ul>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

const SENDER = { ai: 'AI assistant', agent: 'Agents', automation: 'Automations', broadcast: 'Broadcasts', api: 'API', system: 'System' };

function AnalyticsInner() {
  const [days, setDays] = useState(30);
  const { data, error, loading, reload } = useApi(`/analytics/overview?days=${days}`);
  const d = data;
  const totalOut = d?.share?.reduce((s, x) => s + x.count, 0) || 0;
  const replies = d?.share?.filter((x) => x.sender_type === 'ai' || x.sender_type === 'agent') || [];
  const replyTotal = replies.reduce((s, x) => s + x.count, 0);
  const aiShare = replyTotal ? Math.round(((replies.find((x) => x.sender_type === 'ai')?.count || 0) / replyTotal) * 100) : 0;

  return (
    <Page>
      <PageHeader
        title="Analytics"
        description={d ? `Timezone: ${d.timezone}` : undefined}
        actions={
          <Select className="w-36" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </Select>
        }
      />
      <Async loading={loading} error={error} onRetry={reload}>
        {d && (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Tile label="Median first response" value={fmtDuration((d.response.median_seconds ?? null) * 1000)} sub={`${d.response.answered}/${d.response.turns} customer turns answered`} />
              <Tile label="Median resolution time" value={fmtDuration((d.resolution.median_seconds ?? null) * 1000)} sub={`${d.resolution.resolved} resolved · ${d.resolution.open_now} open now`} />
              <Tile label="AI share of replies" value={`${aiShare}%`} sub={`AI ${fmtDuration((d.response.ai_avg_seconds ?? null) * 1000)} vs agents ${fmtDuration((d.response.agent_avg_seconds ?? null) * 1000)} avg`} />
              <Tile label="Open tickets" value={d.tickets.open_now} sub={`${d.tickets.from_ai} from AI fallback in period`} />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card title="Conversations per day">
                {d.perDay.some((x) => x.conversations) ? <BarChart data={d.perDay} valueKey="conversations" label="Conversations" /> : <p className="py-10 text-center text-sm text-slate-500">No conversations in this period.</p>}
              </Card>
              <Card title="New contacts per day">
                {d.perDay.some((x) => x.new_contacts) ? <BarChart data={d.perDay} valueKey="new_contacts" label="New contacts" /> : <p className="py-10 text-center text-sm text-slate-500">No new contacts in this period.</p>}
              </Card>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card title="Who sent outgoing messages">
                {totalOut ? <HBars rows={d.share.map((s) => ({ ...s, label: SENDER[s.sender_type] || s.sender_type }))} labelKey="label" valueKey="count" /> : <p className="py-6 text-center text-sm text-slate-500">No outgoing messages.</p>}
                <p className="mt-3 text-xs text-slate-500">AI: {d.ai.auto_replies} auto-replies · {d.ai.suggestions} suggestions · {d.ai.handed_to_team} handed to team · {d.ai.errors} errors</p>
              </Card>
              <Card title="Agent performance">
                {d.agents.length ? (
                  <Table
                    rows={d.agents}
                    columns={[
                      { key: 'name', label: 'Agent' },
                      { key: 'messages_sent', label: 'Messages', className: 'text-right tabular-nums' },
                      { key: 'resolved', label: 'Resolved', className: 'text-right tabular-nums' },
                      { key: 'open_assigned', label: 'Open now', className: 'text-right tabular-nums' },
                      { key: 'frt', label: 'Avg 1st reply', className: 'text-right', render: (a) => fmtDuration(a.avg_first_response_seconds == null ? null : a.avg_first_response_seconds * 1000) },
                    ]}
                  />
                ) : (
                  <p className="py-6 text-center text-sm text-slate-500">No agents yet.</p>
                )}
              </Card>
            </div>

            <Card title="Template performance">
              {d.templates.length ? (
                <Table
                  rowKey="name"
                  rows={d.templates}
                  columns={[
                    { key: 'name', label: 'Template', render: (t) => <code className="text-xs">{t.name}</code> },
                    { key: 'sent', label: 'Sent', className: 'text-right tabular-nums' },
                    { key: 'delivered', label: 'Delivered', className: 'text-right tabular-nums' },
                    { key: 'read', label: 'Read', className: 'text-right tabular-nums' },
                    { key: 'rate', label: 'Read rate', className: 'text-right tabular-nums', render: (t) => (t.sent ? `${Math.round((t.read / t.sent) * 100)}%` : '—') },
                    { key: 'failed', label: 'Failed', className: 'text-right tabular-nums' },
                    { key: 'held', label: 'Held', className: 'text-right tabular-nums' },
                  ]}
                />
              ) : (
                <p className="py-6 text-center text-sm text-slate-500">No templates sent in this period.</p>
              )}
            </Card>

            <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
              <summary className="cursor-pointer font-medium">Daily data table</summary>
              <div className="mt-3">
                <Table rowKey="day" rows={[...d.perDay].reverse()} columns={[{ key: 'day', label: 'Day' }, { key: 'conversations', label: 'Conversations' }, { key: 'inbound', label: 'Inbound msgs' }, { key: 'outbound', label: 'Outbound msgs' }, { key: 'new_contacts', label: 'New contacts' }]} />
              </div>
            </details>
          </div>
        )}
      </Async>
    </Page>
  );
}

export default function AnalyticsPage() {
  return (
    <RequirePermission perm="analytics.view">
      <AnalyticsInner />
    </RequirePermission>
  );
}
