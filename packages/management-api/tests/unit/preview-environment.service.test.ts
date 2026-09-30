import { expect, test } from "bun:test";
import { PREVIEW_ENVIRONMENT_SCHEMA, PreviewEnvironmentError, composePreviewEnvironment, derivePreviewBranchRef, previewsDueForReclamation, type PreviewComposeInput } from "../../src/services/preview-environment.service";

const base = { previewRef: "pr-42", projectRef: "demo", applicationId: "reviews", environmentId: "preview",
  releaseId: "a".repeat(64), source: { branch: "feature/orders", commit: "b".repeat(40) } };

test("composes all planned components with pending isolation and bounded project identity", () => {
  const preview = composePreviewEnvironment(base);
  expect(preview.schema).toBe(PREVIEW_ENVIRONMENT_SCHEMA);
  expect(preview.data_mode).toBe("schema_only");
  expect(preview.branch_ref).toBe(derivePreviewBranchRef(base.projectRef, base.previewRef));
  expect(preview.branch_ref).toMatch(/^pv[a-f0-9]{18}$/);
  expect(preview.production_blocked).toBe(true);
  expect(preview.components.map(component => component.name)).toEqual(["database", "application", "configuration", "resources", "queues", "storage", "secrets"]);
  expect(preview.components.every(component => component.status === "planned")).toBe(true);
  expect(preview.isolation.map(check => check.key)).toEqual(["database_role", "storage_permissions", "consumer_identity", "route_access_control"]);
  expect(preview.isolation.every(check => check.status === "pending")).toBe(true);
  expect(preview.lifecycle).toEqual({ reclaim_on: "pr_closed", timeout_hours: 168, residue: "delete_branch_and_namespace" });
  expect(preview.notes.join(" ")).toContain("does not provision");
});

test("project, case and separator differences cannot alias a preview branch", () => {
  const pairs = [["a-b", "pr-42"], ["a_b", "pr-42"], ["a-b", "pr_42"], ["a-b", "PR-42"], ["other", "pr-42"]] as const;
  const names = pairs.map(([project, preview]) => derivePreviewBranchRef(project, preview));
  expect(new Set(names).size).toBe(names.length);
  expect(names.every(name => name.length <= 20)).toBe(true);
  expect(derivePreviewBranchRef("a-b", "pr-42")).toBe(names[0]!);
});

test("refuses production-shaped environments, nested branches and binding destinations", () => {
  for (const patch of [
    { environmentId: "production" }, { source: { ...base.source, branch: "prod-eu" } },
    { source: { ...base.source, branch: "refs/heads/production" } },
    { resources: { "orders-db": "project:prod-orders" } },
    { resources: { "orders-db": "project:eu.production" } },
  ]) expect(() => composePreviewEnvironment({ ...base, ...patch }))
    .toThrow(new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_PRODUCTION_FORBIDDEN"));
});

test("full-clone plans need trusted authorization and resource references remain detached", () => {
  expect(() => composePreviewEnvironment({ ...base, dataMode: "full_clone" })).toThrow(new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_FULL_CLONE_REQUIRES_AUTHORIZATION"));
  expect(composePreviewEnvironment({ ...base, dataMode: "full_clone", authorizedFullClone: true }).data_mode).toBe("full_clone");
  expect(() => composePreviewEnvironment({ ...base, resources: { orders: "postgres://user:pass@host/db" } })).toThrow(new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INLINE_SECRET_FORBIDDEN"));
  const resources = { "orders-db": "project:orders" };
  const bound = composePreviewEnvironment({ ...base, resources, configurationId: "00000000-0000-4000-8000-000000000000" });
  resources["orders-db"] = "project:changed";
  expect(bound.resource_bindings).toEqual({ "orders-db": "project:orders" });
  expect(bound.configuration_id).toBe("00000000-0000-4000-8000-000000000000");
  expect(bound.components.find(component => component.name === "resources")?.detail).toBe("orders-db -> project:orders");
});

for (const [name, patch] of [
  ["newline identifier", { previewRef: "pr-42\n" }], ["newline reference", { resources: { orders: "project:test\n" } }],
  ["nonstring reference", { resources: { orders: 123 } }], ["invalid mode", { dataMode: "other" }],
  ["malformed release", { releaseId: "short" }], ["traversal", { source: { ...base.source, branch: "../escape" } }],
  ["zero timeout", { lifecycle: { timeoutHours: 0 } }], ["unbounded timeout", { lifecycle: { timeoutHours: 721 } }],
  ["resource cap", { resources: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`r${i}`, "project:test"])) }],
  ["UTF-8 output cap", { resources: Object.fromEntries(Array.from({ length: 64 }, (_, i) => ["界".repeat(500) + i, "project:test"])) }],
] as const) test(`rejects ${name}`, () => {
  expect(() => composePreviewEnvironment({ ...base, ...patch } as PreviewComposeInput)).toThrow();
});

test("timeout selection never turns malformed deadlines into deletion authority", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const previews = [
    { preview_ref: "by-pr", created_at: "2026-09-01T00:00:00.000Z", lifecycle: { reclaim_on: "pr_closed" as const, timeout_hours: 1 } },
    { preview_ref: "expired", created_at: "2026-09-20T00:00:00.000Z", lifecycle: { reclaim_on: "timeout" as const, timeout_hours: 24 } },
    { preview_ref: "fresh", created_at: "2026-09-30T00:00:00.000Z", lifecycle: { reclaim_on: "timeout" as const, timeout_hours: 24 } },
    { preview_ref: "bad", created_at: "2026-09-01T00:00:00.000Z", lifecycle: { reclaim_on: "timeout" as const, timeout_hours: -1 } },
    { preview_ref: "bad-date", created_at: "invalid", lifecycle: { reclaim_on: "timeout" as const, timeout_hours: 1 } },
  ];
  expect(previewsDueForReclamation(previews, now).map(preview => preview.preview_ref)).toEqual(["expired"]);
});
