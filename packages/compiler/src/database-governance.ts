import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseGovernanceOptions, Diagnostic } from "./types";

export function assertDatabaseGovernance(value: unknown): asserts value is DatabaseGovernanceOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid databaseGovernance configuration.");
  const entry = value as Record<string, unknown>;
  const rpcBoundary = entry["rpcBoundary"];
  const validRpcBoundary = rpcBoundary === undefined || (
    rpcBoundary !== null && typeof rpcBoundary === "object" && !Array.isArray(rpcBoundary)
    && Object.keys(rpcBoundary).every(key => ["registry", "catalog", "legacy"].includes(key))
    && Object.values(rpcBoundary as Record<string, unknown>).length > 0
    && Object.values(rpcBoundary as Record<string, unknown>).every(path =>
      typeof path === "string" && path.trim() !== "" && !path.includes("\\") && !path.startsWith("/"))
  );
  if ((entry["mode"] !== "off" && entry["mode"] !== "check" && entry["mode"] !== "enforce")
    || (entry["ownership"] !== undefined && entry["ownership"] !== "off"
      && entry["ownership"] !== "assist" && entry["ownership"] !== "enforce")
    || Object.keys(entry).some(key => !["mode", "ownership", "projectRoot", "moduleFile", "databaseUrl", "databaseUrlEnv", "schemas", "rpcBoundary"].includes(key))
    || ["projectRoot", "moduleFile", "databaseUrl", "databaseUrlEnv"].some(key =>
      entry[key] !== undefined && (typeof entry[key] !== "string" || !entry[key].trim()))
    || (entry["databaseUrlEnv"] !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(entry["databaseUrlEnv"])))
    || (entry["schemas"] !== undefined && (!Array.isArray(entry["schemas"]) || !entry["schemas"].length
      || !entry["schemas"].every(schema => typeof schema === "string" && schema.trim())))
    || !validRpcBoundary) {
    throw new Error("Invalid databaseGovernance mode, ownership, paths, connection or schemas.");
  }
}

/** A fresh, bounded process avoids stale module imports during incremental compilation. */
export async function checkDatabaseGovernance(
  rootDir: string, value: DatabaseGovernanceOptions | undefined, rpcCapabilities: readonly string[] = [],
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
      child.stdin?.end(JSON.stringify({ options, rpcCapabilities }));
    });
    const report: unknown = JSON.parse(output);
    if (!report || typeof report !== "object" || !("diagnostics" in report) || !Array.isArray(report.diagnostics)) return failure();
    const diagnostics: Diagnostic[] = [];
    for (const item of report.diagnostics as unknown[]) {
      if (!item || typeof item !== "object" || !("code" in item) || typeof item.code !== "string"
        || !item.code.startsWith("database-") || !("message" in item) || typeof item.message !== "string"
        || !("severity" in item) || (item.severity !== "error" && item.severity !== "warn")) return failure();
      const diagnostic: Diagnostic = { severity: item.severity, code: item.code, message: item.message };
      if ("suggestion" in item && item.suggestion !== undefined) {
        if (typeof item.suggestion !== "string") return failure();
        diagnostic.suggestion = item.suggestion;
      }
      if ("evidence" in item && item.evidence !== undefined) {
        if (!Array.isArray(item.evidence)) return failure();
        const evidence: NonNullable<Diagnostic["evidence"]> = [];
        for (const entry of item.evidence as unknown[]) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return failure();
          const value = entry as Record<string, unknown>;
          if (typeof value["kind"] !== "string" || typeof value["detail"] !== "string") return failure();
          const normalized: NonNullable<Diagnostic["evidence"]>[number] = {
            kind: value["kind"] as NonNullable<Diagnostic["evidence"]>[number]["kind"],
            detail: value["detail"],
          };
          if (!["declaration", "grant", "missing-grant", "suggestion"].includes(normalized.kind)) return failure();
          for (const key of ["role", "privilege", "source", "owner"] as const) {
            const item = value[key];
            if (item === undefined) continue;
            if (typeof item !== "string") return failure();
            normalized[key] = item;
          }
          const candidates = value["candidates"];
          if (candidates !== undefined) {
            if (!Array.isArray(candidates) || !candidates.every(candidate => typeof candidate === "string")) return failure();
            normalized.candidates = candidates as string[];
          }
          evidence.push(normalized);
        }
        diagnostic.evidence = evidence;
      }
      diagnostics.push(diagnostic);
    }
    return diagnostics;
  } catch {
    return failure();
  }
}
