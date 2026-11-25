import { config } from "../../config";
import { logger } from "../../utils/logger";
import {
  assertRealtimeTenantSchemaFiles,
  decideRealtimeTenantSchema,
  firstRealtimeTenantSchemaDifference,
  realtimeTenantSchemaInspectionSql,
  realtimeTenantSchemaStateFromRow,
  type RealtimeTenantSchemaArtifact,
} from "./artifact";

import sql_0 from "./2.150.0/realtime/schema.sql" with { type: "text" };
import sql_1 from "./2.150.0/realtime/types/action.sql" with { type: "text" };
import sql_2 from "./2.150.0/realtime/types/equality_op.sql" with { type: "text" };
import sql_3 from "./2.150.0/realtime/types/user_defined_filter.sql" with { type: "text" };
import sql_4 from "./2.150.0/realtime/types/wal_column.sql" with { type: "text" };
import sql_5 from "./2.150.0/realtime/types/wal_rls.sql" with { type: "text" };
import sql_6 from "./2.150.0/realtime/functions/to_regrole.sql" with { type: "text" };
import sql_7 from "./2.150.0/realtime/functions/cast.sql" with { type: "text" };
import sql_8 from "./2.150.0/realtime/functions/wal2json_escape_identifier.sql" with { type: "text" };
import sql_9 from "./2.150.0/realtime/functions/quote_wal2json.sql" with { type: "text" };
import sql_10 from "./2.150.0/realtime/functions/check_equality_op.sql" with { type: "text" };
import sql_11 from "./2.150.0/realtime/functions/filters_hash.sql" with { type: "text" };
import sql_12 from "./2.150.0/realtime/functions/build_prepared_statement_sql.sql" with { type: "text" };
import sql_13 from "./2.150.0/realtime/functions/is_visible_through_filters.sql" with { type: "text" };
import sql_14 from "./2.150.0/realtime/functions/subscription_check_filters.sql" with { type: "text" };
import sql_15 from "./2.150.0/realtime/tables/messages.sql" with { type: "text" };
import sql_16 from "./2.150.0/realtime/tables/subscription.sql" with { type: "text" };
import sql_17 from "./2.150.0/realtime/functions/apply_rls.sql" with { type: "text" };
import sql_18 from "./2.150.0/realtime/functions/list_changes.sql" with { type: "text" };
import sql_19 from "./2.150.0/realtime/functions/authorize.sql" with { type: "text" };
import sql_20 from "./2.150.0/realtime/functions/broadcast_changes.sql" with { type: "text" };
import sql_21 from "./2.150.0/realtime/functions/send.sql" with { type: "text" };
import sql_22 from "./2.150.0/realtime/functions/send_binary.sql" with { type: "text" };
import sql_23 from "./2.150.0/realtime/functions/topic.sql" with { type: "text" };
import sql_24 from "./2.150.0/realtime/functions/settled_changes.sql" with { type: "text" };
import sql_25 from "./2.150.0/realtime/functions/list_changes_sync.sql" with { type: "text" };

export {
  OFFICIAL_REALTIME_APPLY_RLS_SHA256,
  OFFICIAL_REALTIME_LIST_CHANGES_SHA256,
  decideRealtimeTenantSchema,
  realtimeTenantSchemaInspectionSql,
  realtimeTenantSchemaStateFromRow,
  sha256Text,
} from "./artifact";

/**
 * Pinned Realtime 2.150.0 tenant schema. These are the same files
 * `crates/realtime-gateway/tests/cdc.rs` applies from `2.150.0/`, embedded so
 * the compiled Management API carries the bytes the fixture proves.
 */
