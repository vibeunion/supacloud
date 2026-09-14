export const tableColumnTypes = [
  "bigint",
  "boolean",
  "date",
  "double precision",
  "integer",
  "jsonb",
  "numeric",
  "real",
  "text",
  "time",
  "timestamp",
  "timestamptz",
  "uuid",
] as const;

export type TableColumnType = typeof tableColumnTypes[number];

export interface TableColumnDraft {
  name: string;
  type: TableColumnType;
  nullable: boolean;
  primaryKey?: boolean;
  identity?: boolean;
}

export function initialTableColumns(): TableColumnDraft[] {
  return [{ name: "id", type: "bigint", nullable: false, primaryKey: true, identity: true }];
}

export function tableColumnWithType(column: TableColumnDraft, type: TableColumnType): TableColumnDraft {
  return type === "integer" || type === "bigint"
    ? { ...column, type }
    : { ...column, type, identity: false };
}
