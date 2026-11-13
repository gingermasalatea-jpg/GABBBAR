'use client';

import { cx, Badge, Input, Select, Spinner, EmptyState, ErrorState } from '@/components/ui';
import { initials, timeAgo } from '@/lib/format';

const FILTERS = [
  ['open', 'Open'],
  ['unread', 'Unread'],
  ['mine', 'Mine'],
  ['unassigned', 'Unassigned'],
  ['ai', 'AI-handled'],
  ['human', 'Human-handled'],
  ['takeover', 'Taken over'],
  ['resolved', 'Resolved'],
  ['all', 'All'],
];

export default function ConversationList({ data, loading, error, reload, filter, setFilter, search, setSearch, label, setLabel, labels, selectedId, onSelect, now, onSimulate }) {
  const rows = data?.rows || [];
  const counts = data?.counts || {};
  return (
    <div className="flex h-full flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="space-y-2 border-b border-slate-200 p-3 dark:border-slate-800">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Inbox</h2>
          {onSimulate && (
            <button onClick={onSimulate} className="rounded-lg px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-500 dark:hover:bg-slate-800" title="Demo mode: simulate a customer message">
              + Simulate customer
            </button>
          )}
        </div>
        <Input placeholder="Search name, number or message" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="scroll-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {FILTERS.map(([v, l]) => (
            <button
              key={v}
              onClick={() => setFilter(v)}
              className={cx(
                'whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium',
                filter === v ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300',
              )}
            >
              {l}
              {counts[v] ? <span className="ml-1 opacity-80">{counts[v]}</span> : null}
            </button>
          ))}
        </div>
        {labels?.length > 0 && (
          <Select value={label} onChange={(e) => setLabel(e.target.value)} className="py-1 text-xs">
            <option value="">All labels</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {loading && !rows.length ? (
          <div className="flex justify-center py-10 text-slate-400">
            <Spinner />
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !rows.length ? (
          <EmptyState icon="💬" title="No conversations" description={filter === 'open' ? 'New WhatsApp messages will appear here.' : 'Nothing matches this filter.'} />
        ) : (
          <ul>
            {rows.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className={cx(
                    'flex w-full gap-3 border-b border-slate-100 px-3 py-3 text-left transition dark:border-slate-800',
                    selectedId === c.id ? 'bg-brand-50 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                  )}
                >
                  <div className="relative">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-200">
                      {initials(c.contact?.name || c.contact?.phone)}
                    </div>
                    {c.window?.open && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-brand-500 dark:border-slate-900" title="24h window open" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cx('truncate text-sm', c.unread_count ? 'font-semibold' : 'font-medium')}>{c.contact?.name || c.contact?.phone}</span>
                      <span className="shrink-0 text-[11px] text-slate-400">{timeAgo(c.last_message_at, now)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-slate-500">{c.last_message_preview || 'No messages yet'}</span>
                      {c.unread_count > 0 && <span className="shrink-0 rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{c.unread_count}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {c.status === 'resolved' && <Badge>resolved</Badge>}
                      {c.human_takeover && <Badge color="purple">human</Badge>}
                      {!c.human_takeover && c.last_handler === 'ai' && <Badge color="blue">AI</Badge>}
                      {c.assigned_name ? <Badge>{c.assigned_name.split(' ')[0]}</Badge> : c.status === 'open' && <Badge color="amber">unassigned</Badge>}
                      {c.labels?.map((l) => (
                        <span key={l.id} className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ background: l.color }}>
                          {l.name}
                        </span>
                      ))}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
