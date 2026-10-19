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
    transaction: "required", idempotency: "required", audit: "case.accepted", tenantScope: "required",
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
      '  transitions: { accept: { from: "draft", to: "accepted", job: "case.refresh" } },',
      "});",
      "const CaseFeature = defineFeatureSlice({ name: \"case\", spec, tags: [\"type:feature\"] });",
      "",
    ].join("\n"), "utf8");
    const graph = await analyzeProject(root);
    expect(graph.modules).toHaveLength(1);
    expect(graph.modules[0]?.tags).toEqual(["type:feature"]);
    expect(graph.modules[0]?.featureSpec?.transitions[0]?.to).toBe("accepted");
    expect(graph.modules[0]?.featureSpec?.transitions[0]?.job).toBe("case.refresh");
  });

  test("accepts controller-owned route bindings without weakening route existence checks", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted", command: "AcceptCommand",
        permission: "case.accept", route: "POST /cases/:id/accept",
        routeBinding: "controller",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", tenantField: "tenant_id", stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    const module = {
      ...baseModule(spec),
      controllers: [{
        ...baseModule(spec).controllers[0]!,
        routes: [{ ...baseModule(spec).controllers[0]!.routes[0]!, command: undefined }],
      }],
    };
    expect(validateFeatureSpec(spec, module)).toEqual([]);
  });

  test("accepts logical command names for framework-owned feature routes", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted", command: "case.accept",
        permission: "case.accept", route: "POST /cases/:id/accept",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", tenantField: "tenant_id", stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    const module = {
      ...baseModule(spec),
      controllers: [{
        ...baseModule(spec).controllers[0]!,
        routes: [{ ...baseModule(spec).controllers[0]!.routes[0]!, command: "case.accept" }],
      }],
    };
    expect(validateFeatureSpec(spec, module)).toEqual([]);
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
      "feature-governance-drift",
    ]);
  });

  test("rejects empty and duplicate query invalidation tags", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted", command: "AcceptCommand",
        permission: "case.accept",
        invalidateTags: ["case.list", "case.list", " "],
      }],
    };
    expect(validateFeatureSpec(spec, baseModule(spec)).map((diagnostic) => diagnostic.code))
      .toContain("feature-invalidation-tags-invalid");
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
      tenantField: "tenant_id",
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

  test("binds transition jobs and requires durable replay governance", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted", job: "case.refresh",
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
        scope: "job", input: "RefreshCaseInput", tenantScope: "required", idempotency: "none", mode: "task",
      }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code))
      .toContain("feature-job-idempotency");
  });

  test("requires an explicit execution mode for transition jobs", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{ name: "accept", from: "draft", to: "accepted", job: "case.refresh" }],
    };
    const diagnostics = validateFeatureSpec(spec, {
      ...baseModule(spec),
      jobs: [{
        className: "RefreshCaseJob", name: "case.refresh", serviceKey: "refreshCaseJob",
        scope: "job", input: "RefreshCaseInput", tenantScope: "required", idempotency: "required",
      }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("feature-job-mode");
  });

  test("requires a typed input contract for transition jobs", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{ name: "accept", from: "draft", to: "accepted", job: "case.refresh" }],
    };
    const diagnostics = validateFeatureSpec(spec, {
      ...baseModule(spec),
      jobs: [{
        className: "RefreshCaseJob", name: "case.refresh", serviceKey: "refreshCaseJob",
        scope: "job", tenantScope: "required", idempotency: "required", mode: "task",
      }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("feature-job-contract");
  });

  test("requires trusted job context injection for tenant-scoped transition jobs", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{ name: "accept", from: "draft", to: "accepted", job: "case.refresh" }],
    };
    const diagnostics = validateFeatureSpec(spec, {
      ...baseModule(spec),
      providers: [{
        token: "RefreshCaseJob", tokenKind: "class", kind: "class", useClass: "RefreshCaseJob",
        scope: "job", deps: [], exported: false, file: "case.feature.ts", line: 1,
      }],
      jobs: [{
        className: "RefreshCaseJob", name: "case.refresh", serviceKey: "refreshCaseJob",
        scope: "job", input: "RefreshCaseInput", tenantScope: "required",
        idempotency: "required", mode: "task",
      }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("feature-job-context");
  });

  test("rejects opaque transition Job input contracts", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{ name: "accept", from: "draft", to: "accepted", job: "case.refresh" }],
    };
    const diagnostics = validateFeatureSpec(spec, {
      ...baseModule(spec),
      jobs: [{
        className: "RefreshCaseJob", name: "case.refresh", serviceKey: "refreshCaseJob",
        scope: "job", input: "RefreshCaseInput", schemaKinds: { input: "opaque" },
        tenantScope: "required", idempotency: "required", mode: "task",
      }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("feature-job-contract");
  });

  test("requires a reconciliation Job for external transitions", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "submitted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "submit", from: "draft", to: "submitted",
        persistence: {
          boundary: "external", optimisticLock: "none",
          receipt: "required", reconciliation: "required",
        },
      }],
    };
    expect(validateFeatureSpec(spec, baseModule(spec)).map((diagnostic) => diagnostic.code))
      .toContain("feature-job-unresolved");
  });

  test("rejects a transition Job that is not registered in its Feature module", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{ name: "accept", from: "draft", to: "accepted", job: "case.missing" }],
    };
    expect(validateFeatureSpec(spec, baseModule(spec)).map((diagnostic) => diagnostic.code))
      .toContain("feature-job-unresolved");
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

  test("requires external transitions to avoid database transactions", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "submitted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "submit", from: "draft", to: "submitted", command: "SubmitCase",
        permission: "case.submit",
        persistence: {
          boundary: "external", optimisticLock: "none",
          receipt: "required", reconciliation: "required",
        },
      }],
    };
    const diagnostics = validateFeatureSpec(spec, {
      ...baseModule(spec),
      commands: [{
        className: "SubmitCase", name: "case.submit", permission: "case.submit",
        transaction: "required", idempotency: "required", audit: "case.submitted",
        tenantScope: "required",
      }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code))
      .toContain("feature-persistence-drift");
  });

  test("generates an explicit command slice scaffold", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted", permission: "case.accept",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", tenantField: "tenant_id", stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
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
