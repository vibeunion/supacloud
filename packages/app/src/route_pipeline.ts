import type { CanActivateFn, CanDeactivateFn, CanMatchFn, ResolveFn } from "./decorators";
import { executeResolvers } from "./decorators";

export interface RoutePipelineContext {
  url: string;
  method: string;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  resolved?: Record<string, unknown>;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RoutePipelineDefinition {
  path: string;
  method: string;
  handler: ((...args: any[]) => any) | string;
  guards?: Array<CanActivateFn | string>;
  canMatch?: Array<CanMatchFn | string>;
  canDeactivate?: Array<CanDeactivateFn | string>;
  resolvers?: Record<string, ResolveFn | string>;
  title?: string;
  data?: Record<string, unknown>;
}

export interface RoutePipelineResult<T = unknown> {
  matched: boolean;
  status: number;
  body?: T;
  error?: string;
  resolvedData?: Record<string, unknown>;
}

/**
 * Executes a full route lifecycle pipeline matching Angular Router execution semantics:
 * 1. canMatch guards check if route can match
 * 2. canActivate guards check access permissions
 * 3. resolvers prefetch data concurrently
 * 4. handler executes
 * 5. canDeactivate guards check teardown/exit safety
 */
export async function executeRoutePipeline<T = unknown>(
  route: RoutePipelineDefinition,
  ctx: RoutePipelineContext,
  componentInstance?: any,
): Promise<RoutePipelineResult<T>> {
  // 1. Evaluate CanMatch guards
  if (route.canMatch && route.canMatch.length > 0) {
    for (const guard of route.canMatch) {
      if (typeof guard === "function") {
        const can = await guard(ctx);
        if (!can) {
          return { matched: false, status: 404, error: "Route match rejected by CanMatch guard" };
        }
      }
    }
  }

  // 2. Evaluate CanActivate guards
  if (route.guards && route.guards.length > 0) {
    for (const guard of route.guards) {
      if (typeof guard === "function") {
        const allowed = await guard(ctx);
        if (!allowed) {
          return { matched: true, status: 403, error: "Route activation rejected by CanActivate guard" };
        }
      }
    }
  }

  // 3. Execute Resolvers
  let resolvedData: Record<string, unknown> | undefined;
  if (route.resolvers && Object.keys(route.resolvers).length > 0) {
    resolvedData = await executeResolvers(route.resolvers, ctx);
    ctx.resolved = { ...(ctx.resolved ?? {}), ...resolvedData };
    ctx.data = { ...(ctx.data ?? {}), ...(route.data ?? {}), ...resolvedData };
  } else if (route.data) {
    ctx.data = { ...(ctx.data ?? {}), ...route.data };
  }

  // 4. Execute Route Handler
  let responseBody: T;
  try {
    if (componentInstance && typeof route.handler === "string" && typeof componentInstance[route.handler] === "function") {
      responseBody = await componentInstance[route.handler](ctx);
    } else if (typeof route.handler === "function") {
      responseBody = await route.handler(ctx);
    } else {
      throw new Error(`Handler '${String(route.handler)}' is not executable on component instance.`);
    }
  } catch (err) {
    return {
      matched: true,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
      resolvedData,
    };
  }

  // 5. Evaluate CanDeactivate guards if component exists
  if (route.canDeactivate && route.canDeactivate.length > 0 && componentInstance) {
    for (const guard of route.canDeactivate) {
      if (typeof guard === "function") {
        const canLeave = await guard(componentInstance, ctx);
        if (!canLeave) {
          return {
            matched: true,
            status: 409,
            body: responseBody,
            error: "Route deactivation rejected by CanDeactivate guard",
            resolvedData,
          };
        }
      }
    }
  }

  return {
    matched: true,
    status: 200,
    body: responseBody,
    resolvedData,
  };
}
