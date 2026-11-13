'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, post, qs } from '@/lib/api';
import { useApi, useDebounced, useEvents, useNow } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { readFileAsBase64 } from '@/lib/format';
import { RequirePermission } from '@/components/Shell';
import { Button, cx, EmptyState, ErrorState, Field, Input, Modal, Textarea, useToast } from '@/components/ui';
import ConversationList from '@/components/inbox/ConversationList';
import ChatPane from '@/components/inbox/ChatPane';
import ContactPanel from '@/components/inbox/ContactPanel';

function SimulateModal({ onClose, defaultPhone }) {
  const toast = useToast();
  const [phone, setPhone] = useState(defaultPhone || '9876500001');
  const [name, setName] = useState('Demo Customer');
  const [text, setText] = useState('Hi! Do you take bulk orders for school bags?');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const body = { phone, name };
      if (file) body.media = { base64: await readFileAsBase64(file), mime_type: file.type || 'application/octet-stream', file_name: file.name, caption: text || undefined };
      else body.text = text;
      await post('/whatsapp/simulate-inbound', body);
      toast('Customer message simulated');
      onClose();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Simulate a customer message (demo mode)" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={send} loading={busy}>Send as customer</Button></>}>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">Goes through the same webhook → queue → automation → AI pipeline as a real WhatsApp message. Nothing is sent to anyone.</p>
        <Field label="Customer phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Field label="Profile name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Message (or caption)"><Textarea value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <Field label="Attach media (optional)"><input type="file" accept="image/*,application/pdf,audio/*" onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-sm" /></Field>
      </div>
    </Modal>
  );
}

function InboxInner() {
  const { status } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const now = useNow(30_000);
  const [filter, setFilter] = useState('open');
  const [search, setSearch] = useState('');
  const [label, setLabel] = useState('');
  const debounced = useDebounced(search);
  const list = useApi(`/conversations${qs({ filter, search: debounced, label })}`);
  const users = useApi('/users');
  const labels = useApi('/labels');
  const [selectedId, setSelectedId] = useState(params.get('c'));
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [msgs, setMsgs] = useState({ messages: [], notes: [] });
  const [loadingChat, setLoadingChat] = useState(false);
  const [showContact, setShowContact] = useState(false);
  const [simulate, setSimulate] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  // Open a conversation by contact id (link from Contacts page)
  useEffect(() => {
    const contactId = params.get('contact');
    if (!contactId) return;
    api(`/conversations/by-contact/${contactId}`)
      .then((d) => setSelectedId(d.conversation.id))
      .catch((e) => toast(e.message, 'error'));
  }, [params, toast]);

  const loadChat = useCallback(
    async (id, { silent = false } = {}) => {
      if (!id) return;
      if (!silent) setLoadingChat(true);
      try {
        const [d, m] = await Promise.all([api(`/conversations/${id}`), api(`/conversations/${id}/messages`)]);
        if (selectedRef.current !== id) return;
        setDetail(d);
        setMsgs(m);
        setDetailError(null);
        if (d.conversation.unread_count > 0) post(`/conversations/${id}/read`).then(() => list.reload({ silent: true })).catch(() => {});
      } catch (e) {
        setDetailError(e);
      } finally {
        setLoadingChat(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    setDetail(null);
    setMsgs({ messages: [], notes: [] });
    if (selectedId) {
      loadChat(selectedId);
      router.replace(`/inbox?c=${selectedId}`, { scroll: false });
    }
  }, [selectedId, loadChat, router]);

  const live = useEvents({
    'message.new': (d) => {
      list.reload({ silent: true });
      if (d.conversation_id === selectedRef.current) {
        setMsgs((s) => (s.messages.some((x) => x.id === d.message.id) ? s : { ...s, messages: [...s.messages, d.message] }));
        if (d.message.direction === 'in') post(`/conversations/${d.conversation_id}/read`).catch(() => {});
      }
    },
    'message.status': (d) => {
      if (d.conversation_id !== selectedRef.current) return;
      if (d.media_ready) return loadChat(d.conversation_id, { silent: true });
      setMsgs((s) => ({ ...s, messages: s.messages.map((m) => (m.id === d.message_id ? { ...m, status: d.status ?? m.status, error_message: d.error_message ?? m.error_message } : m)) }));
    },
    'note.new': (d) => {
      if (d.conversation_id === selectedRef.current) setMsgs((s) => (s.notes.some((n) => n.id === d.note.id) ? s : { ...s, notes: [...s.notes, d.note] }));
    },
    'conversation.updated': (d) => {
      list.reload({ silent: true });
      if (d.id === selectedRef.current) loadChat(d.id, { silent: true });
    },
    'ai.suggestion': (d) => {
      if (d.conversation_id === selectedRef.current) setAiSuggestion(d);
    },
    'ticket.created': (d) => {
      toast(`🎫 New ticket: ${d.subject}`, 'info');
      if (d.conversation_id === selectedRef.current) loadChat(d.conversation_id, { silent: true });
    },
    'system.alert': (d) => toast(d.message, 'error'),
  });

  const onChanged = (opts) => {
    loadChat(selectedId, opts);
    list.reload({ silent: true });
  };

  return (
    <div className="flex h-full min-h-0">
      <div className={cx('h-full w-full shrink-0 lg:w-80 xl:w-96', selectedId ? 'hidden lg:block' : 'block')}>
        <ConversationList
          data={list.data}
          loading={list.loading}
          error={list.error}
          reload={list.reload}
          filter={filter}
          setFilter={setFilter}
          search={search}
          setSearch={setSearch}
          label={label}
          setLabel={setLabel}
          labels={labels.data?.labels}
          selectedId={selectedId}
          onSelect={setSelectedId}
          now={now}
          onSimulate={status?.mock?.whatsapp ? () => setSimulate(true) : undefined}
        />
      </div>
      <div className={cx('min-w-0 flex-1', selectedId ? 'flex' : 'hidden lg:flex')}>
        {!selectedId ? (
          <div className="chat-wallpaper flex flex-1 items-center justify-center">
            <EmptyState icon="💬" title="Select a conversation" description={live ? 'Live updates are on.' : 'Connecting to live updates…'} />
          </div>
        ) : detailError ? (
          <div className="flex flex-1 items-center justify-center"><ErrorState error={detailError} onRetry={() => loadChat(selectedId)} /></div>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              {detail ? (
                <ChatPane
                  detail={detail}
                  messages={msgs.messages}
                  notes={msgs.notes}
                  loading={loadingChat}
                  users={users.data?.users || []}
                  now={now}
                  onBack={() => setSelectedId(null)}
                  onChanged={onChanged}
                  aiSuggestion={aiSuggestion}
                  setAiSuggestion={setAiSuggestion}
                  onToggleContact={() => setShowContact((v) => !v)}
                />
              ) : (
                <div className="chat-wallpaper flex h-full items-center justify-center text-sm text-slate-500">Loading conversation…</div>
              )}
            </div>
            {detail && (
              <div className={cx('w-80 shrink-0', showContact ? 'fixed inset-y-0 right-0 z-30 block shadow-xl xl:static xl:shadow-none' : 'hidden xl:block')}>
                <ContactPanel detail={detail} labels={labels.data?.labels || []} onChanged={(o) => { onChanged(o); labels.reload({ silent: true }); }} onClose={() => setShowContact(false)} />
              </div>
            )}
          </>
        )}
      </div>
      {simulate && <SimulateModal onClose={() => setSimulate(false)} defaultPhone={detail?.contact?.phone} />}
    </div>
  );
}

export default function InboxPage() {
  return (
    <RequirePermission perm="inbox.view">
      <Suspense fallback={null}>
        <InboxInner />
      </Suspense>
    </RequirePermission>
  );
}
