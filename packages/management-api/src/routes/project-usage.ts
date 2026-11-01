import { Elysia, status, t } from "elysia";
import * as authMiddleware from "../middleware/auth";
import {
  isClientUsageError,
  parseUsageDimension,
  parseUsageLimit,
  parseUsageProjectRef,
  parseUsageWindow,
  usageErrorText,
  UsageMeterError,
  type UsageMeterReader,
} from "../services/usage-meter";

export type ProjectUsageAuthorizer = (
  request: Request,
  ref: string,
) => Promise<{ status: number; body: { error: string } } | undefined>;

export interface ProjectUsageRouteDependencies {
  meter?: UsageMeterReader;
  authorize?: ProjectUsageAuthorizer;
}

const usageQuery = t.Object({
  from: t.Optional(t.String()),
  to: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  dimension: t.Optional(t.String()),
});

async function defaultMeter(): Promise<UsageMeterReader> {
  const { UsageMeterStore } = await import("../repositories/usage-meter-store");
  return new UsageMeterStore();
}

function failed(error: unknown) {
  if (error instanceof UsageMeterError) {
    return status(isClientUsageError(error) ? 400 : 500, {
      code: error.code,
      error: usageErrorText(error.code),
    });
  }
  return status(503, {
    code: "USAGE_METER_UNAVAILABLE",
    error: "Usage meter is unavailable",
  });
}

/**
 * Read recorded usage. Recording stays on the in-process ledger so a caller
 * cannot submit its own quantities. Responses carry no price and no charge.
 */
export function createProjectUsageRoutes(dependencies: ProjectUsageRouteDependencies = {}) {
  const authorize = dependencies.authorize ?? authMiddleware.requireProjectOrAdminAuth;
  const meter = () => dependencies.meter ?? defaultMeter();
  // /v1/projects/:ref/usage stays the pg_stat metrics route in project-services.
  return new Elysia({ name: "project-usage", prefix: "/v1/projects/:ref/usage-meter" })
    .onBeforeHandle(async ({ params, request }) => {
      const authError = await authorize(request, params.ref);
      if (authError) return status(authError.status, authError.body);
    })
    .get("/receipts", {
      query: usageQuery,
      detail: {
        tags: ["usage"],
        summary: "Read append-only CPU, storage, and function usage receipts",
      },
    }, async ({ params, query }) => {
      try {
        parseUsageProjectRef(params.ref);
        return {
          projectRef: params.ref,
          receipts: await (await meter()).receipts(params.ref, {
            dimension: parseUsageDimension(query.dimension),
            from: query.from || undefined,
            to: query.to || undefined,
            limit: parseUsageLimit(query.limit),
          }),
        };
      } catch (error) {
        return failed(error);
      }
    })
    .get("/counters", {
      query: usageQuery,
      detail: {
        tags: ["usage"],
        summary: "Read hourly sums of recorded CPU, storage, and function use",
      },
    }, async ({ params, query }) => {
      try {
        parseUsageProjectRef(params.ref);
        return {
          projectRef: params.ref,
          counters: await (await meter()).counters(params.ref, {
            from: query.from || undefined,
            to: query.to || undefined,
            limit: parseUsageLimit(query.limit),
          }),
        };
      } catch (error) {
        return failed(error);
      }
    })
    .get("", {
      query: usageQuery,
      detail: {
        tags: ["usage"],
        summary: "Read recorded usage for a later chargeback reader",
        description: "Quantities are additive and unpriced. This route does not invoice or charge.",
      },
    }, async ({ params, query }) => {
      try {
        parseUsageProjectRef(params.ref);
        const window = parseUsageWindow(query.from, query.to);
        return await (await meter()).reading(params.ref, window.windowStart, window.windowEnd);
      } catch (error) {
        return failed(error);
      }
    });
}

export const projectUsageRoutes = createProjectUsageRoutes();
