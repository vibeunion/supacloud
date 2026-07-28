import { Elysia, t } from "elysia";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { DatabaseWrapperError, databaseWrapperService } from "../services/database-wrapper.service";

function authResponse(authError: { status: number; body: { error: string } }, set: { status?: number | string }) {
  set.status = authError.status;
  return { message: authError.body.error, code: String(authError.status), status: authError.status };
}

export const databaseWrapperRoutes = new Elysia({ prefix: "/v1/projects/:ref/database/wrappers" })
  .get("/", async ({ params, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    return databaseWrapperService.list(params.ref);
  }, { detail: { tags: ["projects", "database", "wrappers"], summary: "List foreign data wrappers" } })
  .post("/", async ({ params, body, request, set }) => {
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return authResponse(authError, set);
    try {
      const result = await databaseWrapperService.create(params.ref, body);
      set.status = 201;
      return result;
    } catch (error) {
      if (error instanceof DatabaseWrapperError) {
        set.status = error.statusCode;
        return { message: error.message, code: error.code, status: error.statusCode };
      }
      throw error;
    }
  }, {
    body: t.Object({
      type: t.Union([t.Literal("stripe"), t.Literal("mongodb")]),
      server_name: t.Optional(t.String({ maxLength: 63 })),
      schema_name: t.Optional(t.String({ maxLength: 63 })),
      credential: t.String({ minLength: 1, maxLength: 64 * 1024 }),
      api_version: t.Optional(t.String({ maxLength: 64 })),
    }),
    detail: { tags: ["projects", "database", "wrappers"], summary: "Configure a Vault-backed Stripe or MongoDB wrapper" },
  });
