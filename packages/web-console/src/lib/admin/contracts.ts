import { Type, type Static, type TSchema } from 'typebox';
import type { ResourceContract } from '@svadmin/core/resource-contract';
import type { TableColumnMetadata } from './resources';
import { defineSvadminResource, type SvadminResourceContract } from './svadmin-contract';

/**
 * SVAdmin 0.54+ requires a runtime contract for every resource consumed by
 * schema-bound UI components (AutoTable). SupaCloud serves genuine multi-tenant
 * resources whose names are derived from the active project, so contracts are
 * created lazily and memoized per resource identity to keep query caches stable.
 *
 * The matching DataProvider projects records to the contract keys before the
 * strict record decoder runs; see `provider.ts`.
 */
const contracts = new Map<string, ResourceContract>();

function memoContract<S extends ResourceContract>(cache: Map<string, S>, key: string, build: () => S): S {
  const existing = cache.get(key);
  if (existing) return existing;
  const contract = build();
  cache.set(key, contract);
  return contract;
}

const nullableText = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const tenantTablesRecordSchema = Type.Object({
  id: Type.String(),
  table_name: Type.String(),
  table_schema: Type.String(),
  table_type: Type.String(),
  row_estimate: Type.Union([Type.Number(), Type.String()]),
});
const tenantAuthUsersRecordSchema = Type.Object({
  id: Type.String(),
  email: nullableText,
  role: nullableText,
  created_at: nullableText,
  last_sign_in_at: nullableText,
});
export type TenantTableRecord = Static<typeof tenantTablesRecordSchema>;
export type TenantAuthUserRecord = Static<typeof tenantAuthUsersRecordSchema>;
type TenantTablesContract = SvadminResourceContract<typeof tenantTablesRecordSchema>;
type TenantAuthUsersContract = SvadminResourceContract<typeof tenantAuthUsersRecordSchema>;
const tableContracts = new Map<string, TenantTablesContract>();
const authUserContracts = new Map<string, TenantAuthUsersContract>();

export function tenantTablesContract(projectRef: string): TenantTablesContract {
  const name = `v1/projects/${projectRef}/database/tables`;
  return memoContract(tableContracts, name, () => defineSvadminResource(name, {
    record: tenantTablesRecordSchema,
  }));
}

export function tenantAuthUsersContract(projectRef: string): TenantAuthUsersContract {
  const name = `v1/projects/${projectRef}/auth/users`;
  return memoContract(authUserContracts, name, () => defineSvadminResource(name, {
    record: tenantAuthUsersRecordSchema,
  }));
}

function databaseValueSchema(): TSchema {
  return Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
  ]);
}

export function tableRowsContract(
  resourceName: string,
  columns: readonly TableColumnMetadata[],
): ResourceContract {
  const signature = columns.map((column) => column.column_name).join(',');
  return memoContract(contracts, `${resourceName}|${signature}`, () => {
    const properties: Record<string, TSchema> = {
      id: Type.String(),
    };
    for (const column of columns) {
      // The contract id is always the row identity; a physical `id` column is
      // projected through idFrom instead of relaxing the required schema.
      if (column.column_name === 'id') continue;
      properties[column.column_name] = Type.Optional(databaseValueSchema());
    }
    return defineSvadminResource(resourceName, { record: Type.Object(properties) });
  });
}

/** Metadata is JSON-serialized into query keys, so projection stays plain data. */
export interface ContractProjectionMeta {
  contractKeys: string[];
  idFrom?: string;
  stringifyComplex?: boolean;
}
