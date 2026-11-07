import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateBackupReadiness, parseBackupReadiness } from "./lib/backup-acceptance";

function option(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

async function readinessDocument(): Promise<unknown> {
  const input = option("--input");
  if (input) return JSON.parse(await readFile(input, "utf8"));
  const manager = process.env.SUPACLOUD_BACKUP_MANAGER
    || join(import.meta.dir, "lib/backup_manager.sh");
  const child = Bun.spawn([manager, "verify"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`backup_manager verify failed: ${stderr.trim().slice(0, 512)}`);
  return JSON.parse(stdout.trim());
}

try {
  const readiness = parseBackupReadiness(await readinessDocument());
  const maxAgeSeconds = Number(option("--max-age-seconds") || process.env.SUPACLOUD_BACKUP_MAX_AGE_SECONDS || 86400);
  const result = evaluateBackupReadiness(readiness, Date.now(), maxAgeSeconds);
  console.log(JSON.stringify({
    schema: "supacloud.pigsty-backup-acceptance.v1",
    status: result.status,
    stanza: readiness.stanza,
    provider: readiness.provider,
    checks: {
      provider_ready: readiness.status === "ready",
      repository_present: readiness.repository_count > 0,
      completed_backup_present: readiness.completed_backup_count > 0,
      backup_fresh: result.freshness_seconds !== null && result.freshness_seconds <= maxAgeSeconds,
    },
    ...result,
  }, null, 2));
  if (result.status !== "confirmed") process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
