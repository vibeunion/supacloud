/**
 * Diagnostics API Routes
 * Read-only checks by default; repairs require explicit admin authorization.
 */
import { Elysia, t, status } from "elysia";
import { requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";
import * as diag from "../services/diagnostics.service";
import { getAllChecks } from "../services/diagnostics.registry";

const runBody = t.Optional(t.Object({
  check_ids: t.Optional(t.Array(t.String())),
}));

const diagnosticsApi = new Elysia({ prefix: "/v1/diagnostics" })
  .beforeHandle(async ({ request }) => {
    const authError = await requireAdminAuth(request);
    if (authError) return status(authError.status, authError.body);
  })
  .get("/checks", {
    detail: { tags: ["diagnostics"], summary: "List available diagnostic checks" },
  }, () => {
    return getAllChecks().map((check) => ({
      id: check.id,
      name: check.name,
      description: check.description,
      category: check.category,
      scope: check.scope,
      severity: check.severity,
      repairable: check.repairable,
    }));
  })
  .post("/runs", {
    body: runBody,
    detail: { tags: ["diagnostics"], summary: "Run platform-level diagnostics" },
  }, async ({ request, body }) => {
    return diag.runDiagnostics("platform", undefined, body?.check_ids);
  })
  .get("/runs/:id", {
    params: t.Object({ id: t.String() }),
    detail: { tags: ["diagnostics"], summary: "Get diagnostic run status" },
  }, async ({ params }) => {
    const run = await diag.getRun(params.id);
    if (!run) return status(404, { error: "Run not found" });
    return run;
  })
  .get("/runs/:id/results", {
    params: t.Object({ id: t.String() }),
    detail: { tags: ["diagnostics"], summary: "Get diagnostic run results" },
  }, async ({ params }) => {
    const run = await diag.getRun(params.id);
    if (!run) return status(404, { error: "Run not found" });
    return { run, results: await diag.getRunResults(params.id) };
  })
  .get("/runs", {
    query: t.Object({
      scope: t.Optional(t.String()),
      project_ref: t.Optional(t.String()),
      limit: t.Optional(t.String()),
    }),
    detail: { tags: ["diagnostics"], summary: "List diagnostic runs" },
  }, async ({ query }) => {
    return diag.listRuns({
      scope: query.scope === "platform" || query.scope === "project" ? query.scope : undefined,
      projectRef: query.project_ref || undefined,
      limit: query.limit ? parseInt(query.limit, 10) : 20,
    });
  })
  .post("/results/:id/repair", {
    params: t.Object({ id: t.String() }),
    detail: { tags: ["diagnostics"], summary: "Repair a diagnostic issue (admin only)" },
  }, async ({ params, request }) => {
    return diag.executeRepair(params.id);
  })
  .post("/baseline", {
    body: t.Object({
      scope: t.Optional(t.String()),
      project_ref: t.Optional(t.String()),
    }),
    detail: { tags: ["diagnostics"], summary: "Snapshot diagnostic baseline (admin only)" },
  }, async ({ request, body }) => {
    const scope = body.scope === "project" ? "project" : "platform";
    return diag.snapshotBaseline(scope, body.project_ref || undefined);
  });

const projectDiagnosticsApi = new Elysia({ prefix: "/v1/projects/:ref/diagnostics" })
  .get("/checks", {
    params: t.Object({ ref: t.String() }),
    detail: { tags: ["diagnostics"], summary: "List project diagnostic checks" },
  }, async ({ params, request }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
    return getAllChecks()
      .filter((check) => check.scope === "project")
      .map((check) => ({
        id: check.id,
        name: check.name,
        description: check.description,
        category: check.category,
        severity: check.severity,
        repairable: check.repairable,
      }));
  })
  .post("/runs", {
    params: t.Object({ ref: t.String() }),
    body: runBody,
    detail: { tags: ["diagnostics"], summary: "Run project-level diagnostics" },
  }, async ({ params, request, body }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
    return diag.runDiagnostics("project", params.ref, body?.check_ids);
  })
  .get("/runs", {
    params: t.Object({ ref: t.String() }),
    query: t.Object({ limit: t.Optional(t.String()) }),
    detail: { tags: ["diagnostics"], summary: "List project diagnostic runs" },
  }, async ({ params, request, query }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
    return diag.listRuns({
      scope: "project",
      projectRef: params.ref,
      limit: query.limit ? parseInt(query.limit, 10) : 20,
    });
  })
  .get("/runs/:id", {
    params: t.Object({ ref: t.String(), id: t.String() }),
    detail: { tags: ["diagnostics"], summary: "Get project diagnostic run" },
  }, async ({ params, request }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
    const run = await diag.getRun(params.id);
    if (!run || run.scope !== "project" || run.projectRef !== params.ref) {
      return status(404, { error: "Run not found" });
    }
    return run;
  })
  .get("/runs/:id/results", {
    params: t.Object({ ref: t.String(), id: t.String() }),
    detail: { tags: ["diagnostics"], summary: "Get project diagnostic results" },
  }, async ({ params, request }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
    const run = await diag.getRun(params.id);
    if (!run || run.scope !== "project" || run.projectRef !== params.ref) {
      return status(404, { error: "Run not found" });
    }
    return { run, results: await diag.getRunResults(params.id) };
  });

export const diagnosticsRoutes = new Elysia({ name: "diagnostics-routes" })
  .use(diagnosticsApi)
  .use(projectDiagnosticsApi);
