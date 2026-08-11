import type { FieldDefinition, ResourceDefinition } from '@svadmin/core';

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

export interface TableColumnMetadata {
  column_name: string;
  data_type: string;
  is_nullable: string | boolean;
  column_default: unknown;
  udt_name?: string;
  is_primary_key?: boolean;
  primary_key_position?: number | null;
}

export interface BuildTableRowsResourceInput {
  projectRef: string;
  schema: string;
  tableName: string;
  columns: readonly TableColumnMetadata[];
}

const TABLE_ROW_ID_PREFIX = '__svadmin_row_id';

const numericTypes = new Set([
  'smallint',
  'integer',
  'bigint',
  'decimal',
  'numeric',
  'real',
  'double precision',
  'smallserial',
  'serial',
  'bigserial',
]);

function fieldTypeForDatabaseType(dataType: string): FieldDefinition['type'] {
  const normalized = dataType.toLowerCase();
  if (numericTypes.has(normalized)) return 'number';
  if (normalized === 'boolean') return 'boolean';
  if (normalized === 'json' || normalized === 'jsonb') return 'json';
  if (normalized === 'array' || normalized.endsWith('[]')) return 'array';
  if (normalized === 'date' || normalized.includes('time')) return 'date';
  return 'text';
}

function isRequiredColumn(value: string | boolean): boolean {
  return value === false || String(value).toUpperCase() === 'NO';
}

function syntheticTableRowIdentityKey(columns: readonly TableColumnMetadata[]): string {
  const columnNames = new Set(columns.map((column) => column.column_name));
  let candidate = TABLE_ROW_ID_PREFIX;
  while (columnNames.has(candidate)) candidate += '_';
  return candidate;
}

function encodeResourceSegment(value: string): string {
  return encodeURIComponent(value);
}

export function tableRowsRouteParams(
  projectRef: string,
  schema: string,
  tableName: string,
): { ref: string; schema: string; table_name: string } {
  return {
    ref: encodeResourceSegment(projectRef),
    schema: encodeResourceSegment(schema),
    table_name: encodeResourceSegment(tableName),
  };
}

export function tableRowsResourceName(projectRef: string, schema: string, tableName: string): string {
  return [
    'v1/projects',
    encodeResourceSegment(projectRef),
    'database/tables',
    encodeResourceSegment(schema),
    encodeResourceSegment(tableName),
    'rows',
  ].join('/');
}

export function tableColumnsEndpoint(projectRef: string, schema: string, tableName: string): string {
  return `/${[
    'v1/projects',
    encodeResourceSegment(projectRef),
    'database/tables',
    encodeResourceSegment(schema),
    encodeResourceSegment(tableName),
    'columns',
  ].join('/')}`;
}

export function parseTableColumnsResponse(payload: unknown): TableColumnMetadata[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid table columns response');
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) throw new Error('Invalid table columns response');

  return data.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Invalid table column metadata');
    }
    const column = candidate as Record<string, unknown>;
    if (
      typeof column.column_name !== 'string'
      || column.column_name.length === 0
      || typeof column.data_type !== 'string'
      || column.data_type.length === 0
      || (typeof column.is_nullable !== 'string' && typeof column.is_nullable !== 'boolean')
    ) {
      throw new Error('Invalid table column metadata');
    }

    return {
      column_name: column.column_name,
      data_type: column.data_type,
      is_nullable: column.is_nullable,
      column_default: column.column_default ?? null,
      ...(typeof column.udt_name === 'string' ? { udt_name: column.udt_name } : {}),
      ...(typeof column.is_primary_key === 'boolean' ? { is_primary_key: column.is_primary_key } : {}),
      ...(typeof column.primary_key_position === 'number' || column.primary_key_position === null
        ? { primary_key_position: column.primary_key_position }
        : {}),
    };
  });
}

export function buildTableRowsResource({
  projectRef,
  schema,
  tableName,
  columns,
}: BuildTableRowsResourceInput): ResourceDefinition {
  const primaryKeyColumns = columns.filter((column) => column.is_primary_key === true);
  const usesSyntheticIdentity = primaryKeyColumns.length !== 1;
  const identityKey = usesSyntheticIdentity
    ? syntheticTableRowIdentityKey(columns)
    : primaryKeyColumns[0]!.column_name;
  const fields: FieldDefinition[] = columns.map((column) => ({
    key: column.column_name,
    label: column.column_name,
    type: fieldTypeForDatabaseType(column.data_type),
    required: isRequiredColumn(column.is_nullable),
    showInList: true,
    showInForm: false,
  }));

  if (usesSyntheticIdentity) {
    fields.push({
      key: identityKey,
      label: 'Row',
      type: 'text',
      required: false,
      showInList: false,
      showInForm: false,
    });
  }

  return {
    name: tableRowsResourceName(projectRef, schema, tableName),
    label: `${schema}.${tableName}`,
    primaryKey: identityKey,
    fields,
    canCreate: false,
    canEdit: false,
    canDelete: false,
    canShow: false,
    showInMenu: false,
    ...(usesSyntheticIdentity
      ? { provider: { meta: { tableRowIdentityKey: identityKey } } }
      : {}),
  };
}

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
