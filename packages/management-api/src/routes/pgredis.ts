import { Elysia, status, t } from "elysia";
import { requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";
import { projectRepository } from "../repositories/project.repository";
import { tenantRuntimeService } from "../services/tenant-runtime.service";
import {
  pgredisRuntimeService,
  type PgredisCacheOperationRequest,
  type PgredisRuntimeService,
} from "../services/pgredis-runtime.service";
import { isAppError } from "../utils/errors";

interface PgredisRoutesDependencies {
  service?: Pick<PgredisRuntimeService, "platformStatus" | "projectStatus" | "refresh" | "execute" | "flush">;
  requireAdmin?: typeof requireAdminAuth;
  requireProject?: typeof requireProjectOrAdminAuth;
  findProject?: typeof projectRepository.findByRef;
  prepareProject?: (projectRef: string) => Promise<void>;
}

const keySchema = t.String({ minLength: 1, maxLength: 512 });
const operationSchema = t.Union([
  t.Object({
    op: t.Union([t.Literal("get"), t.Literal("delete"), t.Literal("ttl"), t.Literal("getdel")]),
    key: keySchema,
  }, { additionalProperties: true }),
  t.Object({
    op: t.Literal("set"),
    key: keySchema,
    value: t.Unknown(),
    ttl_ms: t.Optional(t.Union([t.Integer({ minimum: 0 }), t.Null()])),
  }, { additionalProperties: true }),
  t.Object({
    op: t.Literal("getset"),
    key: keySchema,
    value: t.Unknown(),
  }, { additionalProperties: true }),
]);

export function createPgredisRoutes(dependencies: PgredisRoutesDependencies = {}) {
  const service = dependencies.service ?? pgredisRuntimeService;
  const requireAdmin = dependencies.requireAdmin ?? requireAdminAuth;
  const requireProject = dependencies.requireProject ?? requireProjectOrAdminAuth;
  const findProject = dependencies.findProject ?? projectRepository.findByRef.bind(projectRepository);
  const prepareProject = dependencies.prepareProject
    ?? tenantRuntimeService.ensurePgredisTenantConfig.bind(tenantRuntimeService);

  const platformRoutes = new Elysia({ prefix: "/v1/cache" })
    .beforeHandle(async ({ request }) => {
      const authError = await requireAdmin(request);
      if (authError) return status(authError.status, authError.body);
    })
    .get("", {
      detail: { tags: ["cache"], summary: "Get pgredis runtime platform status" },
    }, () => service.platformStatus());

  const projectRoutes = new Elysia({ prefix: "/v1/projects/:ref/cache" })
    .beforeHandle(async ({ params, request }) => {
      const authError = await requireProject(request, params.ref);
      if (authError) return status(authError.status, authError.body);
    })
    .get("", {
      detail: { tags: ["cache"], summary: "Get project cache status" },
    }, async ({ params }) => {
      const project = await findProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "NOT_FOUND" });
      return await service.projectStatus(params.ref);
    })
    .post("/refresh", {
      detail: { tags: ["cache"], summary: "Refresh the project cache configuration" },
    }, async ({ params }) => {
      const project = await findProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "NOT_FOUND" });
      await prepareProject(params.ref);
      return await service.refresh(params.ref);
    })
    .post("/operations", {
      body: operationSchema,
      detail: { tags: ["cache"], summary: "Execute an exact-key project cache operation" },
    }, async ({ params, body }) => {
      const project = await findProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "NOT_FOUND" });
      const input = body as
        | { op: "get" | "delete" | "ttl" | "getdel"; key: string }
        | { op: "set"; key: string; value: unknown; ttl_ms?: number | null }
        | { op: "getset"; key: string; value: unknown };
      let operation: PgredisCacheOperationRequest;
      if (input.op === "set") {
        operation = { op: input.op, key: input.key, value: input.value, ttlMs: input.ttl_ms };
      } else if (input.op === "getset") {
        operation = { op: input.op, key: input.key, value: input.value };
      } else {
        operation = { op: input.op, key: input.key };
      }
      return await service.execute(params.ref, operation);
    })
    .post("/flush", {
      body: t.Object({ confirmation: t.String({ minLength: 1, maxLength: 64 }) }, {
        additionalProperties: false,
      }),
      detail: { tags: ["cache"], summary: "Flush the project cache namespace" },
    }, async ({ params, body }) => {
      const project = await findProject(params.ref);
      if (!project) return status(404, { message: "Project not found", code: "NOT_FOUND" });
      if (body.confirmation !== params.ref) {
        return status(400, {
          message: "Project cache flush confirmation does not match",
          code: "VALIDATION_ERROR",
        });
      }
      return await service.flush(params.ref);
    });

  return new Elysia({ name: "pgredis-routes" })
    .error(({ error, set }) => {
      if (!isAppError(error)) return;
      set.status = error.statusCode;
      return error.toJSON();
    })
    .use(platformRoutes)
    .use(projectRoutes);
}

export const pgredisRoutes = createPgredisRoutes();
