import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyDrillDocument } from "../packages/management-api/src/services/restore-drill-contract";

// 端到端测试只使用显式选择的本地 Docker socket 和临时合成数据。
const [image, linuxBun, context] = process.argv.slice(2);
if (!image || !linuxBun || !context) {
  throw new Error("Usage: bun scripts/test-project-restore-drill.ts <postgres-pgbackrest-image> <linux-bun-path> <local-docker-context>");
}
const docker = ["docker", "--context", context];
async function command(args: string[], allowFailure = false) {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0 && !allowFailure) throw new Error(`Local drill test command failed (${args[0]}): ${stderr.slice(-2000)}`);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}
const inspected = JSON.parse((await command([...docker, "context", "inspect", context])).stdout);
if (!String(inspected[0]?.Endpoints?.docker?.Host).startsWith("unix://")) throw new Error("Only local Docker sockets are allowed");
const repository = resolve(import.meta.dir, "..");
const binary = await realpath(linuxBun);
const dependencyLink = join(repository, "packages/edge-runtime/node_modules");
const dependencyDirectory = await realpath(dependencyLink);
const artifacts = await mkdtemp(join(tmpdir(), "supacloud-restore-drill-e2e-"));
const suffix = crypto.randomUUID().slice(0, 8);
const volume = `supacloud-drill-e2e-${suffix}`;
const containers: string[] = [];
const signingKey = "synthetic-snapshot-signing-key-for-local-drills";
const encryptionKey = "synthetic-encryption-key-for-local-restore-drills";
const receiptKey = "synthetic-receipt-signing-key-for-local-drills";
const secrets = [
  "--env", `SUPACLOUD_SNAPSHOT_SIGNING_KEY=${signingKey}`,
  "--env", `SUPACLOUD_RESTORE_ENCRYPTION_KEY=${encryptionKey}`,
  "--env", `SUPACLOUD_DRILL_RECEIPT_KEY=${receiptKey}`,
];
const mounts = [
  "--mount", `type=bind,src=${binary},dst=/usr/local/bin/bun,readonly`,
  "--mount", `type=bind,src=${repository},dst=/app,readonly`,
  ...(dependencyDirectory !== dependencyLink
    ? ["--mount", `type=bind,src=${dependencyDirectory},dst=${dependencyDirectory},readonly`] : []),
];
const base = [
  ...docker, "run", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--user", "postgres", "--entrypoint", "/usr/local/bin/bun", ...secrets, ...mounts,
];
const results: Array<Record<string, unknown>> = [];
await command([...docker, "volume", "create", volume]);
try {
  await command([
    ...docker, "run", "--rm", "--network", "none", "--mount", `type=volume,src=${volume},dst=/drill`,
    "--entrypoint", "install", image, "-d", "-m", "700", "-o", "postgres", "-g", "postgres", "/drill",
  ]);
  for (const [index, kind] of ["logical-full", "pgbackrest"].entries()) {
    const producer = `supacloud-drill-source-${suffix}-${index}`;
    containers.push(producer);
    const generated = await command([
      ...base, "--name", producer, image, "--no-env-file",
      "/app/packages/management-api/tests/fixtures/create-restore-drill-snapshot.ts", kind, "/tmp/drill-fixture/backup",
    ]);
    const { snapshot_id: snapshotId } = JSON.parse(generated.stdout.trim());
    const backup = join(artifacts, kind);
    await command([...docker, "cp", `${producer}:/tmp/drill-fixture/backup`, backup]);
    const runMounts = [
      "--mount", `type=bind,src=${backup},dst=/backup,readonly`,
      "--mount", `type=volume,src=${volume},dst=/drill`,
    ];
    const drillId = crypto.randomUUID();
    const consumer = `supacloud-drill-target-${suffix}-${index}`;
    containers.push(consumer);
    const confirmation = `RESTORE_DRILL:drillfixture:${snapshotId}:${drillId}`;
    const completed = await command([
      ...base, "--name", consumer, ...runMounts, image, "--no-env-file",
      "/app/scripts/project-restore-drill.ts", "run", drillId, confirmation,
    ]);
    const receipt = JSON.parse(completed.stdout.trim());
    verifyDrillDocument(receipt, receiptKey);
    if (receipt.status !== "succeeded" || receipt.backup_method !== kind
      || !Number.isSafeInteger(receipt.max_rpo_ms) || receipt.rpo_ms > receipt.max_rpo_ms
      || !Number.isSafeInteger(receipt.max_rto_ms) || receipt.rto_ms > receipt.max_rto_ms
      || (kind === "pgbackrest" && !receipt.checks.some((check: { name: string }) => check.name === "after_target_transaction_absent"))) {
      throw new Error("Full restore acceptance did not pass");
    }
    await command([...docker, "cp", `${consumer}:/drill/${drillId}/receipt.json`, join(artifacts, `${kind}-receipt.json`)]);
    const replay = await command([
      ...base, "--rm", ...runMounts, image, "--no-env-file",
      "/app/scripts/project-restore-drill.ts", "run", drillId, confirmation,
    ], true);
    if (replay.code === 0) throw new Error("Existing drill ID was incorrectly replayed");
    const status = JSON.parse((await command([
      ...base, "--rm", ...runMounts, image, "--no-env-file",
      "/app/scripts/project-restore-drill.ts", "status", drillId,
    ])).stdout);
    verifyDrillDocument(status.receipt, receiptKey);
    if (status.receipt.signature !== receipt.signature || status.effective_status !== "succeeded") {
      throw new Error("Replay modified the authoritative receipt");
    }
    // 使用新的演练 ID 验证真实损坏对象会在数据库恢复前被拒绝。
    await writeFile(join(backup, "objects/fixture.txt"), "tampered-object");
    const failedId = crypto.randomUUID();
    const failure = await command([
      ...base, "--rm", ...runMounts, image, "--no-env-file",
      "/app/scripts/project-restore-drill.ts", "run", failedId,
      `RESTORE_DRILL:drillfixture:${snapshotId}:${failedId}`,
    ], true);
    const failed = JSON.parse(failure.stdout.trim());
    verifyDrillDocument(failed, receiptKey);
    if (failure.code === 0 || failed.status !== "failed" || failed.phase !== "inventory") {
      throw new Error("Corrupt component was not rejected before restore");
    }
    await writeFile(join(backup, "objects/fixture.txt"), "restored-object");
    results.push({
      method: kind, drill_id: drillId, snapshot_id: snapshotId, snapshot_sha256: receipt.snapshot_sha256,
      rpo_ms: receipt.rpo_ms, rto_ms: receipt.rto_ms, checks: receipt.checks.length,
      duplicate_id_refused: true, corrupted_component_refused: true,
    });
  }
  await writeFile(join(artifacts, "summary.json"), JSON.stringify({
    scope: "synthetic-local-fixtures-only", image, results,
  }, null, 2) + "\n");
  console.log(JSON.stringify({ artifacts, results }));
} finally {
  for (const name of containers.reverse()) await command([...docker, "rm", "-f", name], true);
  await command([...docker, "volume", "rm", volume], true);
}
