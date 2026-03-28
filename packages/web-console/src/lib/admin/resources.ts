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
