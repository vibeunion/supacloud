// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { withNativePostgres } from "../helpers/native-postgres";
import { buildApplicationPreviewReceipt, type StoredApplicationPreview } from "../../src/services/application-preview-contract";
import { ApplicationPreviewConflictError, persistApplicationPreview, replaceProjectConfig } from "../../src/repositories/project-config-writes";

const image = "ghcr.io/pgmq/pg18-pgmq@sha256:2dd8ac92a1c0eb121d6ea5b12b3f7c015813ae58945a940451d4683afd5a19c2";
const nativeTest = process.env.SUPACLOUD_PREVIEW_NATIVE_TESTS === "1" ? test : test.skip;
function receipt(): StoredApplicationPreview {
  const id = crypto.randomUUID();
  return {
    ...buildApplicationPreviewReceipt({ previewId: id, projectRef: "demo", applicationId: "api", environmentId: "test",
      releaseId: "a".repeat(64), branchRef: `pv${id.replaceAll("-", "").slice(0, 18)}`, dataMode: "schema_only" }),
    status: "provisioning", branch_name: "fixture", queue_name: `preview_${id}`, test_secret_name: "FIXTURE",
    source_configuration_id: null, created_at: "2026-10-07T00:00:00.000Z", updated_at: "2026-10-07T00:00:00.000Z",
  };
}

nativeTest("native PostgreSQL serializes preview writes, preserves config, and rejects stale lifecycle updates", async () => {
  await withNativePostgres(async db => {
    await db.unsafe(`CREATE TABLE projects (
      ref text PRIMARY KEY, config jsonb, updated_at timestamptz DEFAULT now(), deleted_at timestamptz);
      INSERT INTO projects(ref, config) VALUES ('demo', '{"owner_setting":"before","scheduled_functions":[{"id":"live"}]}');`);
    const gate = Promise.withResolvers<void>();
    const writes = Array.from({ length: 12 }, async () => {
      await gate.promise;
      return persistApplicationPreview(db, "demo", receipt(), null);
    });
    const configWrite = (async () => {
      await gate.promise;
      // Captured before the creates: cannot delete their receipts or schedules.
      return replaceProjectConfig(db, "demo", { owner_setting: "after", application_previews: [], scheduled_functions: [] });
    })();
    gate.resolve();
    const created = await Promise.all(writes);
    await configWrite;
    const read = async () => (await db`SELECT config FROM projects WHERE ref = 'demo'`)[0].config;
    let config = await read();
    expect(config.owner_setting).toBe("after");
    expect(config.scheduled_functions).toEqual([{ id: "live" }]);
    expect(config.application_previews).toHaveLength(12);
    expect(new Set(config.application_previews.map((item: StoredApplicationPreview) => item.preview_id)).size).toBe(12);

    const updateGate = Promise.withResolvers<void>();
    const updates = created.map(async item => {
      await updateGate.promise;
      return persistApplicationPreview(db, "demo", { ...item, status: "ready" }, item.updated_at);
    });
    const concurrentConfig = (async () => {
      await updateGate.promise;
      return replaceProjectConfig(db, "demo", { owner_setting: "latest", application_previews: created });
    })();
    updateGate.resolve();
    const ready = await Promise.all(updates);
    await concurrentConfig;
    config = await read();
    expect(config.owner_setting).toBe("latest");
    expect(config.application_previews.every((item: StoredApplicationPreview) => item.status === "ready")).toBe(true);

    const first = ready[0]!;
    const races = await Promise.allSettled([
      persistApplicationPreview(db, "demo", { ...first, status: "cleaned" }, first.updated_at),
      persistApplicationPreview(db, "demo", { ...first, status: "failed" }, first.updated_at),
    ]);
    expect(races.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = races.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason instanceof ApplicationPreviewConflictError).toBe(true);
    const winner = races.find(result => result.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("missing winner");
    expect(winner.value.updated_at > first.updated_at).toBe(true);
    await expect(persistApplicationPreview(db, "demo", first, first.updated_at)).rejects.toBeInstanceOf(ApplicationPreviewConflictError);
    const cleaned = await persistApplicationPreview(db, "demo", { ...winner.value, status: "cleaned" }, winner.value.updated_at);
    await expect(persistApplicationPreview(db, "demo", { ...cleaned, status: "ready" }, cleaned.updated_at))
      .rejects.toBeInstanceOf(ApplicationPreviewConflictError);
    await expect(persistApplicationPreview(db, "demo", first, null)).rejects.toBeInstanceOf(ApplicationPreviewConflictError);
    await expect(persistApplicationPreview(db, "other", receipt(), null)).rejects.toThrow("APPLICATION_PREVIEW_RECEIPT_INVALID");
    expect((await read()).application_previews).toHaveLength(12);

    await db`UPDATE projects SET config = to_jsonb(${JSON.stringify({ owner_setting: "legacy" })}::text) WHERE ref = 'demo'`;
    const legacy = await persistApplicationPreview(db, "demo", receipt(), null);
    expect((await read()).owner_setting).toBe("legacy");
    expect((await read()).application_previews[0].preview_id).toBe(legacy.preview_id);
    await db`UPDATE projects SET config = '{"application_previews":[{"preview_id":"broken"}]}'::jsonb WHERE ref = 'demo'`;
    await expect(persistApplicationPreview(db, "demo", receipt(), null)).rejects.toThrow("APPLICATION_PREVIEW_CONFIG_INVALID");
    expect((await read()).application_previews).toEqual([{ preview_id: "broken" }]);
  }, { image });
}, 120_000);
