'use client';

import { useEffect, useState } from 'react';
import { api, del, patch, post, put } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, timeAgo } from '@/lib/format';
import { Async, Badge, Button, Card, Field, Input, Modal, Select, Table, Toggle, useToast } from '@/components/ui';
import { SecretField } from './common';

const BASE_TARGETS = [
  ['', '— ignore —'],
  ['phone', 'Phone (key)'],
  ['name', 'Name'],
  ['email', 'Email'],
  ['tags', 'Tags (comma separated)'],
  ['opted_in', 'WhatsApp opt-in (Yes/No)'],
];

function slug(s) {
  let k = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(k)) k = `f_${k}`;
  return k.slice(0, 48) || 'field';
}

/* ───────── Google + Sheets ───────── */

function SheetWizard({ initial, onClose, onSaved }) {
  const toast = useToast();
  const fields = useApi('/custom-fields');
  const [step, setStep] = useState(initial?.id ? 2 : 1);
  const [spreadsheetId, setSpreadsheetId] = useState(initial?.spreadsheet_id || '');
  const [info, setInfo] = useState(null);
  const [form, setForm] = useState(
    initial || { name: '', sheet_name: '', key_column: '', mapping: [], sync_direction: 'both', interval_minutes: 15, default_opt_in: false, is_active: true },
  );
  const [targets, setTargets] = useState({});
  const [busy, setBusy] = useState(false);
  const [newField, setNewField] = useState(null);

  const inspect = async (tab) => {
    setBusy(true);
    try {
      const id = spreadsheetId.match(/\/d\/([\w-]+)/)?.[1] || spreadsheetId.trim();
      setSpreadsheetId(id);
      const r = await post('/connectors/sheets/inspect', { spreadsheet_id: id, sheet_name: tab || undefined });
      setInfo(r);
      const existing = Object.fromEntries((initial?.mapping || []).map((m) => [m.column, m.field]));
      setTargets(Object.fromEntries(r.headers.map((h) => [h, existing[h] ?? (/(mobile|phone|whatsapp|contact no)/i.test(h) ? 'phone' : /^name$|customer name|full name/i.test(h) ? 'name' : /e-?mail/i.test(h) ? 'email' : '')])));
      setForm((f) => ({ ...f, sheet_name: r.sheet_name, name: f.name || r.title || 'Google Sheet' }));
      setStep(2);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initial?.id) inspect(initial.sheet_name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createField = async () => {
    try {
      const { field } = await post('/custom-fields', { key: newField.key, label: newField.label, type: 'text', internal: newField.internal });
      await fields.reload({ silent: true });
      setTargets((t) => ({ ...t, [newField.column]: `custom.${field.key}` }));
      setNewField(null);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const save = async () => {
    const mapping = Object.entries(targets).filter(([, f]) => f).map(([column, field]) => ({ column, field }));
    const key = mapping.find((m) => m.field === 'phone')?.column;
    if (!key) return toast('Map one column to Phone (key)', 'error');
    setBusy(true);
    try {
      const body = { ...form, key_column: key, mapping, interval_minutes: Number(form.interval_minutes) };
      if (initial?.id) await put(`/connectors/sheets/${initial.id}`, { name: body.name, sheet_name: body.sheet_name, key_column: key, mapping, sync_direction: body.sync_direction, interval_minutes: body.interval_minutes, default_opt_in: body.default_opt_in, is_active: body.is_active });
      else await post('/connectors/sheets', { ...body, spreadsheet_id: spreadsheetId });
      toast('Sheet connection saved — first sync started');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const defs = fields.data?.fields || [];
  const targetOptions = [...BASE_TARGETS, ...defs.map((d) => [`custom.${d.key}`, `${d.label}${d.internal ? ' 🔒 internal' : ''}`])];

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={initial?.id ? `Edit “${initial.name}”` : 'Connect a Google Sheet'}
      footer={step === 1 ? <Button onClick={() => inspect()} loading={busy} disabled={!spreadsheetId.trim()}>Read sheet</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>Save mapping</Button></>}
    >
      {step === 1 ? (
        <Field label="Spreadsheet URL or ID" hint="Share the sheet with the connected Google account (or own it).">
          <Input value={spreadsheetId} onChange={(e) => setSpreadsheetId(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…/edit" />
        </Field>
      ) : !info ? (
        <p className="py-6 text-center text-sm text-slate-500">Reading sheet…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Connection name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Tab">
              <Select value={form.sheet_name} onChange={(e) => inspect(e.target.value)}>
                {info.sheets.map((s) => <option key={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="Sync direction">
              <Select value={form.sync_direction} onChange={(e) => setForm({ ...form, sync_direction: e.target.value })}>
                <option value="both">Two-way</option>
                <option value="pull">Sheet → app only</option>
                <option value="push">App → sheet only</option>
              </Select>
            </Field>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Map columns <span className="font-normal text-slate-500">(column names are kept exactly as in your sheet)</span></p>
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {info.headers.map((h, i) => (
                <div key={`${h}-${i}`} className="grid items-center gap-2 p-2 md:grid-cols-[1fr_1fr_auto]">
                  <div className="min-w-0">
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">{h}</code>
                    <span className="ml-2 truncate text-xs text-slate-400">{info.sample.map((r) => r[i]).filter(Boolean).slice(0, 2).join(' · ')}</span>
                  </div>
                  <Select value={targets[h] || ''} onChange={(e) => setTargets({ ...targets, [h]: e.target.value })}>
                    {targetOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                  <Button size="sm" variant="ghost" onClick={() => setNewField({ column: h, label: h, key: slug(h), internal: /pan|aadhaar|aadhar|gst|payment|proof|account|ifsc|credit/i.test(h) })}>+ New field</Button>
                </div>
              ))}
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Sync every (minutes)"><Input type="number" min={5} max={1440} value={form.interval_minutes} onChange={(e) => setForm({ ...form, interval_minutes: e.target.value })} /></Field>
            <div className="space-y-2 pt-6">
              <Toggle checked={form.is_active} onChange={(v) => setForm({ ...form, is_active: v })} label="Active" />
            </div>
          </div>
          <Toggle
            checked={form.default_opt_in}
            onChange={(v) => setForm({ ...form, default_opt_in: v })}
            label="This sheet records genuine WhatsApp consent"
            description="Only when on will a mapped opt-in column (Yes) mark contacts as opted in (source: google_sheet)."
          />
        </div>
      )}
      {newField && (
        <Modal open onClose={() => setNewField(null)} title={`New field from “${newField.column}”`} footer={<><Button variant="secondary" onClick={() => setNewField(null)}>Cancel</Button><Button onClick={createField}>Create & map</Button></>}>
          <div className="space-y-3">
            <Field label="Label" hint="Kept exactly as the column name by default"><Input value={newField.label} onChange={(e) => setNewField({ ...newField, label: e.target.value })} /></Field>
            <Field label="Key"><Input value={newField.key} onChange={(e) => setNewField({ ...newField, key: e.target.value })} /></Field>
            <Toggle checked={newField.internal} onChange={(v) => setNewField({ ...newField, internal: v })} label="Internal" description="Never shown to customers and never passed to the AI." />
          </div>
        </Modal>
      )}
    </Modal>
  );
}

function GoogleCard({ data, reload }) {
  const { can } = useAuth();
  const toast = useToast();
  const g = useApi('/connectors/google');
  const conns = useApi('/connectors/sheets');
  const [clientId, setClientId] = useState(data.settings.google.client_id || '');
  const [wizard, setWizard] = useState(null);
  const [syncing, setSyncing] = useState(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('google') === 'connected') toast('Google account connected');
    if (p.get('google') === 'error') toast(`Google connection failed: ${p.get('reason') || ''}`, 'error');
  }, [toast]);

  const connect = async () => {
    try {
      if (clientId !== data.settings.google.client_id) await put('/settings/google', { client_id: clientId });
      const { url } = await api('/connectors/google/auth-url');
      window.location.href = url;
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const sync = async (c) => {
    setSyncing(c.id);
    try {
      const { stats } = await post(`/connectors/sheets/${c.id}/sync`);
      toast(`Synced: ${stats.created} new, ${stats.pulled} pulled, ${stats.pushed} pushed, ${stats.appended} appended`);
      conns.reload({ silent: true });
    } catch (e) {
      toast(e.message, 'error');
      conns.reload({ silent: true });
    } finally {
      setSyncing(null);
    }
  };

  const remove = async (c) => {
    if (!window.confirm(`Remove connection “${c.name}”? Contacts stay; syncing stops.`)) return;
    await del(`/connectors/sheets/${c.id}`).catch((e) => toast(e.message, 'error'));
    conns.reload();
  };

  return (
    <Card title="Google Sheets" actions={g.data?.connected && <Button size="sm" onClick={() => setWizard({})}>Connect a sheet</Button>}>
      <Async loading={g.loading} error={g.error} onRetry={g.reload}>
        {g.data && (
          <div className="space-y-4">
            {g.data.connected ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-emerald-50 p-3 text-sm dark:bg-emerald-950">
                <span>✅ Connected as <b>{g.data.email}</b>{g.data.mock && ' (mock — a local demo sheet is used)'}</span>
                <Button size="sm" variant="ghost" onClick={async () => { await post('/connectors/google/disconnect'); g.reload(); }}>Disconnect</Button>
              </div>
            ) : (
              <div className="space-y-3">
                {!g.data.mock && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="OAuth Client ID" hint={`Authorized redirect URI: ${g.data.redirectUri}`}>
                      <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
                    </Field>
                    <SecretField name="google.client_secret" label="OAuth Client secret" status={data.secrets} canEdit={can('settings.secrets')} onSaved={reload} />
                  </div>
                )}
                <Button onClick={connect}>{g.data.mock ? 'Connect demo Google account' : 'Connect Google account'}</Button>
              </div>
            )}
            <Async loading={conns.loading} error={conns.error} onRetry={conns.reload} empty={!conns.data?.connections?.length} emptyProps={{ icon: '📗', title: 'No sheets connected', description: g.data.connected ? 'Connect a sheet and map its columns to contact fields.' : 'Connect a Google account first.' }}>
              <Table
                rows={conns.data?.connections || []}
                columns={[
                  { key: 'name', label: 'Sheet', render: (c) => <div><div className="font-medium">{c.name}</div><div className="text-xs text-slate-500">Tab “{c.sheet_name}” · key “{c.key_column}” · {c.mapping.length} columns</div></div> },
                  { key: 'dir', label: 'Direction', render: (c) => <Badge color="blue">{c.sync_direction === 'both' ? 'two-way' : c.sync_direction}</Badge> },
                  { key: 'status', label: 'Last sync', render: (c) => <div className="text-xs"><div>{c.last_synced_at ? timeAgo(c.last_synced_at) : 'never'}</div><div className={c.last_status === 'error' ? 'text-red-600' : 'text-slate-500'}>{c.last_status === 'error' ? c.last_error : c.last_status}</div></div> },
                  { key: 'a', label: '', render: (c) => <div className="flex justify-end gap-1"><Button size="sm" variant="secondary" loading={syncing === c.id} onClick={() => sync(c)}>Sync now</Button><Button size="sm" variant="ghost" onClick={() => setWizard(c)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => remove(c)}>Remove</Button></div> },
                ]}
              />
            </Async>
          </div>
        )}
      </Async>
      {wizard && <SheetWizard initial={wizard.id ? wizard : null} onClose={() => setWizard(null)} onSaved={() => { setWizard(null); conns.reload(); }} />}
    </Card>
  );
}

/* ───────── Webhooks ───────── */

function WebhooksCard() {
  const toast = useToast();
  const { data, error, loading, reload } = useApi('/connectors/webhooks');
  const templates = useApi('/templates?status=APPROVED');
  const [form, setForm] = useState(null);
  const [secret, setSecret] = useState(null);
  const [deliveries, setDeliveries] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const body = form.direction === 'out' ? { name: form.name, direction: 'out', url: form.url, events: form.events } : { name: form.name, direction: 'in', action: { type: form.type, template_id: form.template_id || undefined, add_tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [], mark_opted_in: form.mark_opted_in } };
      const r = await post('/connectors/webhooks', body);
      setSecret(r.secret ? { label: 'Signing secret', value: r.secret } : { label: 'Webhook URL', value: r.url });
      setForm(null);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const showDeliveries = async (w) => {
    try {
      setDeliveries({ hook: w, rows: (await api(`/connectors/webhooks/${w.id}/deliveries`)).deliveries });
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <Card title="Webhooks" actions={<><Button size="sm" variant="secondary" onClick={() => setForm({ direction: 'in', name: '', type: 'upsert_contact', tags: '', mark_opted_in: false })}>+ Inbound</Button><Button size="sm" onClick={() => setForm({ direction: 'out', name: '', url: '', events: ['message.received'] })}>+ Outbound</Button></>}>
      <Async loading={loading} error={error} onRetry={reload} empty={!data?.webhooks?.length} emptyProps={{ icon: '🔗', title: 'No webhooks', description: 'Outbound: get notified of events. Inbound: let other systems create contacts or send templates.' }}>
        <Table
          rows={data?.webhooks || []}
          columns={[
            { key: 'name', label: 'Name', render: (w) => <div><div className="font-medium">{w.name}</div><div className="text-xs text-slate-500">{w.direction === 'out' ? w.url : `${data.inboundBase}${w.token_prefix}…`}</div></div> },
            { key: 'dir', label: 'Type', render: (w) => <Badge color={w.direction === 'out' ? 'purple' : 'blue'}>{w.direction === 'out' ? 'outbound' : `inbound · ${w.action?.type}`}</Badge> },
            { key: 'events', label: 'Events', render: (w) => <span className="text-xs">{w.events?.join(', ')}</span> },
            { key: 'last', label: 'Last call', render: (w) => <span className="text-xs text-slate-500">{w.last_status || '—'} {w.last_called_at && `· ${timeAgo(w.last_called_at)}`}</span> },
            { key: 'a', label: '', render: (w) => <div className="flex justify-end gap-1">{w.direction === 'out' && <Button size="sm" variant="ghost" onClick={() => showDeliveries(w)}>Log</Button>}<Button size="sm" variant="ghost" onClick={async () => { await patch(`/connectors/webhooks/${w.id}`, { is_active: !w.is_active }); reload(); }}>{w.is_active ? 'Pause' : 'Resume'}</Button><Button size="sm" variant="ghost" onClick={async () => { if (window.confirm('Delete webhook?')) { await del(`/connectors/webhooks/${w.id}`); reload(); } }}>Delete</Button></div> },
          ]}
        />
      </Async>
      {form && (
        <Modal open onClose={() => setForm(null)} title={form.direction === 'out' ? 'New outbound webhook' : 'New inbound webhook'} footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button onClick={save} loading={busy}>Create</Button></>}>
          <div className="space-y-3">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            {form.direction === 'out' ? (
              <>
                <Field label="URL" hint="Requests are signed: X-Gabbbar-Signature = sha256 HMAC of the body"><Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/hooks/whatsapp" /></Field>
                <Field label="Events">
                  <div className="grid grid-cols-2 gap-1.5">
                    {(data?.events || []).map((ev) => (
                      <label key={ev} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={form.events.includes(ev)} onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, ev] : form.events.filter((x) => x !== ev) })} />
                        {ev}
                      </label>
                    ))}
                  </div>
                </Field>
              </>
            ) : (
              <>
                <Field label="Action">
                  <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                    <option value="upsert_contact">Create / update contact</option>
                    <option value="send_template">Create / update contact and send a template</option>
                  </Select>
                </Field>
                {form.type === 'send_template' && (
                  <Field label="Template" hint="Only sent if the contact opted in or messaged in the last 24h">
                    <Select value={form.template_id || ''} onChange={(e) => setForm({ ...form, template_id: e.target.value })}>
                      <option value="">Choose…</option>
                      {(templates.data?.templates || []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
                    </Select>
                  </Field>
                )}
                <Field label="Add tags (comma separated)"><Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></Field>
                <Toggle checked={form.mark_opted_in} onChange={(v) => setForm({ ...form, mark_opted_in: v })} label="Record opt-in when the request includes consent_source" description="Use for website forms that collect WhatsApp consent." />
              </>
            )}
          </div>
        </Modal>
      )}
      {secret && (
        <Modal open onClose={() => setSecret(null)} title="Copy this now" footer={<Button onClick={() => setSecret(null)}>Done</Button>}>
          <p className="mb-2 text-sm text-slate-500">{secret.label} — it will not be shown again.</p>
          <div className="flex gap-2"><Input readOnly value={secret.value} /><Button variant="secondary" onClick={() => navigator.clipboard.writeText(secret.value).then(() => toast('Copied'))}>Copy</Button></div>
        </Modal>
      )}
      {deliveries && (
        <Modal open wide onClose={() => setDeliveries(null)} title={`Deliveries — ${deliveries.hook.name}`}>
          {deliveries.rows.length ? (
            <Table rows={deliveries.rows} columns={[{ key: 'created_at', label: 'When', render: (d) => <span className="text-xs">{fmtDateTime(d.created_at)}</span> }, { key: 'event', label: 'Event' }, { key: 'status', label: 'Status', render: (d) => <Badge color={d.status === 'success' ? 'green' : d.status === 'failed' ? 'red' : 'amber'}>{d.status}</Badge> }, { key: 'response_code', label: 'HTTP' }, { key: 'attempts', label: 'Tries' }, { key: 'error', label: 'Error', render: (d) => <span className="text-xs text-red-600">{d.error}</span> }]} />
          ) : (
            <p className="py-6 text-center text-sm text-slate-500">No deliveries yet.</p>
          )}
        </Modal>
      )}
    </Card>
  );
}

/* ───────── API keys ───────── */

function ApiKeysCard() {
  const toast = useToast();
  const { data, error, loading, reload } = useApi('/connectors/api-keys');
  const [form, setForm] = useState(null);
  const [created, setCreated] = useState(null);

  const save = async () => {
    try {
      const r = await post('/connectors/api-keys', form);
      setCreated(r.secret);
      setForm(null);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <Card title="REST API keys" actions={<Button size="sm" onClick={() => setForm({ name: '', scopes: ['contacts:read', 'contacts:write'] })}>New key</Button>}>
      <details className="mb-3 text-xs text-slate-600 dark:text-slate-400">
        <summary className="cursor-pointer font-medium">API quick reference</summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] text-slate-100">{`Authorization: Bearer wak_…   (base URL: /api/v1)

GET    /contacts?search=&tag=&page=      contacts:read
GET    /contacts/{phone}                  contacts:read
POST   /contacts  {phone,name,email,tags,custom}      contacts:write (upsert)
PATCH  /contacts/{phone}                  contacts:write
POST   /contacts/{phone}/opt-in {source}  contacts:write
POST   /messages/template {phone,template_name,language,variables[],idempotency_key}  messages:send
POST   /messages/text {phone,text}        messages:send (24h window only)
GET    /messages/{id}                     messages:send
GET    /conversations?status=open         conversations:read
GET    /templates                         templates:read`}</pre>
      </details>
      <Async loading={loading} error={error} onRetry={reload} empty={!data?.keys?.length} emptyProps={{ icon: '🔑', title: 'No API keys' }}>
        <Table
          rows={data?.keys || []}
          columns={[
            { key: 'name', label: 'Name', render: (k) => <div><div className="font-medium">{k.name}</div><code className="text-xs text-slate-500">{k.prefix}…</code></div> },
            { key: 'scopes', label: 'Scopes', render: (k) => <div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div> },
            { key: 'used', label: 'Last used', render: (k) => <span className="text-xs text-slate-500">{k.last_used_at ? timeAgo(k.last_used_at) : 'never'}</span> },
            { key: 'st', label: '', render: (k) => (k.revoked_at ? <Badge color="red">revoked</Badge> : <Button size="sm" variant="ghost" onClick={async () => { if (window.confirm('Revoke this key? Integrations using it will stop working.')) { await del(`/connectors/api-keys/${k.id}`); reload(); } }}>Revoke</Button>) },
          ]}
        />
      </Async>
      {form && (
        <Modal open onClose={() => setForm(null)} title="New API key" footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button onClick={save} disabled={!form.name || !form.scopes.length}>Create</Button></>}>
          <div className="space-y-3">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Website forms" /></Field>
            <Field label="Scopes">
              <div className="space-y-1">
                {(data?.scopes || []).map((s) => (
                  <label key={s} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={form.scopes.includes(s)} onChange={(e) => setForm({ ...form, scopes: e.target.checked ? [...form.scopes, s] : form.scopes.filter((x) => x !== s) })} />
                    {s}
                  </label>
                ))}
              </div>
            </Field>
          </div>
        </Modal>
      )}
      {created && (
        <Modal open onClose={() => setCreated(null)} title="Copy your API key" footer={<Button onClick={() => setCreated(null)}>Done</Button>}>
          <p className="mb-2 text-sm text-slate-500">This key is shown only once. Store it securely.</p>
          <div className="flex gap-2"><Input readOnly value={created} /><Button variant="secondary" onClick={() => navigator.clipboard.writeText(created).then(() => toast('Copied'))}>Copy</Button></div>
        </Modal>
      )}
    </Card>
  );
}

export default function ConnectorsSettings({ data, reload }) {
  return (
    <div className="space-y-5">
      <GoogleCard data={data} reload={reload} />
      <WebhooksCard />
      <ApiKeysCard />
    </div>
  );
}
