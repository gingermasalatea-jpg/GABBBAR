'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtTime, readFileAsBase64 } from '@/lib/format';
import { Badge, Button, cx, Field, Input, Modal, Select, Spinner, Textarea, useToast } from '@/components/ui';
import TemplatePreview from '@/components/TemplatePreview';

function Ticks({ status }) {
  if (status === 'queued') return <span title="Queued">🕓</span>;
  if (status === 'held') return <span title="Held — Send live is off">⏸</span>;
  if (status === 'simulated') return <span title="Simulated">◌</span>;
  if (status === 'sent') return <span className="text-slate-500" title="Sent">✓</span>;
  if (status === 'delivered') return <span className="text-slate-500" title="Delivered">✓✓</span>;
  if (status === 'read') return <span className="text-sky-500" title="Read">✓✓</span>;
  if (status === 'failed') return <span className="text-red-500" title="Failed">⚠</span>;
  return null;
}

function WindowTimer({ window: w, now }) {
  if (!w?.expiresAt) return <Badge color="red">No customer message yet — template only</Badge>;
  const ms = new Date(w.expiresAt).getTime() - now;
  if (ms <= 0) return <Badge color="red">24h window closed — template only</Badge>;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return <Badge color={h < 2 ? 'amber' : 'green'}>⏱ {h}h {m}m left to reply</Badge>;
}

function MediaView({ m }) {
  if (!m.media) return null;
  if (m.media.status !== 'stored') return <div className="mb-1 rounded bg-black/5 px-2 py-3 text-xs dark:bg-white/10">{m.media.status === 'failed' ? '⚠ Media could not be downloaded' : '⏳ Downloading media…'}</div>;
  const src = `/api/media/${m.media.id}`;
  if (m.type === 'image' || m.type === 'sticker') return <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="" className="mb-1 max-h-64 rounded-md object-cover" /></a>;
  if (m.type === 'video') return <video src={src} controls className="mb-1 max-h-64 rounded-md" />;
  if (m.type === 'audio') return <audio src={src} controls className="mb-1 w-60" />;
  return (
    <a href={src} className="mb-1 flex items-center gap-2 rounded bg-black/5 px-2 py-2 text-xs underline dark:bg-white/10">
      📎 {m.media.file_name || 'Document'}
    </a>
  );
}

