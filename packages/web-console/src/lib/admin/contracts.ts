import { Type, type TSchema } from "@sinclair/typebox";
import { defineResource, type ResourceContract } from "@svadmin/core/resource-contract";
import type { TableColumnMetadata } from "./resources";

const contracts = new Map<string, ResourceContract>();

function memoContract(key: string, build: () => ResourceContract): ResourceContract {
  const existing = contracts.get(key);
  if (existing) return existing;
  const contract = build();
  contracts.set(key, contract);
  return contract;
}

const nullableText = Type.Optional(Type.Union([Type.String(), Type.Null()]));

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
  const signature = columns.map((column) => column.column_name).join(",");
  return memoContract(`${resourceName}|${signature}`, () => {
    const properties: Record<string, TSchema> = { id: Type.String() };
    for (const column of columns) {
      if (column.column_name === "id") continue;
      properties[column.column_name] = Type.Optional(databaseValueSchema());
    }
    return defineDynamicResource(resourceName, { record: Type.Object(properties) });
  });
}

export interface ContractProjectionMeta {
  contractKeys: string[];
  idFrom?: string;
  stringifyComplex?: boolean;
}
