export interface RlsPolicy {
  policyname: string;
  tablename: string;
  schemaname: string;
  cmd: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL";
  roles: string | null;
  permissive: "PERMISSIVE" | "RESTRICTIVE";
  qual: string | null;
}

export function parseRlsPolicies(rows: readonly Record<string, unknown>[]): RlsPolicy[] {
  return rows.map((row) => {
    const { policyname, tablename, schemaname, cmd, roles, permissive, qual } = row;
    if (typeof policyname !== "string" || typeof tablename !== "string" || typeof schemaname !== "string"
      || (cmd !== "SELECT" && cmd !== "INSERT" && cmd !== "UPDATE" && cmd !== "DELETE" && cmd !== "ALL")
      || (typeof roles !== "string" && roles !== null) || (typeof qual !== "string" && qual !== null)
      || (permissive !== "PERMISSIVE" && permissive !== "RESTRICTIVE")) {
      throw new Error("Invalid RLS policy response");
    }
    return { policyname, tablename, schemaname, cmd, roles, permissive, qual };
  });
}

export function parsePolicyNames(rows: readonly Record<string, unknown>[], field: "tablename" | "rolname"): string[] {
  return rows.map((row) => {
    const value = row[field];
    if (typeof value !== "string") throw new Error("Invalid RLS metadata response");
    return value;
  });
}
