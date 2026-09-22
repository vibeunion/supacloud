import { Type, type TSchema } from '@sinclair/typebox';
import { defineResource, type ResourceContract } from '@svadmin/core/resource-contract';
import type { TableColumnMetadata } from './resources';

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

function memoContract(key: string, build: () => ResourceContract): ResourceContract {
  const existing = contracts.get(key);
  if (existing) return existing;
  const contract = build();
  contracts.set(key, contract);
  return contract;
}

const nullableText = Type.Optional(Type.Union([Type.String(), Type.Null()]));

/**
 * Dynamic table schemas cannot satisfy the compile-time `SafeSchema` inference:
 * their property map is built at runtime from live column metadata. The runtime
 * `defineResource` validation still closes and validates the produced schema.
 */
const defineDynamicResource = defineResource as unknown as (
  name: string,
  schemas: { record: TSchema },
) => ResourceContract;

export function tenantTablesContract(projectRef: string): ResourceContract {
  const name = `v1/projects/${projectRef}/database/tables`;
  return memoContract(name, () => defineResource(name, {
    record: Type.Object({
      id: Type.String(),
      table_name: Type.String(),
      table_schema: Type.String(),
      table_type: Type.String(),
      row_estimate: Type.Union([Type.Number(), Type.String()]),
    }),
  }));
}

export function tenantAuthUsersContract(projectRef: string): ResourceContract {
  const name = `v1/projects/${projectRef}/auth/users`;
  return memoContract(name, () => defineResource(name, {
    record: Type.Object({
      id: Type.String(),
      email: nullableText,
      role: nullableText,
      created_at: nullableText,
      last_sign_in_at: nullableText,
    }),
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
  return memoContract(`${resourceName}|${signature}`, () => {
    const properties: Record<string, TSchema> = {
      id: Type.String(),
    };
    for (const column of columns) {
      // The contract id is always the row identity; a physical `id` column is
      // projected through idFrom instead of relaxing the required schema.
      if (column.column_name === 'id') continue;
      properties[column.column_name] = Type.Optional(databaseValueSchema());
    }
    return defineDynamicResource(resourceName, { record: Type.Object(properties) });
  });
}

/** Metadata is JSON-serialized into query keys, so projection stays plain data. */
export interface ContractProjectionMeta {
  contractKeys: string[];
  idFrom?: string;
  stringifyComplex?: boolean;
}