import type { ResourceDefinition } from '@svadmin/core';

export interface ProjectResourceLabels {
  projects: string;
  referenceId: string;
  projectName: string;
  status: string;
  active: string;
  paused: string;
  creating: string;
  region: string;
  localDocker: string;
  databaseHost: string;
  databasePort: string;
}

export interface TenantResourceLabels {
  tables: string;
  tableName: string;
  schema: string;
  type: string;
  rows: string;
}

export type ResourceLabels = ProjectResourceLabels & TenantResourceLabels;

function getPlatformResources(labels: ProjectResourceLabels): ResourceDefinition[] {
  return [
  {
    name: 'v1/projects',
    label: labels.projects,
    fields: [
      { key: 'ref', label: labels.referenceId, type: 'text', showInForm: false },
      { key: 'name', label: labels.projectName, type: 'text', required: true, searchable: true },
      { key: 'status', label: labels.status, type: 'select', options: [
        { label: labels.active, value: 'active' },
        { label: labels.paused, value: 'paused' },
        { label: labels.creating, value: 'creating' }
      ] },
      { key: 'region', label: labels.region, type: 'select', options: [
        { label: labels.localDocker, value: 'local' }
      ] },
      { key: 'db_host', label: labels.databaseHost, type: 'text', showInForm: false },
      { key: 'db_port', label: labels.databasePort, type: 'number', showInForm: false }
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
}

export const getTenantResources = (ref: string, labels: TenantResourceLabels): ResourceDefinition[] => [
  {
    name: `v1/projects/${ref}/database/tables`,
    label: labels.tables,
    // Table creation uses the dedicated, migration-backed form on the Tables page.
    canCreate: false,
    canEdit: false,
    fields: [
      { key: 'table_name', label: labels.tableName, type: 'text', required: true, searchable: true },
      { key: 'table_schema', label: labels.schema, type: 'select', showInForm: false },
      { key: 'table_type', label: labels.type, type: 'select', showInForm: false },
      { key: 'row_estimate', label: labels.rows, type: 'number', showInForm: false }
    ]
  },
  {
    name: `v1/projects/${ref}/auth/users`,
    label: 'Users',
    // The generic AutoTable routes actions to `/:id` and `/create`; this
    // tenant API is intentionally handled by the dedicated Auth page instead.
    canCreate: false,
    canEdit: false,
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

export function buildResourceRegistry(projectRefs: string[], labels: ResourceLabels): ResourceDefinition[] {
  const uniqueRefs = [...new Set(projectRefs.filter(Boolean))];

  return [
    ...getPlatformResources(labels),
    ...uniqueRefs.flatMap((ref) => getTenantResources(ref, labels)),
  ];
}
