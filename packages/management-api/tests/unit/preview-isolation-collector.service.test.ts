import { expect, test } from "bun:test";
import { composePreviewEnvironment, type PreviewEnvironment } from "../../src/services/preview-environment.service";
import { collectPreviewIsolation, type PreviewIsolationCollectorPort, type PreviewIsolationObservation } from "../../src/services/preview-isolation-collector.service";

const input = { previewRef: "pr-9", projectRef: "demo", applicationId: "reviews", environmentId: "preview",
  releaseId: "a".repeat(64), source: { branch: "feature/orders", commit: "b".repeat(40) } };
const now = new Date("2026-09-30T12:00:00.000Z");
const preview = composePreviewEnvironment(input);
function observation(check: string, selected = preview): PreviewIsolationObservation {
  return { ok: true, collector: "platform-test-probe", check: check as NonNullable<PreviewIsolationObservation["check"]>,
    project_ref: selected.project_ref, application_id: selected.application_id, environment_id: selected.environment_id,
    branch_ref: selected.branch_ref, preview_ref: selected.preview_ref, release_id: selected.release_id,
    configuration_id: selected.configuration_id ?? null,
    observed_at: "2026-09-30T11:00:00.000Z", expires_at: "2026-09-30T13:00:00.000Z" };
}
function collector(resolve: (check: string) => PreviewIsolationObservation | null): PreviewIsolationCollectorPort {
  return { collect: async check => resolve(check) };
}

test("accepts only four identity-bound observations with a valid lifetime", async () => {
  const result = await collectPreviewIsolation(preview, collector(check => observation(check)), now);
  expect(result.accepted).toBe(true);
  expect(result.discarded).toEqual([]);
  expect(result.isolation).toHaveLength(4);
  expect(result.isolation.every(check => check.status === "verified")).toBe(true);
});

test("keeps absent, mismatched and expired observations pending but preserves observed failures", async () => {
  const result = await collectPreviewIsolation(preview, collector(check => {
    if (check === "database_role") return null;
    const value = observation(check);
    if (check === "storage_permissions") return { ...value, preview_ref: "pr-other" };
    if (check === "consumer_identity") return { ...value, expires_at: "2026-09-30T11:59:59.000Z" };
    return { ...value, ok: false };
  }), now);
  expect(result.accepted).toBe(false);
  expect(result.isolation.map(check => check.status)).toEqual(["pending", "pending", "pending", "failed"]);
  expect(result.discarded).toEqual([
    { check: "database_role", reason: "no observation" },
    { check: "storage_permissions", reason: "preview_ref mismatch" },
    { check: "consumer_identity", reason: "observation expired" },
  ]);
});

test("discards future observations and redacts collector error messages", async () => {
  const result = await collectPreviewIsolation(preview, collector(check => {
    if (check === "database_role") throw new Error("private-backend-token");
    return { ...observation(check), observed_at: "2026-09-30T12:01:00.000Z" };
  }), now);
  expect(result.accepted).toBe(false);
  expect(result.discarded.map(item => item.reason)).toEqual([
    "collector error", "observation from the future", "observation from the future", "observation from the future",
  ]);
  expect(JSON.stringify(result)).not.toContain("private-backend-token");
});

for (const key of ["collector", "check", "project_ref", "application_id", "environment_id", "branch_ref",
  "preview_ref", "release_id", "configuration_id", "observed_at", "expires_at"] as const) {
  test(`missing ${key} cannot certify isolation`, async () => {
    const result = await collectPreviewIsolation(preview, collector(check => {
      const value = observation(check); delete value[key]; return value;
    }), now);
    expect(result.accepted).toBe(false);
    expect(result.discarded).toHaveLength(4);
    expect(result.isolation.every(check => check.status === "pending")).toBe(true);
  });
}

for (const key of ["project_ref", "application_id", "environment_id", "branch_ref", "preview_ref", "release_id", "configuration_id"] as const) {
  test(`mismatched ${key} cannot certify another resource`, async () => {
    const result = await collectPreviewIsolation(preview, collector(check => ({ ...observation(check), [key]: "other" })), now);
    expect(result.accepted).toBe(false);
    expect(result.discarded).toHaveLength(4);
  });
}

for (const ok of [1, "true", null, undefined]) {
  test(`non-boolean observation ${String(ok)} is discarded`, async () => {
    const result = await collectPreviewIsolation(preview,
      collector(check => ({ ...observation(check), ok } as unknown as PreviewIsolationObservation)), now);
    expect(result.accepted).toBe(false);
    expect(result.discarded).toHaveLength(4);
  });
}

test("empty, duplicate and incomplete check sets fail before touching the collector", async () => {
  let calls = 0;
  for (const isolation of [[], preview.isolation.slice(1), Array(4).fill(preview.isolation[0])]) {
    await expect(collectPreviewIsolation({ ...preview, isolation }, { collect: async () => { calls++; return null; } }, now)).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test("configured previews require exactly the selected configuration revision", async () => {
  const selected = composePreviewEnvironment({ ...input, configurationId: `cfg_${"a".repeat(52)}` });
  const valid = await collectPreviewIsolation(selected, collector(check => observation(check, selected)), now);
  expect(valid.accepted).toBe(true);
  const invalid = await collectPreviewIsolation(selected,
    collector(check => ({ ...observation(check, selected), configuration_id: null })), now);
  expect(invalid.accepted).toBe(false);
});

test("selection and each collector input are detached across asynchronous calls", async () => {
  const selected: PreviewEnvironment = structuredClone(preview);
  const result = await collectPreviewIsolation(selected, {
    collect: async (check, isolated) => {
      const value = observation(check, isolated);
      selected.project_ref = "changed";
      selected.isolation.splice(0);
      isolated.project_ref = "mutated-by-collector";
      return value;
    },
  }, now);
  expect(result.accepted).toBe(true);
  expect(result.isolation).toHaveLength(4);
});

test("inherited observation metadata is not trusted", async () => {
  const result = await collectPreviewIsolation(preview,
    collector(check => Object.create(observation(check)) as PreviewIsolationObservation), now);
  expect(result.accepted).toBe(false);
  expect(result.discarded).toHaveLength(4);
});
