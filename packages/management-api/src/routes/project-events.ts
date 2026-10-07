import { Elysia, status, t } from "elysia";
import * as authMiddleware from "../middleware/auth";
import { listUnifiedEvents } from "../services/unified-event.service";

export interface ProjectEventRouteDependencies {
  authorize?: typeof authMiddleware.requireProjectOrAdminAuth;
  list?: typeof listUnifiedEvents;
}

export function createProjectEventRoutes(dependencies: ProjectEventRouteDependencies = {}) {
  const authorize = dependencies.authorize ?? authMiddleware.requireProjectOrAdminAuth;
  const list = dependencies.list ?? listUnifiedEvents;
  return new Elysia({ prefix: "/v1/projects/:ref/events" })
    .beforeHandle(async ({ params, request }) => {
      const authError = await authorize(request, params.ref);
      if (authError) return status(authError.status, authError.body);
    })
    .get("", {
      query: t.Optional(t.Object({
        kind: t.Optional(t.String()),
        status: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        cursor: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
      })),
      detail: { tags: ["events"], summary: "List unified project events" },
    }, async ({ params, query }) => {
      const rawLimit = query.limit ? Number(query.limit) : undefined;
      if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200)) {
        return status(400, { error: "limit must be an integer between 1 and 200", code: "EVENT_LIMIT_INVALID" });
      }
      try {
        return await list({
          projectRef: params.ref,
          kind: query.kind,
          status: query.status,
          limit: rawLimit,
          cursor: query.cursor,
        });
      } catch (error) {
        return status(503, {
          error: "Unified event projection is unavailable",
          code: "EVENT_PROJECTION_UNAVAILABLE",
          details: error instanceof Error ? error.message : String(error),
        });
      }
    });
}

export const projectEventRoutes = createProjectEventRoutes();
