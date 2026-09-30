import { expect, test } from "bun:test";
import {
  PREVIEW_ENVIRONMENT_SCHEMA,
  PreviewEnvironmentError,
  composePreviewEnvironment,
  evaluatePreviewIsolation,
  previewsDueForReclamation,
} from "../../src/services/preview-environment.service";

const base = {
  previewRef: "pr-42",
  projectRef: "demo",
  applicationId: "reviews",
  environmentId: "preview",
  releaseId: "a".repeat(64),
  source: { branch: "feature/orders", commit: "b".repeat(40) },
};

test("composes a complete planned environment with isolation checks and lifecycle", () => {
  const preview = composePreviewEnvironment(base);
  expect(preview.schema).toBe(PREVIEW_ENVIRONMENT_SCHEMA);
  expect(preview.data_mode).toBe("schema_only");
  expect(preview.branch_ref).toBe("preview-pr-42");
  expect(preview.production_blocked).toBe(true);
  expect(preview.components.map((component) => component.name)).toEqual([
    "database", "application", "configuration", "resources", "queues", "storage", "secrets",
  ]);
  expect(preview.components.every((component) => component.status === "planned")).toBe(true);
  expect(preview.isolation.map((check) => check.key)).toEqual([
    "database_role", "storage_permissions", "consumer_identity", "route_access_control",
  ]);
  expect(preview.isolation.every((check) => check.status === "pending")).toBe(true);
  expect(preview.lifecycle).toEqual({ reclaim_on: "pr_closed", timeout_hours: 168, residue: "delete_branch_and_namespace" });
  expect(preview.notes.join(" ")).toContain("does not provision");
});

test("refuses production-shaped environments, branches and bindings", () => {
  const cases: Record<string, unknown>[] = [
    { ...base, environmentId: "production" },
    { ...base, source: { ...base.source, branch: "prod-eu" } },
    { ...base, resources: { "orders-db": "project:prod-orders" } },
  ];
  for (const value of cases) {
    expect(() => composePreviewEnvironment(value as typeof base))
      .toThrow(new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_PRODUCTION_FORBIDDEN"));
  }
});

test("requires explicit authorization and a reference for full_clone and resources", () => {
  expect(() => composePreviewEnvironment({ ...base, dataMode: "full_clone" }))
    .toThrow(new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_FULL_CLONE_REQUIRES_AUTHORIZATION"));
  expect(composePreviewEnvironment({ ...base, dataMode: "full_clone", authorizedFullClone: true }).data_mode).toBe("full_clone");

  expect(() => composePreviewEnvironment({ ...base, resources: { "orders-db": "postgres://user:pass@host/db" } }))
    .toThrow(new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INLINE_SECRET_FORBIDDEN"));
  const bound = composePreviewEnvironment({ ...base, resources: { "orders-db": "project:orders" } });
  expect(bound.components.find((component) => component.name === "resources")?.detail).toBe("orders-db -> project:orders");
});

test("rejects malformed identifiers and out-of-range lifecycle values", () => {
  expect(() => composePreviewEnvironment({ ...base, releaseId: "short" })).toThrow();
  expect(() => composePreviewEnvironment({ ...base, source: { ...base.source, branch: "../escape" } })).toThrow();
  expect(() => composePreviewEnvironment({ ...base, lifecycle: { timeoutHours: 0 } })).toThrow();
  expect(() => composePreviewEnvironment({ ...base, lifecycle: { timeoutHours: 24 * 31 } })).toThrow();
});

test("selects only overdue timeout previews for reclamation", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const previews = [
    { preview_ref: "by-pr", created_at: "2026-09-01T00:00:00.000Z", lifecycle: { reclaim_on: "pr_closed" as const, timeout_hours: 1 } },
    { preview_ref: "expired", created_at: "2026-09-20T00:00:00.000Z", lifecycle: { reclaim_on: "timeout" as const, timeout_hours: 24 } },
    { preview_ref: "fresh", created_at: "2026-09-30T00:00:00.000Z", lifecycle: { reclaim_on: "timeout" as const, timeout_hours: 24 } },
  ];
  expect(previewsDueForReclamation(previews, now).map((preview) => preview.preview_ref)).toEqual(["expired"]);
});
test("accepts only when every isolation check has passing evidence", () => {
  const preview = composePreviewEnvironment(base);
  const none = evaluatePreviewIsolation(preview, {});
  expect(none.accepted).toBe(false);
  expect(none.isolation.every((check) => check.status === "pending")).toBe(true);

  const partial = evaluatePreviewIsolation(preview, { database_role: { ok: true }, storage_permissions: { ok: false } });
  expect(partial.isolation.map((check) => check.status)).toEqual(["verified", "failed", "pending", "pending"]);
  expect(partial.accepted).toBe(false);

  const all = evaluatePreviewIsolation(preview, {
    database_role: { ok: true }, storage_permissions: { ok: true },
    consumer_identity: { ok: true }, route_access_control: { ok: true },
  });
  expect(all.accepted).toBe(true);
});
