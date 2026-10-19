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
  providers: [{
    token: "AcceptCommand", tokenKind: "class", kind: "class", useClass: "AcceptCommand",
    scope: "request", deps: [], exported: false, file: "case.command.ts", line: 1,
  }],
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
  test("retains the explicit database source and derived row type", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-feature-database-"));
    await writeFile(join(root, "feature.ts"), [
      "const spec = defineFeatureSpec({",
      '  name: "case", states: ["draft", "accepted"],',
      '  database: { source: "db/schema.ts", table: "public.reviews", rowType: "ReviewRow" },',
      '  transitions: { accept: { from: "draft", to: "accepted" } },',
      "});",
      "const CaseFeature = defineFeatureSlice({ name: \"case\", spec, tags: [\"type:feature\"] });",
      "",
    ].join("\n"), "utf8");
    const graph = await analyzeProject(root);
    expect(graph.modules[0]?.featureSpec?.database).toEqual({
      source: "db/schema.ts", table: "public.reviews", rowType: "ReviewRow",
    });
  });

  test("blocks a source feature that omits its database provenance", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      file: "src/features/case/case.feature.ts",
      line: 1,
      transitions: [{
        name: "accept", from: "draft", to: "accepted",
        command: "AcceptCommand", permission: "case.accept",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", tenantField: "tenant_id", stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    expect(validateFeatureSpec(spec).map((diagnostic) => diagnostic.code))
      .toContain("feature-database-source-required");
  });

  test("blocks required Feature adapters that are not registered", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      requiredAdapters: ["CaseReader", "CaseWriter"],
      transitions: [],
    };
    expect(validateFeatureSpec(spec, baseModule(spec)).map((diagnostic) => diagnostic.code))
      .toContain("feature-adapter-unresolved");
  });

  test("accepts required Feature adapters registered by token or implementation", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      requiredAdapters: ["CaseReader", "CaseWriter"],
      transitions: [],
    };
    const module: ModuleNode = {
      ...baseModule(spec),
      providers: [
        ...baseModule(spec).providers,
        {
          token: "CaseReader", tokenKind: "injection-token", kind: "class",
          useClass: "DatabaseCaseReader", scope: "request", deps: [],
          exported: false, file: "case.adapter.ts", line: 1,
        },
        {
          token: "CaseWriter", tokenKind: "injection-token", kind: "class",
          useClass: "CaseWriter", scope: "request", deps: [],
          exported: false, file: "case.adapter.ts", line: 2,
        },
      ],
    };
    expect(validateFeatureSpec(spec, module)).toEqual([]);
  });

  test("rejects required Feature adapters with the wrong scope", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      requiredAdapters: ["CaseRefresher"],
      requiredAdapterScopes: { CaseRefresher: "job" },
      transitions: [],
    };
    const module: ModuleNode = {
      ...baseModule(spec),
      providers: [{
        token: "CaseRefresher", tokenKind: "injection-token", kind: "value",
        scope: "request", deps: [], exported: false, file: "case.adapter.ts", line: 1,
      }],
    };
    expect(validateFeatureSpec(spec, module).map((diagnostic) => diagnostic.code))
      .toContain("feature-adapter-provider-scope");
  });

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

  test("rejects feature commands with application scope", () => {
    const spec: FeatureSpecNode = {
      name: "case", states: ["draft", "accepted"], tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted", command: "AcceptCommand",
        permission: "case.accept",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", tenantField: "tenant_id", stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    const module = {
      ...baseModule(spec),
      providers: [{
        token: "AcceptCommand", tokenKind: "class" as const, kind: "class" as const,
        useClass: "AcceptCommand", scope: "application" as const, deps: [],
        exported: false, file: "case.command.ts", line: 1,
      }],
    };
    expect(validateFeatureSpec(spec, module).map((diagnostic) => diagnostic.code))
      .toContain("feature-command-provider-scope");
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

  test("rejects invalidation tags that are absent from the module query surface", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted", command: "AcceptCommand",
        permission: "case.accept", route: "POST /cases/:id/accept",
        invalidateTags: ["case.list", "case.typo"],
      }],
    };
    const module = {
      ...baseModule(spec),
      controllers: [{
        ...baseModule(spec).controllers[0]!,
        routes: [{
          ...baseModule(spec).controllers[0]!.routes[0]!,
          tags: ["case.list"],
        }],
      }],
    };
    expect(validateFeatureSpec(spec, module).map((diagnostic) => diagnostic.code))
      .toContain("feature-invalidation-tag-unresolved");
  });

  test("requires invalidation tags for database transitions with a query surface", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted", command: "AcceptCommand",
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
        routes: [{
          ...baseModule(spec).controllers[0]!.routes[0]!,
          tags: ["case.list"],
        }],
      }],
    };
    expect(validateFeatureSpec(spec, module).map((diagnostic) => diagnostic.code))
      .toContain("feature-invalidation-tags-required");
  });

  test("requires invalidation tags for external transitions with a query surface", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "submitted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "submit", from: "draft", to: "submitted", command: "SubmitCommand",
        permission: "case.submit", route: "POST /cases/:id/submit",
        persistence: {
          boundary: "external", optimisticLock: "none",
          receipt: "required", reconciliation: "required",
        },
      }],
    };
    const module = {
      ...baseModule(spec),
      controllers: [{
        ...baseModule(spec).controllers[0]!,
        routes: [{
          ...baseModule(spec).controllers[0]!.routes[0]!,
          path: "/:id/submit",
          tags: ["case.list"],
        }],
      }],
      commands: [{
        className: "SubmitCommand", name: "case.submit", permission: "case.submit",
        transaction: "none" as const, idempotency: "required" as const, audit: "case.submitted",
        tenantScope: "required" as const,
      }],
    };
    expect(validateFeatureSpec(spec, module).map((diagnostic) => diagnostic.code))
      .toContain("feature-invalidation-tags-required");
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

  test("rejects feature queries that are not registered as providers", () => {
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
    const module = {
      ...baseModule(spec),
      queries: [{ className: "ListCaseQuery", name: "case.list", permission: "case.read", tenantScope: "required" as const }],
    };
    expect(validateFeatureSpec(spec, module).map((diagnostic) => diagnostic.code))
      .toContain("feature-query-provider-unresolved");
  });

  test("rejects feature queries with application scope", () => {
    const spec: FeatureSpecNode = {
      name: "case", states: ["draft", "accepted"], tenantField: "tenant_id",
      transitions: [{
        name: "accept", from: "draft", to: "accepted",
        persistence: {
          boundary: "database", optimisticLock: "required",
          versionField: "version", tenantField: "tenant_id", stateField: "state",
          receipt: "required", reconciliation: "none",
        },
      }],
    };
    const module = {
      ...baseModule(spec),
      providers: [{
        token: "ListCaseQuery", tokenKind: "class" as const, kind: "class" as const,
        useClass: "ListCaseQuery", scope: "application" as const, deps: [],
        exported: false, file: "case.query.ts", line: 1,
      }],
      queries: [{ className: "ListCaseQuery", name: "case.list", tenantScope: "required" as const }],
    };
    expect(validateFeatureSpec(spec, module).map((diagnostic) => diagnostic.code))
      .toContain("feature-query-provider-scope");
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

  test("requires tenant-scoped queries for external features", () => {
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
    const diagnostics = validateFeatureSpec(spec, {
      ...baseModule(spec),
      queries: [{ className: "ListCaseQuery", name: "case.list", tenantScope: "none" }],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code))
      .toContain("feature-query-tenant-boundary");
  });

  test("requires tenant-scoped jobs for external features", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "submitted"],
      tenantField: "tenant_id",
      transitions: [{
        name: "submit", from: "draft", to: "submitted", job: "case.reconcile",
        persistence: {
          boundary: "external", optimisticLock: "none",
          receipt: "required", reconciliation: "required",
        },
      }],
    };
    const diagnostics = validateFeatureSpec(spec, {
      ...baseModule(spec),
      jobs: [{
        className: "ReconcileCaseJob", name: "case.reconcile", serviceKey: "reconcileCaseJob",
        scope: "job", input: "ReconcileCaseInput", tenantScope: "none",
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

  test("rejects feature Jobs that are not registered as providers", () => {
    const spec: FeatureSpecNode = {
      name: "case",
      states: ["draft", "accepted"],
      tenantField: "tenant_id",
      transitions: [{ name: "accept", from: "draft", to: "accepted", job: "case.refresh" }],
    };
    const module = {
      ...baseModule(spec),
      jobs: [{
        className: "RefreshCaseJob", name: "case.refresh", serviceKey: "refreshCaseJob",
        scope: "job", input: "RefreshCaseInput", schemaKinds: { input: "declared" as const },
        tenantScope: "required" as const, idempotency: "required" as const, mode: "task" as const,
      }],
    };
    expect(validateFeatureSpec(spec, module).map((diagnostic) => diagnostic.code))
      .toContain("feature-job-provider-unresolved");
  });

  test("rejects feature Jobs with request scope", () => {
    const spec: FeatureSpecNode = {
      name: "case", states: ["draft", "accepted"], tenantField: "tenant_id",
      transitions: [{ name: "accept", from: "draft", to: "accepted", job: "case.refresh" }],
    };
    const module = {
      ...baseModule(spec),
      providers: [{
        token: "RefreshCaseJob", tokenKind: "class" as const, kind: "class" as const,
        useClass: "RefreshCaseJob", scope: "request" as const, deps: [],
        exported: false, file: "case.job.ts", line: 1,
      }],
      jobs: [{
        className: "RefreshCaseJob", name: "case.refresh", serviceKey: "refreshCaseJob",
        scope: "job" as const, input: "RefreshCaseInput", schemaKinds: { input: "declared" as const },
        tenantScope: "required" as const, idempotency: "required" as const, mode: "task" as const,
      }],
    };
    expect(validateFeatureSpec(spec, module).map((diagnostic) => diagnostic.code))
      .toContain("feature-job-provider-scope");
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
