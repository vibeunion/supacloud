import type { SQL } from "bun";
import { sql } from "../db";
import { parseProjectAuthRows, ProjectAuthContextError } from "../utils/project-auth-record";
import { revealProjectSecrets } from "./project-secret-at-rest";

export async function findProjectAuthRecord(ref: string, database: SQL = sql) {
  try {
    const rows: unknown = await database`
      SELECT ref, config, organization_id, jwt_secret, jwt_secret_encrypted
      FROM projects
      WHERE ref = ${ref} AND deleted_at IS NULL
    `;
    const revealed = Array.isArray(rows)
      ? rows.map((row) => row && typeof row === "object" ? revealProjectSecrets(row) : row)
      : rows;
    return parseProjectAuthRows(revealed, ref);
  } catch {
    throw new ProjectAuthContextError();
  }
}

export const projectAuthRepository = { findByRef: findProjectAuthRecord };
