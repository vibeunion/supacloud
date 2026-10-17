/**
 * Role guardrails: application roles may use approved DML/RPC paths but must
 * not own or create schema objects. Migration roles remain separately managed.
 */

import type { QueryExecutor } from './catalog.js';

export interface DatabaseRoleGuardOptions {
  applicationRole: string;
  migrationRole: string;
  database: string;
  schemas?: readonly string[];
}

export interface DatabaseRoleState {
  role: string;
  superuser: boolean;
  createDatabase: boolean;
  createRole: boolean;
  replication: boolean;
  bypassRls: boolean;
  databaseCreate: boolean;
  schemaCreate: Record<string, boolean>;
  ownedRelations: string[];
  ownedObjects: string[];
  reachableRoles: string[];
}

interface RoleRow {
  role: string;
  superuser: boolean;
  create_database: boolean;
  create_role: boolean;
  replication: boolean;
  bypass_rls: boolean;
  database_create: boolean;
}

interface OwnershipRow {
  schema: string;
  name: string;
}

const ROLE_SQL = `
SELECT current_user AS role,
       bool_or(r.rolsuper) AS superuser,
       bool_or(r.rolcreatedb) AS create_database,
       bool_or(r.rolcreaterole) AS create_role,
       bool_or(r.rolreplication) AS replication,
       bool_or(r.rolbypassrls) AS bypass_rls,
       bool_or(has_database_privilege(r.oid, current_database(), 'CREATE')) AS database_create,
       array_agg(r.rolname ORDER BY r.rolname) AS reachable_roles
FROM pg_roles r
WHERE pg_has_role(current_user, r.oid, 'MEMBER')
`;

const SCHEMA_PRIVILEGE_SQL = `
SELECT nspname AS schema,
       EXISTS(SELECT FROM pg_roles r
         WHERE pg_has_role(current_user, r.oid, 'MEMBER')
           AND has_schema_privilege(r.oid, n.oid, 'CREATE')) AS can_create
FROM pg_namespace n
WHERE n.nspname = ANY($1)
ORDER BY nspname
`;

const OWNERSHIP_SQL = `
SELECT n.nspname AS schema, c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE pg_has_role(current_user, c.relowner, 'MEMBER')
  AND n.nspname = ANY($1)
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
ORDER BY n.nspname, c.relname
`;

const OWNED_OBJECTS_SQL = `
SELECT 'schema:' || n.nspname AS object FROM pg_namespace n
WHERE n.nspname = ANY($1) AND pg_has_role(current_user, n.nspowner, 'MEMBER')
UNION ALL
SELECT 'function:' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname = ANY($1) AND pg_has_role(current_user, p.proowner, 'MEMBER')
UNION ALL
SELECT 'type:' || n.nspname || '.' || t.typname
FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
WHERE n.nspname = ANY($1) AND pg_has_role(current_user, t.typowner, 'MEMBER')
UNION ALL
SELECT 'database:' || datname FROM pg_database
WHERE datname=current_database() AND pg_has_role(current_user, datdba, 'MEMBER')
`;

