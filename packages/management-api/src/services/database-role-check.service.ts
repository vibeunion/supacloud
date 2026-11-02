import type { SQL } from "bun";
import {
  assertApplicationRoleRestricted,
  readDatabaseRole,
  type DatabaseRoleState,
  type QueryExecutor,
} from "@supacloud/db";

/** Inspect the project connection's role boundary without returning its DSN. */
export async function runDatabaseRoleCheck(
  projectDb: Pick<SQL, "unsafe" | "array">,
  schemas: readonly string[],
): Promise<{ ok: boolean; state: DatabaseRoleState; error?: string }> {
  const executor: QueryExecutor = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const values = (params ?? []).map((value) => {
        if (!Array.isArray(value)) return value;
        if (!value.every((item): item is string => typeof item === "string")) {
          throw new Error("Role catalog schema parameters must be strings");
        }
        return projectDb.array(value, "TEXT");
      });
      return await projectDb.unsafe(sql, values) as T[];
    },
  };
  const state = await readDatabaseRole(executor, schemas);
  try {
    assertApplicationRoleRestricted(state);
    return { ok: true, state };
  } catch (error: unknown) {
    return {
      ok: false,
      state,
      error: error instanceof Error ? error.message : "Application database role is not DDL-restricted",
    };
  }
}
