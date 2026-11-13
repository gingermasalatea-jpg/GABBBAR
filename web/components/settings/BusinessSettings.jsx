'use client';

import { useState } from 'react';
import { put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Card, Field, Input, Select, Textarea, Toggle, useToast } from '@/components/ui';
import { SaveBar, useSectionForm } from './common';

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'];
const DAYS = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
];

export function BusinessSettings({ data, reload }) {
  const { can, refresh } = useAuth();
  const toast = useToast();
  const canEdit = can('settings.manage');
  const { form, set } = useSectionForm(data.settings.business);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await put('/settings/business', form);
      toast('Business profile saved');
      reload();
      refresh();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Business profile">
      <p className="mb-4 text-xs text-slate-500">The AI assistant uses this profile as trusted business information.</p>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Business name">
          <Input value={form.name || ''} disabled={!canEdit} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Tagline / about (max 139 chars on WhatsApp)">
          <Input maxLength={139} value={form.about || ''} disabled={!canEdit} onChange={(e) => set('about', e.target.value)} />
        </Field>
        <Field label="Email">
          <Input value={form.email || ''} disabled={!canEdit} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Website">
          <Input value={form.website || ''} disabled={!canEdit} onChange={(e) => set('website', e.target.value)} />
        </Field>
        <Field label="Address" className="md:col-span-2">
          <Input value={form.address || ''} disabled={!canEdit} onChange={(e) => set('address', e.target.value)} />
        </Field>
        <Field label="Description" className="md:col-span-2">
          <Textarea rows={5} value={form.description || ''} disabled={!canEdit} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label="Timezone">
          <Select value={form.timezone || 'Asia/Kolkata'} disabled={!canEdit} onChange={(e) => set('timezone', e.target.value)}>
            {TIMEZONES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
      </div>
      {canEdit && (
        <div className="mt-4">
          <SaveBar onSave={save} saving={saving} />
        </div>
      )}
    </Card>
  );
}

export function HoursSettings({ data, reload }) {
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = can('settings.manage');
  const { form, set } = useSectionForm(data.settings.working_hours);
  const [saving, setSaving] = useState(false);

  const setDay = (day, slots) => set('days', { ...form.days, [day]: slots });

  const save = async () => {
    setSaving(true);
    try {
      await put('/settings/working_hours', form);
      toast('Working hours saved');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card title="Working hours">
        <Field label="Timezone" className="mb-4 max-w-xs">
          <Select value={form.timezone} disabled={!canEdit} onChange={(e) => set('timezone', e.target.value)}>
            {TIMEZONES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {DAYS.map(([key, label]) => {
            const slots = form.days?.[key] || [];
            const open = slots.length > 0;
            return (
              <div key={key} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="w-28">
                  <Toggle checked={open} disabled={!canEdit} onChange={(v) => setDay(key, v ? [{ start: '09:30', end: '18:30' }] : [])} label={label} />
                </div>
                {open ? (
                  slots.map((s, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Input type="time" className="w-32" value={s.start} disabled={!canEdit} onChange={(e) => setDay(key, slots.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                      <span className="text-slate-400">–</span>
                      <Input type="time" className="w-32" value={s.end} disabled={!canEdit} onChange={(e) => setDay(key, slots.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                    </div>
                  ))
                ) : (
                  <span className="text-sm text-slate-400">Closed</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>
      <Card title="Out-of-hours reply">
        <div className="space-y-3">
          <Toggle
            checked={Boolean(form.out_of_hours?.enabled)}
            disabled={!canEdit}
            onChange={(v) => set('out_of_hours', { ...form.out_of_hours, enabled: v })}
            label="Send an automatic reply outside working hours"
            description="Sent at most once every 12 hours per customer, and only inside the 24-hour window."
          />
          <Textarea value={form.out_of_hours?.message || ''} disabled={!canEdit} onChange={(e) => set('out_of_hours', { ...form.out_of_hours, message: e.target.value })} />
        </div>
      </Card>
      {canEdit && <SaveBar onSave={save} saving={saving} />}
    </div>
  );
}
