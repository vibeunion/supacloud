import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "./analyze";
import { generateFeatureSource, validateFeatureSpec } from "./feature";
import type { FeatureSpecNode, ModuleNode } from "./types";

const baseModule = (spec: FeatureSpecNode): ModuleNode => ({
  name: "case",
  className: "CaseModule",
  file: "case.module.ts",
  line: 1,
  imports: [],
  providers: [],
  controllers: [{
    className: "CaseController",
    path: "/cases",
    scope: "request",
    deps: [],
    routes: [{ method: "POST", path: "/:id/accept", handler: "accept", command: "AcceptCommand", pathParams: ["id"], paramBindings: ["id"] }],
    file: "case.controller.ts",
    importPath: "case.controller",
  }],
  commands: [{
    className: "AcceptCommand", name: "case.accept", permission: "case.accept",
    transaction: "required", idempotency: "required", tenantScope: "required",
  }],
  queries: [],
  exports: [],
  featureSpec: spec,
});

describe("feature specs", () => {
  test("lowers a colocated defineFeatureSlice into the application graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-feature-"));
    await writeFile(join(root, "feature.ts"), [
      "const spec = defineFeatureSpec({",
      '  name: "case", states: ["draft", "accepted"],',
      '  transitions: { accept: { from: "draft", to: "accepted" } },',
      "});",
      "const CaseFeature = defineFeatureSlice({ name: \"case\", spec, tags: [\"type:feature\"] });",
      "",
    ].join("\n"), "utf8");
    const graph = await analyzeProject(root);
    expect(graph.modules).toHaveLength(1);
    expect(graph.modules[0]?.tags).toEqual(["type:feature"]);
    expect(graph.modules[0]?.featureSpec?.transitions[0]?.to).toBe("accepted");
  });

  test("detects state and governance drift", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "missing", command: "AcceptCommand",
        permission: "case.wrong", transaction: "none",
        route: "POST /cases/:id/accept",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version",
          tenantField: "tenant_id",
          stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    const codes = validateFeatureSpec(spec, baseModule(spec)).map((diagnostic) => diagnostic.code);
    expect(codes).toEqual([
      "invalid-feature-transition", "feature-governance-drift",
      "feature-governance-drift", "feature-persistence-drift",
    ]);
  });

  test("requires truthful persistence governance for feature transitions", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted", command: "AcceptCommand",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version",
          tenantField: "tenant_id",
          stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    const diagnostics = validateFeatureSpec(spec, {
      ...baseModule(spec),
      commands: [{
        className: "AcceptCommand", name: "case.accept", permission: "case.accept",
        transaction: "none", idempotency: "none", tenantScope: "required",
      }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("feature-persistence-drift");
  });

  test("requires command and permission bindings for persistent transitions", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", tenantField: "tenant_id", stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    const codes = validateFeatureSpec(spec).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("feature-command-unresolved");
    expect(codes).toContain("feature-governance-drift");
  });

  test("rejects a database lock without a version field", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted",
        persistence: {
          boundary: "database", optimisticLock: "required",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    expect(validateFeatureSpec(spec).map((diagnostic) => diagnostic.code))
      .toContain("feature-persistence-invalid");
  });

  test("rejects dynamic-looking version field names", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "case.version",
          tenantField: "tenant_id",
          stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    expect(validateFeatureSpec(spec).map((diagnostic) => diagnostic.code))
      .toContain("feature-persistence-invalid");
  });

  test("rejects a database transition without a tenant field", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      transitions: [{
        name: "accept", from: "draft", to: "accepted",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", receipt: "required", reconciliation: "none",
          stateField: "state",
        },
      }],
    };
    expect(validateFeatureSpec(spec).map((diagnostic) => diagnostic.code))
      .toContain("feature-persistence-invalid");
  });

  test("requires tenant-scoped queries for database features", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", tenantField: "tenant_id", stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    const diagnostics = validateFeatureSpec(spec, {
      ...baseModule(spec),
      queries: [{ className: "ListCaseQuery", name: "case.list" }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code))
      .toContain("feature-query-tenant-boundary");
  });

  test("requires tenant-scoped jobs for database features", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", tenantField: "tenant_id", stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    const diagnostics = validateFeatureSpec(spec, {
      ...baseModule(spec),
      jobs: [{
        className: "RefreshCaseJob", name: "case.refresh", serviceKey: "refreshCaseJob",
        scope: "job", tenantScope: "none",
      }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code))
      .toContain("feature-job-tenant-boundary");
  });

  test("requires tenant-scoped commands for database features", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted", command: "AcceptCommand",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", tenantField: "tenant_id", stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    const diagnostics = validateFeatureSpec(spec, {
      ...baseModule(spec),
      commands: [{
        className: "AcceptCommand", name: "case.accept", permission: "case.accept",
        transaction: "required", idempotency: "required", tenantScope: "none",
      }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code))
      .toContain("feature-command-tenant-boundary");
  });

  test("generates an explicit command slice scaffold", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      transitions: [{ name: "accept", from: "draft", to: "accepted", permission: "case.accept" }],
    };
    const source = generateFeatureSource(spec);
    expect(source).toContain("defineFeatureSlice");
    expect(source).toContain("Transition1Command");
    expect(source).toContain("Implement case.accept");
    expect(source).toContain('"transaction":"required"');
    expect(source).toContain('"idempotency":"required"');
    expect(source).toContain('"audit":"case.accept"');
    expect(source).toContain('"tenantScope":"required"');
  });
});
