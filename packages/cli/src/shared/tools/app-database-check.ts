import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AppDatabaseCheck {
  name: "database-source-contracts";
  ok: boolean;
  detail: string;
}

const CHECK_ENTRY = `
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[1];
const cli = createRequire(join(root, "package.json")).resolve("@supacloud/db/source-contracts-cli");
process.argv = [process.execPath, cli, "check", "--root", root];
await import(pathToFileURL(cli).href);
`;

/** Use the project's installed tool, not arbitrary package scripts or remote database access. */
export function checkAppDatabaseSources(projectRoot: string): AppDatabaseCheck | undefined {
  const root = resolve(projectRoot);
  if (!existsSync(join(root, "database.sources.json"))) return;
  const name = "database-source-contracts";
  try {
    // Resolve on the host runtime: a compiled CLI has its own embedded module filesystem.
    const result = spawnSync(process.versions.bun ? "bun" : process.execPath, [
      ...(process.versions.bun ? ["--no-env-file"] : ["--input-type=module"]),
      "--eval", CHECK_ENTRY, "--", root,
    ], { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    const report: unknown = JSON.parse(result.stdout);
    if (!report || typeof report !== "object" || !("scope" in report)
      || report.scope !== "local-source-contracts" || !("ok" in report)
      || typeof report.ok !== "boolean" || !("findings" in report) || !Array.isArray(report.findings)) {
      throw new Error("Invalid database source check response");
    }
    const messages: string[] = [];
    for (const finding of report.findings) {
      if (!finding || typeof finding !== "object" || !("file" in finding) || typeof finding.file !== "string"
        || !("message" in finding) || typeof finding.message !== "string") throw new Error("Invalid source finding");
      messages.push(`${finding.file}: ${finding.message}`);
    }
    return { name, ok: result.status === 0 && report.ok && !messages.length,
      detail: messages.join("\n") || (result.status === 0 && report.ok ? "Offline database contracts and boundaries are current" : "Database source check failed") };
  } catch {
    return { name, ok: false, detail: "Cannot run the project database checker. Install the project runtime and @supacloud/db with source-contracts support, then run `supacloud-db check --root .` for diagnostics." };
  }
}
