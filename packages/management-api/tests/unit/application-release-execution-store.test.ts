import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReleaseExecutionError,
  createReleaseExecution,
  parseReleaseExecutionDocument,
} from "../../src/services/application-release-execution.service";
import { createFileReleaseExecutionStore } from "../../src/services/application-release-execution-store";

const record = {
  schema: "supacloud.application-release.v1" as const,
  project_ref: "demo",
  application_id: "reviews",
  release_id: "c".repeat(64),
  manifest_sha256: "d".repeat(64),
  created_at: "2026-09-30T00:00:00.000Z",
  targets: [{ name: "api", object_id: "b".repeat(64), kind: "http" as const, entrypoint: "bundle/index.js" as const }],
};

function document() {
  return createReleaseExecution({
    record, target: "api",
    observations: {
      application: { status: "succeeded", observedAt: "2026-09-30T01:00:00.000Z" },
      migrations: { status: "succeeded", version: "2", observedAt: "2026-09-30T01:00:00.000Z" },
      health: { status: "succeeded", observedAt: "2026-09-30T01:00:00.000Z" },
    },
  });
}

test("round-trips a recorded execution and returns null for a missing one", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "supacloud-execution-"));
  const store = createFileReleaseExecutionStore(baseDir);
  await store.save("demo", "reviews", document());
  const read = await store.read("demo", "reviews", record.release_id, "api");
  expect(read).toEqual(document());
  expect(read?.deploymentVerified).toBe(true);
  expect(await store.read("demo", "reviews", "a".repeat(64), "api")).toBeNull();
  expect(await store.read("demo", "reviews", record.release_id, "worker")).toBeNull();
});

test("rejects tampered or malformed stored execution records", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "supacloud-execution-"));
  const store = createFileReleaseExecutionStore(baseDir);
  await store.save("demo", "reviews", document());
  const file = join(baseDir, "demo", "reviews", record.release_id, "api.json");
  await writeFile(file, JSON.stringify({ ...document(), deploymentVerified: true, components: [] }));
  await expect(store.read("demo", "reviews", record.release_id, "api"))
    .rejects.toBeInstanceOf(ReleaseExecutionError);

  await expect(store.read("..", "reviews", record.release_id, "api")).rejects.toBeInstanceOf(ReleaseExecutionError);
  await expect(store.read("demo", "reviews", record.release_id, "Bad_Target")).rejects.toBeInstanceOf(ReleaseExecutionError);
});

test("rejects a document whose verification flag does not match its components", () => {
  const invalid = { ...document(), deploymentVerified: false };
  expect(() => parseReleaseExecutionDocument(invalid, { release_id: record.release_id, target: "api" }))
    .toThrow(new ReleaseExecutionError("RELEASE_EXECUTION_INVALID"));
  expect(() => parseReleaseExecutionDocument({ ...document(), target: "worker" }, { release_id: record.release_id, target: "api" }))
    .toThrow(new ReleaseExecutionError("RELEASE_EXECUTION_INVALID"));
});