function identifier(value: string, label: string): string {
  if (!/^[a-z_][a-z0-9_$]*$/i.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function normalizeOptions(options: DatabaseRoleGuardOptions): Required<DatabaseRoleGuardOptions> {
  const schemas = [...new Set((options.schemas ?? ['public']).map((schema) => identifier(schema, 'schema')))].sort();
  if (!schemas.length) throw new Error('Select at least one schema');
  return {
    applicationRole: identifier(options.applicationRole, 'application role'),
    migrationRole: identifier(options.migrationRole, 'migration role'),
    database: identifier(options.database, 'database'),
    schemas,
  };
}

export async function readDatabaseRole(
  executor: QueryExecutor,
  schemas: readonly string[] = ['public'],
): Promise<DatabaseRoleState> {
  const normalizedSchemas = normalizeOptions({
    applicationRole: 'application_role',
    migrationRole: 'migration_role',
    database: 'application_database',
    schemas,
  }).schemas;
  const [roles, schemaRows, ownership, objects] = await Promise.all([
    executor.query<RoleRow & { reachable_roles: string[] }>(ROLE_SQL),
    executor.query<{ schema: string; can_create: boolean }>(SCHEMA_PRIVILEGE_SQL, [normalizedSchemas]),
    executor.query<OwnershipRow>(OWNERSHIP_SQL, [normalizedSchemas]),
    executor.query<{ object: string }>(OWNED_OBJECTS_SQL, [normalizedSchemas]),
  ]);
  const role = roles[0];
  if (!role || typeof role.role !== 'string' || !role.role
    || [role.superuser, role.create_database, role.create_role, role.replication, role.bypass_rls, role.database_create]
      .some((value) => typeof value !== 'boolean')
    || !Array.isArray(role.reachable_roles) || !role.reachable_roles.length
    || !role.reachable_roles.every((value) => typeof value === 'string')
    || schemaRows.some((row) => typeof row.schema !== 'string' || typeof row.can_create !== 'boolean')
    || ownership.some((row) => typeof row.schema !== 'string' || typeof row.name !== 'string')
    || objects.some((row) => typeof row.object !== 'string')) {
    throw new Error('Unable to inspect current PostgreSQL role');
  }
  if (normalizedSchemas.some((schema) => !schemaRows.some((row) => row.schema === schema))) {
    throw new Error('Unable to inspect every selected schema');
  }
  return {
    role: role.role,
    superuser: role.superuser,
    createDatabase: role.create_database,
    createRole: role.create_role,
    replication: role.replication,
    bypassRls: role.bypass_rls,
    databaseCreate: role.database_create,
    schemaCreate: Object.fromEntries(normalizedSchemas.map((schema) => [
      schema,
      schemaRows.find((row) => row.schema === schema)?.can_create ?? false,
    ])),
    ownedRelations: ownership.map((row) => `${row.schema}.${row.name}`),
    ownedObjects: objects.map((row) => row.object).sort(),
    reachableRoles: role.reachable_roles,
  };
}

export function assertApplicationRoleRestricted(
  state: DatabaseRoleState,
): void {
  const reasons = [
    state.superuser ? 'superuser' : null,
    state.createDatabase ? 'createdb' : null,
    state.createRole ? 'createrole' : null,
    state.replication ? 'replication' : null,
    state.bypassRls ? 'bypassrls' : null,
    state.databaseCreate ? 'database CREATE privilege' : null,
    ...Object.entries(state.schemaCreate)
      .filter(([, allowed]) => allowed)
      .map(([schema]) => `schema ${schema} CREATE privilege`),
    ...state.ownedRelations.map((relation) => `owned relation ${relation}`),
    ...state.ownedObjects.map((object) => `owned object ${object}`),
  ].filter((reason): reason is string => reason !== null);
  if (reasons.length > 0) {
    throw new Error(`Application database role is not DDL-restricted: ${reasons.join(', ')}`);
  }
}

export function renderDatabaseRoleGuardSql(options: DatabaseRoleGuardOptions): string {
  const normalized = normalizeOptions(options);
  if (normalized.applicationRole === normalized.migrationRole) throw new Error('Application and migration roles must differ');
  const lines = [
    '-- Review and apply through privileged provisioning, never during a request.',
    `ALTER ROLE "${normalized.applicationRole}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    `REVOKE CREATE ON DATABASE "${normalized.database}" FROM PUBLIC, "${normalized.applicationRole}";`,
    `REVOKE "${normalized.migrationRole}" FROM "${normalized.applicationRole}";`,
    '-- PUBLIC function EXECUTE is a global default; schema-level REVOKE alone cannot remove it.',
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${normalized.migrationRole}" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`,
  ];
  for (const schema of normalized.schemas) {
    lines.push(`REVOKE CREATE ON SCHEMA "${schema}" FROM PUBLIC, "${normalized.applicationRole}";`);
    lines.push(`ALTER DEFAULT PRIVILEGES FOR ROLE "${normalized.migrationRole}" IN SCHEMA "${schema}" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`);
  }
  lines.push('-- Keep approved DML/RPC grants explicit; this script does not revoke them.');
  lines.push('-- Transfer existing ownership to the migration role and remove other privileged memberships explicitly.');
  lines.push('-- Recheck using the application connection; review callable SECURITY DEFINER functions separately.');
  return `${lines.join('\n')}\n`;
}
