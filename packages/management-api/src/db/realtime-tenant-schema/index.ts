import { createHash } from "node:crypto";
import { config } from "../../config";

import sql_0 from "./realtime/schema.sql" with { type: "text" };
import sql_1 from "./realtime/types/action.sql" with { type: "text" };
import sql_2 from "./realtime/types/equality_op.sql" with { type: "text" };
import sql_3 from "./realtime/types/user_defined_filter.sql" with { type: "text" };
import sql_4 from "./realtime/types/wal_column.sql" with { type: "text" };
import sql_5 from "./realtime/types/wal_rls.sql" with { type: "text" };
import sql_6 from "./realtime/functions/to_regrole.sql" with { type: "text" };
import sql_7 from "./realtime/functions/cast.sql" with { type: "text" };
import sql_8 from "./realtime/functions/wal2json_escape_identifier.sql" with { type: "text" };
import sql_9 from "./realtime/functions/quote_wal2json.sql" with { type: "text" };
import sql_10 from "./realtime/functions/check_equality_op.sql" with { type: "text" };
import sql_11 from "./realtime/functions/filters_hash.sql" with { type: "text" };
import sql_12 from "./realtime/functions/build_prepared_statement_sql.sql" with { type: "text" };
import sql_13 from "./realtime/functions/is_visible_through_filters.sql" with { type: "text" };
import sql_14 from "./realtime/functions/subscription_check_filters.sql" with { type: "text" };
import sql_15 from "./realtime/tables/messages.sql" with { type: "text" };
import sql_16 from "./realtime/tables/subscription.sql" with { type: "text" };
import sql_17 from "./realtime/functions/apply_rls.sql" with { type: "text" };
import sql_18 from "./realtime/functions/list_changes.sql" with { type: "text" };
import sql_19 from "./realtime/functions/authorize.sql" with { type: "text" };
import sql_20 from "./realtime/functions/broadcast_changes.sql" with { type: "text" };
import sql_21 from "./realtime/functions/send.sql" with { type: "text" };
import sql_22 from "./realtime/functions/send_binary.sql" with { type: "text" };
import sql_23 from "./realtime/functions/topic.sql" with { type: "text" };
import sql_24 from "./realtime/functions/settled_changes.sql" with { type: "text" };
import sql_25 from "./realtime/functions/list_changes_sync.sql" with { type: "text" };

/** Pinned Realtime 2.150.0 tenant schema, same bytes the reconciler hashes. */
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

export const OFFICIAL_REALTIME_APPLY_RLS_SHA256 = "5c4c0651d8afa23b9ee7717e6b5255e122ff27674b525624faa97e6fbef0fb64";
export const OFFICIAL_REALTIME_LIST_CHANGES_SHA256 = "24bcf1dbb76f5fc40c2fcc4650b15b5d0b5528fb86fb651e1e6efb94cda31f92";

const LIST_CHANGES_PROBE =
  "SELECT to_regprocedure('realtime.list_changes(name,name,integer,integer)') IS NOT NULL AS present";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * SQL that installs the pinned tenant schema.
 * `supabase.sql` already created the realtime schema, so the official
 * `CREATE SCHEMA` statement is not repeated.
 */
export function officialRealtimeTenantSchemaSql(): string {
  return OFFICIAL_REALTIME_TENANT_SCHEMA_FILES.map(([path, sql]) => {
    const body = path.endsWith("/schema.sql")
      ? sql.replace(/^create schema\s+"realtime"[\s\S]*?;\s*/i, "-- realtime schema already exists\n")
      : sql;
    return `-- ${path}\n${body.trim()}\n`;
  }).join("\n");
}

type SchemaClient = {
  unsafe(query: string): Promise<Array<{ present?: boolean }>>;
};

/**
 * Install the official realtime tenant objects when the Rust gateway is the
 * Realtime server. Elixir's own migrations remain the installer when
 * `SUPACLOUD_REALTIME_ENGINE=container`. A database that already has
 * `realtime.list_changes` is left alone.
 */
export async function ensureOfficialRealtimeTenantSchema(sql: SchemaClient): Promise<boolean> {
  if (config.realtimeEngine === "container") return false;
  const rows = await sql.unsafe(LIST_CHANGES_PROBE);
  if (rows[0]?.present === true) return false;
  await sql.unsafe(officialRealtimeTenantSchemaSql());
  return true;
}
