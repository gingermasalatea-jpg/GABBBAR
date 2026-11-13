'use client';

import { useState } from 'react';
import { post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Field, Input, ListEditor, Textarea, Toggle, useToast } from '@/components/ui';
import { SaveBar, SecretField, useSectionForm } from './common';

export default function WhatsAppSettings({ data, reload }) {
  const { can, refresh } = useAuth();
  const toast = useToast();
  const canEdit = can('settings.manage');
  const wa = useSectionForm(data.settings.whatsapp);
  const gen = useSectionForm(data.settings.general);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const saveWa = async () => {
    setSaving(true);
    try {
      await put('/settings/whatsapp', wa.form);
      await put('/settings/general', {
        default_country_code: gen.form.default_country_code,
        opt_out_keywords: gen.form.opt_out_keywords,
        opt_in_keywords: gen.form.opt_in_keywords,
        opt_out_reply: gen.form.opt_out_reply,
        opt_in_reply: gen.form.opt_in_reply,
        broadcast_rate_per_sec: Number(gen.form.broadcast_rate_per_sec),
      });
      toast('WhatsApp settings saved');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await post('/whatsapp/test'));
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const toggleLive = async (on) => {
    if (on && !window.confirm('Turn on Send live? Real WhatsApp messages will be delivered to customers from now on.')) return;
    try {
      await put('/settings/general', { send_live: on });
      gen.set('send_live', on);
      toast(on ? 'Send live is ON — messages will reach customers' : 'Send live is OFF — messages are held', on ? 'success' : 'info');
      refresh();
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="space-y-5">
      <Card title="Send live">
        <div className="space-y-3">
          <Toggle
            checked={Boolean(gen.form.send_live)}
            disabled={!can('send_live.toggle') || data.mock.whatsapp}
            onChange={toggleLive}
            label="Deliver real messages to customers"
            description="While off, every outgoing message (agents, AI, automations, broadcasts) is recorded but held — nothing reaches a customer."
          />
          {data.mock.whatsapp && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              WhatsApp is in <b>mock mode</b> (<code>WHATSAPP_MOCK=true</code> in .env). Use the inbox&apos;s “Simulate customer message” to try the full flow.
              Set <code>WHATSAPP_MOCK=false</code> and restart after adding real credentials.
            </p>
          )}
        </div>
      </Card>

      <Card
        title="Cloud API connection"
        actions={
          <Button variant="secondary" size="sm" onClick={test} loading={testing}>
            Test connection
          </Button>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Phone Number ID" hint="Meta App → WhatsApp → API Setup">
            <Input value={wa.form.phone_number_id || ''} disabled={!canEdit} onChange={(e) => wa.set('phone_number_id', e.target.value.trim())} />
          </Field>
          <Field label="WhatsApp Business Account (WABA) ID">
            <Input value={wa.form.waba_id || ''} disabled={!canEdit} onChange={(e) => wa.set('waba_id', e.target.value.trim())} />
          </Field>
          <Field label="Display phone number" hint="Shown in the UI only">
            <Input value={wa.form.display_phone || ''} disabled={!canEdit} onChange={(e) => wa.set('display_phone', e.target.value)} />
          </Field>
          <Field label="Graph API version" hint="Leave blank for the default">
            <Input value={wa.form.graph_version || ''} placeholder="v23.0" disabled={!canEdit} onChange={(e) => wa.set('graph_version', e.target.value.trim())} />
          </Field>
        </div>
        {testResult && (
          <div className={`mt-4 rounded-lg p-3 text-sm ${testResult.ok ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200'}`}>
            {testResult.ok ? (
              <>
                ✅ Connected{testResult.mock ? ' (mock)' : ''}: <b>{testResult.verified_name || '—'}</b> · {testResult.display_phone_number || ''} · quality {testResult.quality_rating || 'n/a'}
              </>
            ) : (
              <>❌ {testResult.error}</>
            )}
          </div>
        )}
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <SecretField name="whatsapp.access_token" label="Access token (System User)" status={data.secrets} canEdit={can('settings.secrets')} onSaved={reload} />
          <SecretField name="whatsapp.app_secret" label="App secret" hint="Used to verify X-Hub-Signature-256 on every webhook." status={data.secrets} canEdit={can('settings.secrets')} onSaved={reload} />
          <SecretField name="whatsapp.verify_token" label="Webhook verify token" hint="Any random string; paste the same value in Meta's webhook setup." status={data.secrets} canEdit={can('settings.secrets')} onSaved={reload} />
          <Field label="Webhook callback URL" hint="Configure this in Meta App → WhatsApp → Configuration. Subscribe to: messages, message_template_status_update.">
            <div className="flex items-center gap-2">
              <Input readOnly value={data.webhookUrl} />
              <Button variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(data.webhookUrl).then(() => toast('Copied'))}>
                Copy
              </Button>
            </div>
          </Field>
        </div>
      </Card>

      <Card title="Opt-in / opt-out & sending">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Default country code" hint="Applied to 10-digit numbers without a + prefix">
            <Input value={gen.form.default_country_code || ''} disabled={!canEdit} onChange={(e) => gen.set('default_country_code', e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="Broadcast speed (messages / second)" hint="Meta's default throughput is 80 mps; keep lower for new numbers.">
            <Input type="number" min={1} max={80} value={gen.form.broadcast_rate_per_sec || 20} disabled={!canEdit} onChange={(e) => gen.set('broadcast_rate_per_sec', e.target.value)} />
          </Field>
          <Field label="Opt-out keywords (STOP)">
            <ListEditor value={gen.form.opt_out_keywords || []} disabled={!canEdit} onChange={(v) => gen.set('opt_out_keywords', v)} />
          </Field>
          <Field label="Opt-in keywords (START)">
            <ListEditor value={gen.form.opt_in_keywords || []} disabled={!canEdit} onChange={(v) => gen.set('opt_in_keywords', v)} />
          </Field>
          <Field label="Reply after opt-out">
            <Textarea value={gen.form.opt_out_reply || ''} disabled={!canEdit} onChange={(e) => gen.set('opt_out_reply', e.target.value)} />
          </Field>
          <Field label="Reply after opt-in">
            <Textarea value={gen.form.opt_in_reply || ''} disabled={!canEdit} onChange={(e) => gen.set('opt_in_reply', e.target.value)} />
          </Field>
        </div>
      </Card>

      {canEdit && <SaveBar onSave={saveWa} saving={saving} />}
      <p className="text-xs text-slate-500">
        Mode: WhatsApp <Badge color={data.mock.whatsapp ? 'amber' : 'green'}>{data.mock.whatsapp ? 'mock' : 'live API'}</Badge> · AI{' '}
        <Badge color={data.mock.ai ? 'amber' : 'green'}>{data.mock.ai ? 'mock' : 'live'}</Badge> · Google{' '}
        <Badge color={data.mock.google ? 'amber' : 'green'}>{data.mock.google ? 'mock' : 'live'}</Badge>
      </p>
    </div>
  );
}