function Bubble({ m, onRetry }) {
  const out = m.direction === 'out';
  const who = out ? (m.sender_type === 'agent' ? m.sender_name || 'Agent' : m.sender_type === 'ai' ? 'AI assistant' : m.sender_type === 'automation' ? 'Automation' : m.sender_type === 'broadcast' ? 'Broadcast' : m.sender_type === 'api' ? 'API' : 'System') : null;
  return (
    <div className={cx('flex', out ? 'justify-end' : 'justify-start')}>
      <div className={cx('max-w-[78%] rounded-lg px-2.5 py-1.5 text-sm shadow-sm', out ? 'bubble-out' : 'bubble-in')}>
        {who && <div className={cx('mb-0.5 text-[11px] font-semibold', m.sender_type === 'ai' ? 'text-sky-700 dark:text-sky-300' : 'text-brand-700 dark:text-brand-200')}>{m.sender_type === 'ai' ? '🤖 ' : ''}{who}</div>}
        {m.template_name && <div className="mb-1 text-[11px] font-medium opacity-70">📄 Template · {m.template_name}</div>}
        <MediaView m={m} />
        {m.type === 'location' && !m.body && <div>📍 Location shared</div>}
        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
        {!m.body && !m.media && !m.template_name && m.type !== 'location' && <p className="italic opacity-60">[{m.type}]</p>}
        {m.payload?.interactive?.title && m.direction === 'in' && <div className="mt-1 text-[11px] opacity-70">↩ tapped “{m.payload.interactive.title}”</div>}
        {m.payload?.api?.interactive?.action?.buttons && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.payload.api.interactive.action.buttons.map((b) => (
              <span key={b.reply.id} className="rounded border border-current px-1.5 py-0.5 text-[11px] opacity-70">{b.reply.title}</span>
            ))}
          </div>
        )}
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] opacity-70">
          {fmtTime(m.created_at)} {out && <Ticks status={m.status} />}
        </div>
        {out && (m.status === 'failed' || m.status === 'held') && (
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-black/10 pt-1 text-[11px] dark:border-white/10">
            <span className={m.status === 'failed' ? 'text-red-600 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}>{m.error_message}</span>
            <button onClick={() => onRetry(m)} className="font-semibold underline">Retry</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Note({ n }) {
  return (
    <div className="flex justify-center">
      <div className="bubble-note max-w-[85%] rounded-lg px-3 py-1.5 text-xs">
        <span className="font-semibold">🔒 Internal note · {n.user_name || 'Team'}:</span> <span className="whitespace-pre-wrap">{n.body}</span>
        <span className="ml-2 opacity-60">{fmtTime(n.created_at)}</span>
      </div>
    </div>
  );
}

function TemplateModal({ conversationId, onClose, onSent }) {
  const toast = useToast();
  const [templates, setTemplates] = useState(null);
  const [selected, setSelected] = useState(null);
  const [values, setValues] = useState([]);
  const [headerValues, setHeaderValues] = useState(['']);
  const [headerLink, setHeaderLink] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api('/templates?status=APPROVED').then((d) => setTemplates(d.templates)).catch((e) => { toast(e.message, 'error'); setTemplates([]); });
  }, [toast]);

  const comps = selected?.components || [];
  const body = comps.find((c) => c.type === 'BODY');
  const header = comps.find((c) => c.type === 'HEADER');
  const nVars = body ? [...String(body.text).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].length : 0;

  const send = async () => {
    setSending(true);
    try {
      await post(`/templates/${selected.id}/send`, {
        conversation_id: conversationId,
        variables: values,
        header_values: header?.format === 'TEXT' && /\{\{1\}\}/.test(header.text || '') ? headerValues : [],
        header_media: header && header.format !== 'TEXT' ? { link: headerLink } : undefined,
      });
      toast('Template queued');
      onSent();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Send a template" wide footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={send} loading={sending} disabled={!selected}>Send template</Button></>}>
      {!templates ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : !templates.length ? (
        <p className="py-6 text-center text-sm text-slate-500">No approved templates yet. Create one under Templates.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <Field label="Template">
              <Select value={selected?.id || ''} onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); setSelected(t); setValues([]); }}>
                <option value="">Choose…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language} · {t.category.toLowerCase()})</option>)}
              </Select>
            </Field>
            {header?.format === 'TEXT' && /\{\{1\}\}/.test(header.text || '') && (
              <Field label="Header {{1}}"><Input value={headerValues[0]} onChange={(e) => setHeaderValues([e.target.value])} /></Field>
            )}
            {header && header.format !== 'TEXT' && (
              <Field label={`${header.format.toLowerCase()} URL (https)`}><Input value={headerLink} onChange={(e) => setHeaderLink(e.target.value)} placeholder="https://…" /></Field>
            )}
            {Array.from({ length: nVars }, (_, i) => (
              <Field key={i} label={`Variable {{${i + 1}}}`}>
                <Input value={values[i] || ''} onChange={(e) => { const v = [...values]; v[i] = e.target.value; setValues(v); }} />
              </Field>
            ))}
          </div>
          {selected && <TemplatePreview components={comps} values={values} headerValues={headerValues} />}
        </div>
      )}
    </Modal>
  );
}

