/** Role-based permission matrix. Single source of truth for API and UI. */

export const ROLES = ['super_admin', 'admin', 'agent', 'viewer'];

export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  agent: 'Agent',
  viewer: 'Viewer',
};

export const PERMISSIONS = {
  'inbox.view': 'View conversations',
  'inbox.reply': 'Reply to customers',
  'inbox.assign': 'Assign conversations',
  'inbox.takeover': 'Take over from AI',
  'inbox.view_all': 'See conversations assigned to others',
  'notes.write': 'Write internal notes',
  'contacts.view': 'View contacts',
  'contacts.edit': 'Create / edit contacts',
  'contacts.delete': 'Delete & merge contacts',
  'contacts.import': 'Import / export CSV',
  'templates.view': 'View templates',
  'templates.manage': 'Create & submit templates',
  'broadcasts.view': 'View broadcasts',
  'broadcasts.manage': 'Create & send broadcasts',
  'automations.view': 'View automations',
  'automations.manage': 'Edit automations & flows',
  'ai.view_logs': 'View AI logs',
  'ai.manage': 'Configure AI & knowledge',
  'tickets.view': 'View tickets',
  'tickets.manage': 'Update tickets',
  'analytics.view': 'View analytics',
  'settings.view': 'View settings',
  'settings.manage': 'Change settings',
  'settings.secrets': 'Set tokens & API keys',
  'send_live.toggle': 'Turn "Send live" on/off',
  'connectors.manage': 'Manage Sheets, webhooks, API keys',
  'users.manage': 'Manage team members',
  'users.manage_admins': 'Manage admins & super admins',
  'audit.view': 'View audit log',
  'dlq.manage': 'Inspect & retry failed jobs',
};

const ALL = Object.keys(PERMISSIONS);

const AGENT = [
  'inbox.view',
  'inbox.reply',
  'inbox.assign',
  'inbox.takeover',
  'notes.write',
  'contacts.view',
  'contacts.edit',
  'templates.view',
  'broadcasts.view',
  'automations.view',
  'tickets.view',
  'tickets.manage',
  'analytics.view',
];

const VIEWER = [
  'inbox.view',
  'inbox.view_all',
  'contacts.view',
  'templates.view',
  'broadcasts.view',
  'automations.view',
  'tickets.view',
  'analytics.view',
  'settings.view',
];

export const MATRIX = {
  super_admin: ALL,
  admin: ALL.filter((p) => p !== 'users.manage_admins'),
  agent: AGENT,
  viewer: VIEWER,
};

export function can(role, permission) {
  return Boolean(MATRIX[role]?.includes(permission));
}

export function permissionsFor(role) {
  return [...(MATRIX[role] || [])];
}

/** An admin may manage agents/viewers; only super admins may create or edit admins/super admins. */
export function canManageRole(actorRole, targetRole) {
  if (!can(actorRole, 'users.manage')) return false;
  if (targetRole === 'super_admin' || targetRole === 'admin') return can(actorRole, 'users.manage_admins');
  return true;
}
