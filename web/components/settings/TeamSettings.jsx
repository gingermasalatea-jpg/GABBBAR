'use client';

import { useState } from 'react';
import { patch, post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { Async, Badge, Button, Card, Field, Input, Modal, Select, Table, useToast } from '@/components/ui';

export default function TeamSettings() {
  const { user: me, can } = useAuth();
  const toast = useToast();
  const users = useApi('/users');
  const perms = useApi('/users/permissions');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const canManage = can('users.manage');
  const roles = perms.data?.roles || [];
  const assignable = roles.filter((r) => can('users.manage_admins') || !['admin', 'super_admin'].includes(r));

  const save = async () => {
    setSaving(true);
    try {
      if (form.id) {
        const body = { name: form.name, role: form.role };
        if (form.password) body.password = form.password;
        await patch(`/users/${form.id}`, body);
      } else {
        await post('/users', form);
      }
      toast('Team member saved');
      setForm(null);
      users.reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (u) => {
    try {
      await patch(`/users/${u.id}`, { is_active: !u.is_active });
      users.reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="space-y-5">
      <Card title="Team members" actions={canManage && <Button size="sm" onClick={() => setForm({ name: '', email: '', role: 'agent', password: '' })}>Add member</Button>}>
        <Async loading={users.loading} error={users.error} onRetry={users.reload} empty={!users.data?.users?.length} emptyProps={{ title: 'No team members' }}>
          <Table
            rows={users.data?.users || []}
            columns={[
              { key: 'name', label: 'Name', render: (u) => <div><div className="font-medium">{u.name}{u.id === me.id && ' (you)'}</div><div className="text-xs text-slate-500">{u.email}</div></div> },
              { key: 'role', label: 'Role', render: (u) => <Badge color={u.role === 'super_admin' ? 'purple' : u.role === 'admin' ? 'blue' : u.role === 'agent' ? 'green' : 'gray'}>{perms.data?.roleLabels?.[u.role] || u.role}</Badge> },
              { key: 'status', label: 'Status', render: (u) => (u.is_active ? <Badge color="green">Active</Badge> : <Badge>Deactivated</Badge>) },
              { key: 'last', label: 'Last login', render: (u) => <span className="text-xs text-slate-500">{fmtDateTime(u.last_login_at)}</span> },
              {
                key: 'actions',
                label: '',
                render: (u) =>
                  canManage && u.id !== me.id ? (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setForm({ ...u, password: '' })}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => toggleActive(u)}>{u.is_active ? 'Deactivate' : 'Activate'}</Button>
                    </div>
                  ) : null,
              },
            ]}
          />
        </Async>
      </Card>

      <Card title="Permission matrix">
        <Async loading={perms.loading} error={perms.error} onRetry={perms.reload}>
          {perms.data && (
            <div className="scroll-thin overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr>
                    <th className="px-2 py-2 text-left font-semibold">Permission</th>
                    {perms.data.roles.map((r) => (
                      <th key={r} className="px-2 py-2 text-center font-semibold">{perms.data.roleLabels[r]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {Object.entries(perms.data.permissions).map(([p, label]) => (
                    <tr key={p}>
                      <td className="px-2 py-1.5">{label} <span className="text-slate-400">({p})</span></td>
                      {perms.data.roles.map((r) => (
                        <td key={r} className="px-2 py-1.5 text-center">{perms.data.matrix[r].includes(p) ? '✅' : '—'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
      </Card>

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit team member' : 'Add team member'}
        footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button onClick={save} loading={saving}>Save</Button></>}
      >
        {form && (
          <div className="space-y-4">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            {!form.id && <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>}
            <Field label="Role">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {assignable.map((r) => <option key={r} value={r}>{perms.data?.roleLabels?.[r] || r}</option>)}
              </Select>
            </Field>
            <Field label={form.id ? 'New password (optional)' : 'Password'} hint="At least 10 characters with upper and lower case letters and a number.">
              <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
