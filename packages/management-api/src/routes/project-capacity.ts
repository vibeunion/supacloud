import { Elysia, status, t } from "elysia";
import * as authMiddleware from "../middleware/auth";
import { ApplicationRuntimeAllocations } from "../services/application-runtime-allocation";

export interface ProjectCapacityRouteDependencies {
  report?: Pick<ApplicationRuntimeAllocations, "capacityReport" | "capacityHistory" | "setCapacityPolicy">;
}

export function createProjectCapacityRoutes(dependencies: ProjectCapacityRouteDependencies = {}) {
  const report = dependencies.report ?? new ApplicationRuntimeAllocations();
  return new Elysia({ prefix: "/v1/projects/:ref/capacity" })
    .beforeHandle(async ({ params, request }) => {
      const authError = await authMiddleware.requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
    })
    .get("", {
      detail: { tags: ["capacity"], summary: "Read application capacity and noisy-neighbor isolation report" },
    }, async ({ params }) => {
      try {
        return await report.capacityReport(params.ref);
      } catch (error) {
        return status(503, {
          code: "APPLICATION_CAPACITY_UNAVAILABLE",
          error: "Application capacity report is unavailable",
          details: error instanceof Error ? error.message : String(error),
        });
      }
    })
    .get("/history", {
      query: t.Optional(t.Object({ limit: t.Optional(t.String()) })),
      detail: { tags: ["capacity"], summary: "Read application capacity history" },
    }, async ({ params, query }) => {
      const rawLimit = query.limit ? Number(query.limit) : undefined;
      if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200)) {
        return status(400, { code: "CAPACITY_HISTORY_LIMIT_INVALID", error: "limit must be an integer between 1 and 200" });
      }
      try {
        return { projectRef: params.ref, history: await report.capacityHistory(params.ref, rawLimit) };
      } catch (error) {
        return status(503, {
          code: "APPLICATION_CAPACITY_HISTORY_UNAVAILABLE",
          error: "Application capacity history is unavailable",
          details: error instanceof Error ? error.message : String(error),
        });
      }
    })
    .put("", {
      body: t.Object({
        cpu: t.Number({ minimum: 0 }),
        memoryMiB: t.Number({ minimum: 0 }),
        connections: t.Number({ minimum: 0 }),
        concurrency: t.Number({ minimum: 0 }),
        ports: t.Number({ minimum: 0 }),
      }),
      detail: { tags: ["capacity"], summary: "Set project application capacity policy" },
    }, async ({ params, body }) => {
      try {
        return await report.setCapacityPolicy(params.ref, body);
      } catch (error) {
        return status(400, {
          code: "APPLICATION_CAPACITY_POLICY_INVALID",
          error: "Application capacity policy is invalid",
          details: error instanceof Error ? error.message : String(error),
        });
      }
    });
}

export const projectCapacityRoutes = createProjectCapacityRoutes();