export const OFFICIAL_REALTIME_TENANT_SCHEMA_FILES: ReadonlyArray<readonly [string, string]> = [
  ["realtime/schema.sql", sql_0],
  ["realtime/types/action.sql", sql_1],
  ["realtime/types/equality_op.sql", sql_2],
  ["realtime/types/user_defined_filter.sql", sql_3],
  ["realtime/types/wal_column.sql", sql_4],
  ["realtime/types/wal_rls.sql", sql_5],
  ["realtime/functions/to_regrole.sql", sql_6],
  ["realtime/functions/cast.sql", sql_7],
  ["realtime/functions/wal2json_escape_identifier.sql", sql_8],
  ["realtime/functions/quote_wal2json.sql", sql_9],
  ["realtime/functions/check_equality_op.sql", sql_10],
  ["realtime/functions/filters_hash.sql", sql_11],
  ["realtime/functions/build_prepared_statement_sql.sql", sql_12],
  ["realtime/functions/is_visible_through_filters.sql", sql_13],
  ["realtime/functions/subscription_check_filters.sql", sql_14],
  ["realtime/tables/messages.sql", sql_15],
  ["realtime/tables/subscription.sql", sql_16],
  ["realtime/functions/apply_rls.sql", sql_17],
  ["realtime/functions/list_changes.sql", sql_18],
  ["realtime/functions/authorize.sql", sql_19],
  ["realtime/functions/broadcast_changes.sql", sql_20],
  ["realtime/functions/send.sql", sql_21],
  ["realtime/functions/send_binary.sql", sql_22],
  ["realtime/functions/topic.sql", sql_23],
  ["realtime/functions/settled_changes.sql", sql_24],
  ["realtime/functions/list_changes_sync.sql", sql_25],
];

let cachedArtifact: RealtimeTenantSchemaArtifact | undefined;

/** Embedded copy of the shared artifact, refused unless every pin matches. */
export function pinnedRealtimeTenantSchemaArtifact(): RealtimeTenantSchemaArtifact {
  cachedArtifact ??= assertRealtimeTenantSchemaFiles(
    OFFICIAL_REALTIME_TENANT_SCHEMA_FILES.map(([path, sql]) => ({ path, sql })),
  );
  return cachedArtifact;
}

/**
 * SQL that installs the pinned tenant schema.
 * `supabase.sql` already created the realtime schema, so the official
 * `CREATE SCHEMA` statement is not repeated. An existing schema is never dropped.
 */
export function officialRealtimeTenantSchemaSql(): string {
  return pinnedRealtimeTenantSchemaArtifact().files.map((file) => {
    const body = file.path.endsWith("/schema.sql")
      ? file.sql.replace(/^create schema\s+"realtime"[\s\S]*?;\s*/i, "-- realtime schema already exists\n")
      : file.sql;
    return `-- ${file.path}\n${body.trim()}\n`;
  }).join("\n");
}

export interface RealtimeSchemaClient {
  unsafe(query: string): Promise<readonly unknown[]>;
}

/**
 * Install the official realtime tenant objects when the Rust gateway is the
 * Realtime server. Elixir's own migrations remain the installer when
 * `SUPACLOUD_REALTIME_ENGINE=container`.
 *
 * An empty schema, or any catalog that is missing `realtime.list_changes`,
 * receives the pinned tree. An exact pin is left untouched. A database that
 * already has `realtime.list_changes` is left untouched as well, including an
 * Elixir-migrated tenant whose functions are not the 2.150.0 bodies. That
 * divergent catalog is logged once: project, pin version, and the first
 * receipt mismatch. Bootstrap still returns without DDL.
 */
export async function ensureOfficialRealtimeTenantSchema(
  sql: RealtimeSchemaClient,
  projectRef = "unknown project",
): Promise<boolean> {
  if (config.realtimeEngine === "container") return false;
  const artifact = pinnedRealtimeTenantSchemaArtifact();
  const rows = await sql.unsafe(realtimeTenantSchemaInspectionSql());
  const state = realtimeTenantSchemaStateFromRow(rows[0]);
  const decision = decideRealtimeTenantSchema(artifact, state);
  if (decision.mode === "leave") {
    const difference = firstRealtimeTenantSchemaDifference(artifact, state)
      ?? "realtime.list_changes is already present";
    logger.warn(
      `[realtime-tenant-schema] ${projectRef} keeps its existing realtime schema; it is not the pinned ${artifact.version} artifact: ${difference}`,
    );
    return false;
  }
  if (decision.mode !== "install") return false;
  await sql.unsafe(officialRealtimeTenantSchemaSql());
  return true;
}
