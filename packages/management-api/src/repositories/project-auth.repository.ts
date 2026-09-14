import type { SQL } from "bun";
import { sql } from "../db";
import { parseProjectAuthRows, ProjectAuthContextError } from "../utils/project-auth-record";

export async function findProjectAuthRecord(ref: string, database: SQL = sql) {
  try {
    const rows: unknown = await database`
      SELECT ref, config, organization_id, jwt_secret
      FROM projects
      WHERE ref = ${ref} AND deleted_at IS NULL
    `;
    return parseProjectAuthRows(rows, ref);
  } catch {
    throw new ProjectAuthContextError();
  }
}

export const projectAuthRepository = { findByRef: findProjectAuthRecord };
