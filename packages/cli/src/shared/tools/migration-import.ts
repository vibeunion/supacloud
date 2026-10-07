import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface MigrationImportFile {
  file: string;
  name: string;
  sql: string;
  source: "sql" | "hasura-metadata" | "hasura-application-review" | "nhost";
}

export interface MigrationImportPlan {
  source: "hasura" | "nhost";
  files: MigrationImportFile[];
  warnings: string[];
  compatibility: {
    supabase_migrations: true;
    pg_graphql: "preserved";
    rls: "manual_review";
  };
}

export async function writeMigrationImportPlan(
  plan: MigrationImportPlan,
  outputDirectory: string,
): Promise<string[]> {
  if (!outputDirectory.trim()) throw new Error("Migration import output directory is required");
  await mkdir(outputDirectory, { recursive: true });
  const written: string[] = [];
  for (const file of plan.files) {
    if (!/^[A-Za-z0-9_.-]+\.sql$/.test(file.file) || file.file.includes("..")) {
      throw new Error(`Unsafe migration import filename: ${file.file}`);
    }
    const path = join(outputDirectory, file.file);
    await writeFile(path, file.sql, { flag: "wx", encoding: "utf8" });
    written.push(path);
  }
  return written;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sqlFile(file: string, root: string, source: "hasura" | "nhost"): MigrationImportFile {
  return {
    file,
    name: basename(file, ".sql"),
    sql: readFileSync(join(root, file), "utf8"),
    source: "sql",
  };
}

function hasuraMetadataSql(input: Record<string, unknown>): string[] {
  const metadata = record(input.metadata) ?? input;
  const sources = Array.isArray(metadata.sources) ? metadata.sources : [];
  const sql: string[] = [];
  for (const rawSource of sources) {
    const source = record(rawSource);
    if (!source) continue;
    const tables = Array.isArray(source.tables) ? source.tables : [];
    for (const rawTable of tables) {
      const table = record(rawTable);
      const tableName = record(table?.table);
      const schema = typeof tableName?.schema === "string" ? tableName.schema : "public";
      const name = typeof tableName?.name === "string" ? tableName.name : null;
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      sql.push(`ALTER TABLE "${schema}"."${name}" ENABLE ROW LEVEL SECURITY;`);
    }
  }
  return sql;
}

function reviewSql(input: {
  actions: unknown[];
  remoteSchemas: unknown[];
  eventTriggers: unknown[];
}): string {
  const lines = [
    "-- SUPACLOUD IMPORT REVIEW ONLY",
    "-- This file is documentation generated from Hasura metadata.",
    "-- It intentionally contains no executable DDL or DML.",
    "-- Convert each reviewed item into a SupaCloud Function, Event, or application resource.",
  ];
  const append = (kind: string, value: unknown) => {
    const json = JSON.stringify(value, null, 2);
    for (const line of json.split("\n")) lines.push(`-- ${kind}: ${line}`);
  };
  for (const action of input.actions) append("Hasura Action", action);
  for (const remoteSchema of input.remoteSchemas) append("Hasura Remote Schema", remoteSchema);
  for (const eventTrigger of input.eventTriggers) append("Hasura Event Trigger", eventTrigger);
  return `${lines.join("\n")}\n`;
}

export function createMigrationImportPlan(input: {
  source: "hasura" | "nhost";
  directory?: string;
  metadata?: unknown;
}): MigrationImportPlan {
  const files: MigrationImportFile[] = [];
  const warnings: string[] = [];
  const root = input.directory;
  if (root && existsSync(root) && statSync(root).isDirectory()) {
    for (const file of readdirSync(root).filter(candidate => candidate.endsWith(".sql")).sort()) {
      files.push(sqlFile(file, root, input.source));
    }
  }
  if (input.source === "hasura" && input.metadata !== undefined) {
    const metadata = record(input.metadata) ?? {};
    const generated = hasuraMetadataSql(metadata);
    if (generated.length > 0) {
      files.push({ file: "999999999999_hasura_rls_review.sql", name: "hasura_rls_review", sql: `${generated.join("\n")}\n`, source: "hasura-metadata" });
      warnings.push("Hasura permissions were converted to an RLS enablement review file; inspect and author USING/WITH CHECK policies before applying.");
    } else {
      warnings.push("No Hasura table metadata was found; permission rules require manual review.");
    }
    const actions = Array.isArray(metadata.actions) ? metadata.actions : [];
    const remoteSchemas = Array.isArray(metadata.remote_schemas) ? metadata.remote_schemas : [];
    const eventTriggers = Array.isArray(metadata.sources)
      ? metadata.sources.flatMap(source => {
        const sourceRecord = record(source);
        const tables = Array.isArray(sourceRecord?.tables) ? sourceRecord.tables : [];
        return tables.flatMap(table => {
          const tableRecord = record(table);
          return Array.isArray(tableRecord?.event_triggers) ? tableRecord.event_triggers : [];
        });
      })
      : [];
    if (actions.length || remoteSchemas.length || eventTriggers.length) {
      files.push({
        file: "999999999998_hasura_application_review.sql",
        name: "hasura_application_review",
        sql: reviewSql({ actions, remoteSchemas, eventTriggers }),
        source: "hasura-application-review",
      });
      warnings.push("Hasura Actions, Remote Schemas, and event triggers were exported as a review-only artifact; they require explicit SupaCloud Function/Event mapping.");
    } else {
      warnings.push("No Hasura Actions, Remote Schemas, or event triggers were found in metadata.");
    }
  }
  if (input.source === "nhost") {
    warnings.push("Nhost Auth, Storage, and GraphQL settings remain Supabase-compatible platform configuration; only SQL migrations are imported automatically.");
  }
  return {
    source: input.source,
    files,
    warnings,
    compatibility: { supabase_migrations: true, pg_graphql: "preserved", rls: "manual_review" },
  };
}
