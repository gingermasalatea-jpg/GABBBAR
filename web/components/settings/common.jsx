'use client';

import { useState } from 'react';
import { put } from '@/lib/api';
import { Badge, Button, Field, Input, useToast } from '@/components/ui';

/** Write-only secret input. The current value is never shown; only whether it is set. */
export function SecretField({ name, label, status, hint, canEdit, onSaved }) {
  const toast = useToast();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const isSet = status?.[name]?.set;
  const source = status?.[name]?.source;

  const save = async (v) => {
    setSaving(true);
    try {
      await put(`/settings/secrets/${name}`, { value: v });
      setValue('');
      toast(v ? `${label} saved (encrypted)` : `${label} cleared`);
      onSaved?.();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Field
      label={
        <span className="flex items-center gap-2">
          {label}
          {isSet ? <Badge color="green">Set{source === 'env' ? ' (from .env)' : ''}</Badge> : <Badge color="amber">Not set</Badge>}
        </span>
      }
      hint={hint || 'Stored encrypted. It is never shown again after saving.'}
    >
      {canEdit ? (
        <div className="flex gap-2">
          <Input type="password" autoComplete="new-password" value={value} placeholder={isSet ? '•••••••• (enter a new value to replace)' : 'Paste value'} onChange={(e) => setValue(e.target.value)} />
          <Button variant="secondary" disabled={!value} loading={saving} onClick={() => save(value)}>
            Save
          </Button>
          {isSet && source === 'settings' && (
            <Button variant="ghost" onClick={() => save(null)} disabled={saving}>
              Clear
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500">Only admins can change this.</p>
      )}
    </Field>
  );
}

/** Local form state for one settings section with a Save button. */
export function useSectionForm(initial) {
  const [form, setForm] = useState(initial || {});
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  return { form, setForm, set };
}

export function SaveBar({ onSave, saving, disabled }) {
  return (
    <div className="flex justify-end border-t border-slate-200 pt-4 dark:border-slate-800">
      <Button onClick={onSave} loading={saving} disabled={disabled}>
        Save changes
      </Button>
    </div>
  );
}
