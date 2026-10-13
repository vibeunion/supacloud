import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseGovernanceOptions, Diagnostic } from "./types";

export function assertDatabaseGovernance(value: unknown): asserts value is DatabaseGovernanceOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid databaseGovernance configuration.");
  const entry = value as Record<string, unknown>;
  if ((entry.mode !== "off" && entry.mode !== "enforce")
    || Object.keys(entry).some(key => !["mode", "projectRoot", "moduleFile", "databaseUrl", "databaseUrlEnv", "schemas"].includes(key))
    || ["projectRoot", "moduleFile", "databaseUrl", "databaseUrlEnv"].some(key =>
      entry[key] !== undefined && (typeof entry[key] !== "string" || !entry[key].trim()))
    || (entry.databaseUrlEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(entry.databaseUrlEnv)))
    || (entry.schemas !== undefined && (!Array.isArray(entry.schemas) || !entry.schemas.length
      || !entry.schemas.every(schema => typeof schema === "string" && schema.trim())))) {
    throw new Error("Invalid databaseGovernance mode, paths, connection or schemas.");
  }
}

/** A fresh, bounded process avoids stale module imports during incremental compilation. */
export async function checkDatabaseGovernance(
  rootDir: string, value: DatabaseGovernanceOptions | undefined,
): Promise<Diagnostic[]> {
  if (value === undefined) return [];
  const failure = (): Diagnostic[] => [{
    severity: "error", code: "database-governance",
    message: "Database governance could not be verified. Check configuration, installed @supacloud/db, Bun and read-only database access.",
  }];
  try {
    assertDatabaseGovernance(value);
    if (value.mode === "off") return [];
    const options = { ...value, projectRoot: resolve(rootDir, value.projectRoot ?? ".") };
    const worker = fileURLToPath(new URL(
      import.meta.url.endsWith(".ts") ? "./database-governance-worker.ts" : "./database-governance-worker.js",
      import.meta.url,
    ));
    const output = await new Promise<string>((accept, reject) => {
      const child = execFile(process.versions.bun ? process.execPath : "bun",
        ["--no-env-file", worker], { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
        (error, stdout) => error ? reject(error) : accept(stdout));
      child.stdin?.on("error", reject);
      child.stdin?.end(JSON.stringify(options));
    });
    const report: unknown = JSON.parse(output);
    if (!report || typeof report !== "object" || !("diagnostics" in report) || !Array.isArray(report.diagnostics)) return failure();
    const diagnostics: Diagnostic[] = [];
    for (const item of report.diagnostics as unknown[]) {
      if (!item || typeof item !== "object" || !("code" in item) || typeof item.code !== "string"
        || !item.code.startsWith("database-") || !("message" in item) || typeof item.message !== "string"
        || !("severity" in item) || item.severity !== "error") return failure();
      diagnostics.push({ severity: "error", code: item.code, message: item.message });
    }
    return diagnostics;
  } catch {
    return failure();
  }
}
