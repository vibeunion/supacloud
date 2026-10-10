/**
 * Reverse adoption: capture the current PostgreSQL structure and governed
 * objects as a reviewable candidate. This is not a migration or source
 * overwrite operation.
 */

import type { DatabaseCatalog, QueryExecutor } from './catalog.js';
import { readCatalog } from './catalog.js';

export interface DatabaseColumn {
  schema: string;
  table: string;
  name: string;
  ordinal: number;
  dataType: string;
  udtSchema: string;
  udtName: string;
  nullable: boolean;
  defaultExpression: string | null;
  identity: 'always' | 'by default' | null;
  generated: 'always' | null;
  generationExpression: string | null;
}

export interface DatabaseReverseTable {
  schema: string;
  name: string;
  columns: DatabaseColumn[];
  rlsEnabled: boolean;
  rlsForced: boolean;
}

export interface DatabaseReverseSnapshot {
  version: 1;
  kind: 'database-reverse-candidate';
  generatedAt: string;
  schemas: string[];
  tables: DatabaseReverseTable[];
  catalog: DatabaseCatalog;
  review: string[];
}

interface ColumnRow {
  schema: string;
  table: string;
  name: string;
  ordinal: number;
  data_type: string;
  udt_schema: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  is_identity: string;
  identity_generation: string | null;
  is_generated: string;
  generation_expression: string | null;
}

const COLUMNS_SQL = `
SELECT table_schema AS schema,
       table_name AS table,
       column_name AS name,
       ordinal_position AS ordinal,
       data_type,
       udt_schema,
       udt_name,
       is_nullable,
       column_default,
       is_identity,
       identity_generation,
       is_generated,
       generation_expression
FROM information_schema.columns
WHERE table_schema = ANY($1)
ORDER BY table_schema, table_name, ordinal_position
`;

function normalizeSchemas(schemas: readonly string[]): string[] {
  const normalized = [...new Set(schemas.map((schema) => schema.trim()).filter(Boolean))].sort();
  if (normalized.length === 0 || normalized.some((schema) => !/^[a-z_][a-z0-9_$]*$/i.test(schema))) {
    throw new TypeError('schemas must contain PostgreSQL identifiers');
  }
  return normalized;
}

function mapColumn(row: ColumnRow): DatabaseColumn {
  return {
    schema: row.schema,
    table: row.table,
    name: row.name,
    ordinal: row.ordinal,
    dataType: row.data_type,
    udtSchema: row.udt_schema,
    udtName: row.udt_name,
    nullable: row.is_nullable === 'YES',
    defaultExpression: row.column_default,
    identity: row.is_identity === 'YES'
      ? row.identity_generation === 'ALWAYS' ? 'always' : 'by default'
      : null,
    generated: row.is_generated === 'ALWAYS' ? 'always' : null,
    generationExpression: row.generation_expression,
  };
}

/**
 * Reads a JSON-serializable adoption candidate from PostgreSQL.
 * The caller still needs to review the candidate and establish a maintained
 * declarative SQL baseline before generating forward migrations.
 */
export async function reverseDatabase(
  executor: QueryExecutor,
  schemas: readonly string[] = ['public'],
  now = new Date(),
): Promise<DatabaseReverseSnapshot> {
  const normalizedSchemas = normalizeSchemas(schemas);
  if (!executor.transaction) throw new Error('Reverse requires a pinned read-only transaction');
  return executor.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return readSnapshot(tx, normalizedSchemas, now);
  });
}

async function readSnapshot(
  executor: QueryExecutor,
  normalizedSchemas: string[],
  now: Date,
): Promise<DatabaseReverseSnapshot> {
  const [catalog, rows] = await Promise.all([
    readCatalog(executor, normalizedSchemas),
    executor.query<ColumnRow>(COLUMNS_SQL, [normalizedSchemas]),
  ]);
  const tables = catalog.tables
    .map((table) => ({
      schema: table.schema,
      name: table.name,
      columns: rows
        .filter((row) => row.schema === table.schema && row.table === table.name)
        .map(mapColumn),
      rlsEnabled: table.rlsEnabled,
      rlsForced: table.rlsForced,
    }))
    .sort((left, right) => `${left.schema}.${left.name}`.localeCompare(`${right.schema}.${right.name}`));

  return {
    version: 1,
    kind: 'database-reverse-candidate',
    generatedAt: now.toISOString(),
    schemas: normalizedSchemas,
    tables,
    catalog,
    review: [
      'This is a catalog candidate, not an approved source-of-truth update.',
      'Review tables and columns before adopting declarative SQL; derive query models from it.',
      'Indexes, constraints, enums, views and function bodies are not represented by this catalog snapshot; use official declarative generate and reviewed SQL sources.',
      'Keep RLS, policies, functions, triggers and grants as maintained SQL declarations.',
      'Create a forward migration after review; do not generate or apply a down migration.',
      'Verify role behavior and application compatibility against the adopted baseline.',
    ],
  };
}

export function renderReverseSnapshot(snapshot: DatabaseReverseSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
