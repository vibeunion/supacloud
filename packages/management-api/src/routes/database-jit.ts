import { Elysia, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import {
  JitDatabaseAccessError,
  jitDatabaseAccessService,
  type JitAccessState,
} from "../services/jit-database-access.service";

function authResponse(authError: { status: number; body: { error: string } }, set: { status?: number | string }) {
  set.status = authError.status;
  return { message: authError.body.error, code: String(authError.status), status: authError.status };
}

async function run<T>(set: { status?: number | string }, operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof JitDatabaseAccessError) {
      set.status = error.statusCode;
      return { message: error.message, code: error.code, status: error.statusCode };
    }
    throw error;
  }
}

export const databaseJitRoutes = new Elysia({ prefix: "/v1/projects/:ref/database" })
  .get("/jit-access", async ({ params, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    return run(set, () => jitDatabaseAccessService.state(params.ref));
  }, { detail: { tags: ["projects", "database"], summary: "Get temporary database access state" } })
  .put("/jit-access", async ({ params, body, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    return run(set, () => jitDatabaseAccessService.setState(params.ref, body.state as JitAccessState));
  }, {
    body: t.Object({ state: t.Union([t.Literal("enabled"), t.Literal("disabled")]) }),
    detail: { tags: ["projects", "database"], summary: "Enable or disable temporary database access" },
  })
  .get("/jit", async ({ params, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    return run(set, () => jitDatabaseAccessService.listRules(params.ref));
  }, { detail: { tags: ["projects", "database"], summary: "List temporary database access rules" } })
  .put("/jit", async ({ params, body, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    return run(set, () => jitDatabaseAccessService.replaceRules(params.ref, body));
  }, {
    body: t.Object({
      user_id: t.String({ minLength: 1, maxLength: 200 }),
      user_roles: t.Array(t.Object({
        role: t.String({ minLength: 1, maxLength: 63 }),
        expires_at: t.Number(),
        allowed_networks: t.Optional(t.Object({
          allowed_cidrs: t.Optional(t.Array(t.Object({ cidr: t.String({ minLength: 3, maxLength: 64 }) }), { maxItems: 64 })),
          allowed_cidrs_v6: t.Optional(t.Array(t.Object({ cidr: t.String({ minLength: 3, maxLength: 128 }) }), { maxItems: 64 })),
        })),
        branches_only: t.Optional(t.Boolean()),
      }), { maxItems: 32 }),
    }),
    detail: { tags: ["projects", "database"], summary: "Replace temporary database access rules for a user" },
  })
  .post("/jit/credentials", async ({ params, body, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    return run(set, () => jitDatabaseAccessService.issueCredential(params.ref, body));
  }, {
    body: t.Object({
      user_id: t.String({ minLength: 1, maxLength: 200 }),
      role: t.String({ minLength: 1, maxLength: 63 }),
    }),
    detail: { tags: ["projects", "database"], summary: "Issue a temporary PostgreSQL credential" },
  })
  .delete("/jit/credentials/:id", async ({ params, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    return run(set, () => jitDatabaseAccessService.revokeCredential(params.ref, params.id));
  }, { detail: { tags: ["projects", "database"], summary: "Revoke a temporary PostgreSQL credential" } });
