import { createHash } from "node:crypto";
import { open, mkdir, link, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createReportExport } from "../../packages/worker/examples/report-export";
import { workerExecutionFromEnvironment } from "../../packages/worker/src/execution-group";

export function createDeliveryWorker() {
  const connectionString = process.env.WORKER_GROUP_TEST_DATABASE_URL;
  const root = process.env.WORKER_GROUP_TEST_ARTIFACT_ROOT;
  const projectRef = process.env.SUPACLOUD_PROJECT_REF;
  if (!connectionString || !root || !projectRef) throw new Error("FIXTURE_SETTINGS_MISSING");
  const policy = workerExecutionFromEnvironment();
  const { retry, ...rest } = policy;
  // Equivalent host policies may have a different JSON property order.
  const group = { retry, ...rest,
    resources: { memoryLimitMiB: policy.resources.memoryLimitMiB, cpuLimit: policy.resources.cpuLimit } };
  const reports = createReportExport({ connectionString, projectRef, group }, {
    authorize: async (actor, snapshot) =>
      actor.actorId === "operator" && actor.tenantId === "tenant-a" && snapshot.sourceId === "sales" && snapshot.revision === "1",
    async page(_snapshot, cursor) {
      if (process.env.WORKER_GROUP_TEST_HANG === "1") await new Promise<void>(() => {});
      return cursor === null
        ? { rows: [["item", "quantity"], ["=formula", 3]], next: "page2" }
        : { rows: [["second", 4]], next: null };
    },
    async open(operationId) {
      await mkdir(root, { recursive: true });
      const temporary = join(root, `${operationId}.${crypto.randomUUID()}.tmp`);
      const handle = await open(temporary, "wx");
      let closed = false;
      return {
        async write(chunk) { await handle.write(chunk); },
        async commit(sha256) {
          await handle.sync(); await handle.close(); closed = true;
          const destination = join(root, `${operationId}.csv`);
          try { await link(temporary, destination); }
          catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
          }
          if (createHash("sha256").update(await readFile(destination)).digest("hex") !== sha256) {
            throw new Error("FIXTURE_OBJECT_CONFLICT");
          }
          await rm(temporary);
          // Fault after durable object publish but before the domain result transaction.
          if (process.env.WORKER_GROUP_TEST_CRASH === "1") process.exit(91);
          return `${operationId}.csv`;
        },
        async abort() {
          if (!closed) await handle.close();
          await rm(temporary, { force: true });
        },
      };
    },
  });
  return reports.worker;
}
