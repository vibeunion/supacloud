import type { ResourceDefinition } from '@svadmin/core';

export const resources: ResourceDefinition[] = [
  {
    name: 'v1/projects',
    label: 'Projects',
    fields: [
      { key: 'ref', label: 'Reference ID', type: 'text', showInForm: false },
      { key: 'name', label: 'Name', type: 'text', required: true, searchable: true },
      { key: 'status', label: 'Status', type: 'select', options: [
        { label: 'Active', value: 'active' },
        { label: 'Paused', value: 'paused' },
        { label: 'Creating', value: 'creating' }
      ] },
      { key: 'region', label: 'Region', type: 'select', options: [
        { label: 'Local Docker', value: 'local' }
      ] },
      { key: 'db_host', label: 'PostgreSQL Host', type: 'text', showInForm: false },
      { key: 'db_port', label: 'PostgreSQL Port', type: 'number', showInForm: false }
    ],
  },
  {
    name: 'v1/auth/users',
    label: 'Platform Users',
    fields: [
      { key: 'id', label: 'ID', type: 'text', showInForm: false },
      { key: 'username', label: 'Username', type: 'text', required: true, searchable: true },
      { key: 'role', label: 'Role', type: 'select', options: [
        { label: 'Admin', value: 'admin' },
        { label: 'User', value: 'user' }
      ]}
    ]
  }
];

export const getTenantResources = (ref: string): ResourceDefinition[] => [
  {
    name: `v1/projects/${ref}/database/tables`,
    label: 'Tables',
    fields: [
      { key: 'table_name', label: 'Name', type: 'text', required: true, searchable: true },
      { key: 'table_schema', label: 'Schema', type: 'select', showInForm: false },
      { key: 'table_type', label: 'Type', type: 'select', showInForm: false },
      { key: 'row_estimate', label: 'Rows', type: 'number', showInForm: false }
    ]
  },
  {
    name: `v1/projects/${ref}/auth/users`,
    label: 'Users',
    fields: [
      { key: 'id', label: 'UUID', type: 'text', showInForm: false },
      { key: 'email', label: 'Email', type: 'text', required: true, searchable: true },
      { key: 'password', label: 'Password', type: 'text', required: true, showInList: false },
      { key: 'role', label: 'Role', type: 'select', showInForm: false, options: [
        { label: 'Super Admin', value: 'supabase_admin' },
        { label: 'Admin', value: 'supabase_auth_admin' }
      ]},
      { key: 'created_at', label: 'Created At', type: 'date', showInForm: false },
      { key: 'last_sign_in_at', label: 'Last Login', type: 'date', showInForm: false }
    ]
  }
];

export function buildResourceRegistry(projectRefs: string[]): ResourceDefinition[] {
  const uniqueRefs = [...new Set(projectRefs.filter(Boolean))];

  return [
    ...resources,
    ...uniqueRefs.flatMap((ref) => getTenantResources(ref)),
  ];
}