export default function ChatPane({ detail, messages, notes, loading, users, now, onBack, onChanged, aiSuggestion, setAiSuggestion, onToggleContact }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const conv = detail?.conversation;
  const [text, setText] = useState('');
  const [noteMode, setNoteMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const scroller = useRef(null);
  const fileRef = useRef(null);

  const windowOpen = conv?.window?.open && new Date(conv.window.expiresAt).getTime() > now;
  const canReply = can('inbox.reply');

  const timeline = useMemo(() => {
    const items = [...messages.map((m) => ({ kind: 'm', at: m.created_at, m })), ...notes.map((n) => ({ kind: 'n', at: n.created_at, n }))];
    return items.sort((a, b) => new Date(a.at) - new Date(b.at));
  }, [messages, notes]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline.length, conv?.id]);

  useEffect(() => {
    setText('');
    setNoteMode(false);
  }, [conv?.id]);

  useEffect(() => {
    if (aiSuggestion?.conversation_id === conv?.id && aiSuggestion?.text && !text) setText(aiSuggestion.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSuggestion]);

  if (!conv) return null;

  const act = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) toast(okMsg);
      onChanged();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      if (noteMode) await post(`/conversations/${conv.id}/notes`, { body });
      else await post(`/conversations/${conv.id}/messages`, { text: body });
      setText('');
      setAiSuggestion(null);
      onChanged({ silent: true });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSending(false);
    }
  };

  const sendFile = async (file) => {
    if (!file) return;
    if (file.size > 16 * 1024 * 1024 && !file.type.includes('pdf')) return toast('File too large (max 16 MB for media)', 'error');
    setSending(true);
    try {
      const base64 = await readFileAsBase64(file);
      await post(`/conversations/${conv.id}/messages`, { media: { base64, mime_type: file.type || 'application/octet-stream', file_name: file.name, caption: text.trim() || undefined } });
      setText('');
      onChanged({ silent: true });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSending(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    try {
      const r = await post(`/conversations/${conv.id}/ai-suggest`);
      if (r.suggestion?.text) {
        setText(r.suggestion.text);
        setAiSuggestion({ conversation_id: conv.id, ...r.suggestion });
      } else toast(r.suggestion?.reason || 'The AI could not answer this from the knowledge base — reply manually.', 'info');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSuggesting(false);
    }
  };

  const contact = detail.contact;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
        <button onClick={onBack} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800 lg:hidden" aria-label="Back">←</button>
        <button onClick={onToggleContact} className="min-w-0 flex-1 text-left">
          <div className="truncate font-semibold">{contact?.name || contact?.phone}</div>
          <div className="truncate text-xs text-slate-500">{contact?.phone} {contact?.is_demo && '· demo'} {contact?.opted_out_at && '· opted out'}</div>
        </button>
        <WindowTimer window={conv.window} now={now} />
        <div className="flex flex-wrap items-center gap-1.5">
          {can('inbox.assign') && (
            <Select className="w-36 py-1 text-xs" value={conv.assigned_to || ''} onChange={(e) => act(() => patch(`/conversations/${conv.id}`, { assigned_to: e.target.value || null }), 'Assignment updated')}>
              <option value="">Unassigned</option>
              {(can('inbox.view_all') ? users : users.filter((u) => u.id === user.id || u.id === conv.assigned_to)).filter((u) => u.is_active && u.role !== 'viewer').map((u) => (
                <option key={u.id} value={u.id}>{u.id === user.id ? `Me (${u.name.split(' ')[0]})` : u.name}</option>
              ))}
            </Select>
          )}
          {canReply && (
            <Select className="w-32 py-1 text-xs" title="AI mode for this conversation" value={conv.ai_mode_override || ''} onChange={(e) => act(() => patch(`/conversations/${conv.id}`, { ai_mode_override: e.target.value || null }), 'AI mode updated')}>
              <option value="">AI: default</option>
              <option value="off">AI: off</option>
              <option value="suggest">AI: suggest</option>
              <option value="auto">AI: auto-reply</option>
            </Select>
          )}
          {can('inbox.takeover') &&
            (conv.human_takeover ? (
              <Button size="sm" variant="secondary" onClick={() => act(() => post(`/conversations/${conv.id}/release`), 'Handed back to AI')}>Hand back to AI</Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => act(() => post(`/conversations/${conv.id}/takeover`), 'You took over — AI paused')}>✋ Take over</Button>
            ))}
          {canReply &&
            (conv.status === 'open' ? (
              <Button size="sm" onClick={() => act(() => patch(`/conversations/${conv.id}`, { status: 'resolved' }), 'Resolved')}>Resolve</Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => act(() => patch(`/conversations/${conv.id}`, { status: 'open' }), 'Reopened')}>Reopen</Button>
            ))}
        </div>
      </div>

      {conv.human_takeover && (
        <div className="bg-purple-50 px-3 py-1 text-center text-xs text-purple-800 dark:bg-purple-950 dark:text-purple-200">✋ Human takeover — AI and automations are paused for this chat.</div>
      )}

      {/* Messages */}
      <div ref={scroller} className="chat-wallpaper scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-4 md:px-8">
        {loading && !timeline.length ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : !timeline.length ? (
          <p className="py-10 text-center text-sm text-slate-500">No messages yet.</p>
        ) : (
          timeline.map((it) => (it.kind === 'm' ? <Bubble key={`m${it.m.id}`} m={it.m} onRetry={(m) => act(() => post(`/conversations/${conv.id}/messages/${m.id}/retry`), 'Message re-queued')} /> : <Note key={`n${it.n.id}`} n={it.n} />))
        )}
      </div>

      {/* Composer */}
      {canReply ? (
        <div className="border-t border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
          {aiSuggestion?.conversation_id === conv.id && aiSuggestion?.text && (
            <div className="mb-2 flex items-start gap-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-200">
              <span>🤖 AI suggestion loaded into the box{aiSuggestion.knowledge?.length ? ` · based on: ${aiSuggestion.knowledge.join(', ')}` : ''}. Review before sending.</span>
              <button className="ml-auto underline" onClick={() => { setAiSuggestion(null); setText(''); }}>Discard</button>
            </div>
          )}
          <div className="mb-1.5 flex gap-1 text-xs">
            <button onClick={() => setNoteMode(false)} className={cx('rounded-full px-3 py-1', !noteMode ? 'bg-brand-600 text-white' : 'bg-slate-100 dark:bg-slate-800')}>Reply</button>
            <button onClick={() => setNoteMode(true)} className={cx('rounded-full px-3 py-1', noteMode ? 'bg-amber-500 text-white' : 'bg-slate-100 dark:bg-slate-800')}>🔒 Internal note</button>
          </div>
          {!noteMode && !windowOpen ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800">
              <span className="text-slate-600 dark:text-slate-300">The 24-hour window is closed. You can only send an approved template.</span>
              <Button size="sm" onClick={() => setShowTemplates(true)}>Send template</Button>
            </div>
          ) : (
            <div className="flex items-end gap-2">
              {!noteMode && (
                <>
                  <button onClick={() => fileRef.current?.click()} className="rounded-lg p-2 text-lg hover:bg-slate-100 dark:hover:bg-slate-800" title="Attach file" disabled={sending}>📎</button>
                  <input ref={fileRef} type="file" className="hidden" accept="image/jpeg,image/png,video/mp4,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={(e) => sendFile(e.target.files?.[0])} />
                  <button onClick={() => setShowTemplates(true)} className="rounded-lg p-2 text-lg hover:bg-slate-100 dark:hover:bg-slate-800" title="Send template">📄</button>
                  <button onClick={suggest} disabled={suggesting} className="rounded-lg p-2 text-lg hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800" title="Ask AI for a suggested reply">{suggesting ? <Spinner className="h-5 w-5" /> : '🤖'}</button>
                </>
              )}
              <Textarea
                rows={1}
                value={text}
                placeholder={noteMode ? 'Internal note — never sent to the customer' : 'Type a message (Enter to send, Shift+Enter for new line)'}
                className={cx('max-h-40 min-h-[40px] resize-none', noteMode && 'border-amber-400 bg-amber-50 dark:bg-amber-950/40')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <Button onClick={send} loading={sending} disabled={!text.trim()} className={noteMode ? 'bg-amber-500 hover:bg-amber-600' : ''}>
                {noteMode ? 'Add note' : 'Send'}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="border-t border-slate-200 bg-white p-3 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900">Read-only access</div>
      )}
      {showTemplates && <TemplateModal conversationId={conv.id} onClose={() => setShowTemplates(false)} onSent={() => { setShowTemplates(false); onChanged({ silent: true }); }} />}
    </div>
  );
}
