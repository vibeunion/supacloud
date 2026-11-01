import { Elysia, status, t } from "elysia";
import { parseTenantCapacityBudget } from "@supacloud/delivery/tenant-capacity";
import * as authMiddleware from "../middleware/auth";
import { ApplicationRuntimeAllocations } from "../services/application-runtime-allocation";
import { TenantCapacityPolicies, TenantCapacityUnavailable } from "../services/tenant-capacity";

export interface ProjectCapacityRouteDependencies {
  report?: Pick<ApplicationRuntimeAllocations, "capacityReport" | "capacityHistory" | "setCapacityPolicy">;
  tenantPolicies?: Pick<TenantCapacityPolicies, "read" | "set">;
}

const TenantCapacityBody = t.Object({
  cpu: t.Number({ minimum: 0 }),
  memoryMiB: t.Number({ minimum: 0 }),
  connections: t.Number({ minimum: 0 }),
  queue: t.Number({ minimum: 0 }),
  storageBytes: t.Number({ minimum: 0 }),
  functionConcurrency: t.Number({ minimum: 0 }),
});

export function createProjectCapacityRoutes(dependencies: ProjectCapacityRouteDependencies = {}) {
  const report = dependencies.report ?? new ApplicationRuntimeAllocations();
  const tenantPolicies = dependencies.tenantPolicies ?? new TenantCapacityPolicies();
  return new Elysia({ prefix: "/v1/projects/:ref/capacity" })
    .onBeforeHandle(async ({ params, request }) => {
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
    })
    .get("/tenant", {
      detail: { tags: ["capacity"], summary: "Read tenant CPU, memory, connection, queue, storage, and function concurrency budget" },
    }, async ({ params }) => {
      try {
        return await tenantPolicies.read(params.ref) ?? { projectRef: params.ref, budget: null };
      } catch (error) {
        return status(503, {
          code: "TENANT_CAPACITY_UNAVAILABLE",
          error: "Tenant capacity policy is unavailable",
          details: error instanceof Error ? error.message : String(error),
        });
      }
    })
    .put("/tenant", {
      body: TenantCapacityBody,
      detail: { tags: ["capacity"], summary: "Set tenant CPU, memory, connection, queue, storage, and function concurrency budget" },
    }, async ({ params, body }) => {
      const budget = parseTenantCapacityBudget(body);
      if (!budget) {
        return status(400, { code: "TENANT_CAPACITY_BUDGET_INVALID", error: "Tenant capacity budget is invalid" });
      }
      try {
        return await tenantPolicies.set(params.ref, budget);
      } catch (error) {
        if (error instanceof TenantCapacityUnavailable) {
          return status(503, { code: error.message, error: "Tenant capacity policy is unavailable" });
        }
        return status(400, {
          code: "TENANT_CAPACITY_BUDGET_INVALID",
          error: "Tenant capacity budget is invalid",
          details: error instanceof Error ? error.message : String(error),
        });
      }
    });
}

export const projectCapacityRoutes = createProjectCapacityRoutes();
