import { expect, test } from "bun:test";
import { composePreviewEnvironment } from "../../src/services/preview-environment.service";
import { collectPreviewIsolation, type PreviewIsolationCollectorPort } from "../../src/services/preview-isolation-collector.service";

const input = {
  previewRef: "pr-9",
  projectRef: "demo",
  applicationId: "reviews",
  environmentId: "preview",
  releaseId: "a".repeat(64),
  source: { branch: "feature/orders", commit: "b".repeat(40) },
};

const now = new Date("2026-09-30T12:00:00.000Z");
const preview = composePreviewEnvironment(input);

function collector(
  resolve: (check: string) => Awaited<ReturnType<PreviewIsolationCollectorPort["collect"]>>,
): PreviewIsolationCollectorPort {
  return { collect: async (check) => resolve(check) };
}

test("accepts only fully observed, matching isolation evidence", async () => {
  const collected = await collectPreviewIsolation(preview, collector(() => ({
    ok: true, observed_at: "2026-09-30T11:00:00.000Z", preview_ref: "pr-9", release_id: "a".repeat(64),
  })), now);
  expect(collected.accepted).toBe(true);
  expect(collected.discarded).toEqual([]);
  expect(collected.isolation.every((check) => check.status === "verified")).toBe(true);
});

test("keeps absent, mismatched or expired observations pending", async () => {
  const collected = await collectPreviewIsolation(preview, collector((check) => {
    if (check === "database_role") return null;
    if (check === "storage_permissions") return { ok: true, preview_ref: "pr-other" };
    if (check === "consumer_identity") return { ok: true, expires_at: "2026-09-30T11:59:59.000Z" };
    return { ok: false, observed_at: "2026-09-30T11:00:00.000Z" };
  }), now);
  expect(collected.accepted).toBe(false);
  expect(collected.isolation.map((check) => check.status)).toEqual(["pending", "pending", "pending", "failed"]);
  expect(collected.discarded).toEqual([
    { check: "database_role", reason: "no observation" },
    { check: "storage_permissions", reason: "preview mismatch" },
    { check: "consumer_identity", reason: "observation expired" },
  ]);
});

test("discards collector errors and future observations", async () => {
  const collected = await collectPreviewIsolation(preview, collector((check) => {
    if (check === "database_role") throw new Error("probe unavailable");
    return { ok: true, observed_at: "2026-09-30T13:00:00.000Z" };
  }), now);
  expect(collected.accepted).toBe(false);
  expect(collected.discarded).toEqual([
    { check: "database_role", reason: "collector error" },
    { check: "storage_permissions", reason: "observation from the future" },
    { check: "consumer_identity", reason: "observation from the future" },
    { check: "route_access_control", reason: "observation from the future" },
  ]);
});

test("rejects an observation bound to a different configuration revision", async () => {
  const configured = composePreviewEnvironment({ ...input, configurationId: `cfg_${"a".repeat(52)}` });
  const collected = await collectPreviewIsolation(configured, collector(() => ({
    ok: true, observed_at: "2026-09-30T11:00:00.000Z", configuration_id: `cfg_${"b".repeat(52)}`,
  })), now);
  expect(collected.accepted).toBe(false);
  expect(collected.discarded.every((entry) => entry.reason === "configuration mismatch")).toBe(true);
});