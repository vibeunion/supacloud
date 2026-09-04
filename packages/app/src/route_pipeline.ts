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

export type RouterEventType =
  | "NavigationStart"
  | "RoutesRecognized"
  | "GuardsCheckStart"
  | "GuardsCheckEnd"
  | "ResolveStart"
  | "ResolveEnd"
  | "ExecutionStart"
  | "ExecutionEnd"
  | "NavigationEnd"
  | "NavigationCancel"
  | "NavigationError";

export interface RouterEvent {
  type: RouterEventType;
  url: string;
  timestamp: number;
  data?: unknown;
}

export interface RoutePipelineOptions {
  onEvent?: (event: RouterEvent) => void;
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
  options?: RoutePipelineOptions,
): Promise<RoutePipelineResult<T>> {
  const emit = (type: RouterEventType, data?: unknown) => {
    if (options?.onEvent) {
      options.onEvent({
        type,
        url: ctx.url,
        timestamp: Date.now(),
        data,
      });
    }
  };

  emit("NavigationStart");
  emit("RoutesRecognized", { method: route.method, path: route.path });

  // 1. Evaluate CanMatch guards
  if (route.canMatch && route.canMatch.length > 0) {
    emit("GuardsCheckStart", { stage: "canMatch" });
    for (const guard of route.canMatch) {
      if (typeof guard === "function") {
        const can = await guard(ctx);
        if (!can) {
          emit("GuardsCheckEnd", { stage: "canMatch", allowed: false });
          emit("NavigationCancel", { reason: "CanMatch guard rejected" });
          return { matched: false, status: 404, error: "Route match rejected by CanMatch guard" };
        }
      }
    }
    emit("GuardsCheckEnd", { stage: "canMatch", allowed: true });
  }

  // 2. Evaluate CanActivate guards
  if (route.guards && route.guards.length > 0) {
    emit("GuardsCheckStart", { stage: "canActivate" });
    for (const guard of route.guards) {
      if (typeof guard === "function") {
        const allowed = await guard(ctx);
        if (!allowed) {
          emit("GuardsCheckEnd", { stage: "canActivate", allowed: false });
          emit("NavigationCancel", { reason: "CanActivate guard rejected" });
          return { matched: true, status: 403, error: "Route activation rejected by CanActivate guard" };
        }
      }
    }
    emit("GuardsCheckEnd", { stage: "canActivate", allowed: true });
  }

  // 3. Execute Resolvers
  let resolvedData: Record<string, unknown> | undefined;
  if (route.resolvers && Object.keys(route.resolvers).length > 0) {
    emit("ResolveStart", { keys: Object.keys(route.resolvers) });
    resolvedData = await executeResolvers(route.resolvers, ctx);
    ctx.resolved = { ...(ctx.resolved ?? {}), ...resolvedData };
    ctx.data = { ...(ctx.data ?? {}), ...(route.data ?? {}), ...resolvedData };
    emit("ResolveEnd", { keys: Object.keys(route.resolvers) });
  } else if (route.data) {
    ctx.data = { ...(ctx.data ?? {}), ...route.data };
  }

  // 4. Execute Route Handler
  let responseBody: T;
  try {
    emit("ExecutionStart");
    if (componentInstance && typeof route.handler === "string" && typeof componentInstance[route.handler] === "function") {
      responseBody = await componentInstance[route.handler](ctx);
    } else if (typeof route.handler === "function") {
      responseBody = await route.handler(ctx);
    } else {
      throw new Error(`Handler '${String(route.handler)}' is not executable on component instance.`);
    }
    emit("ExecutionEnd");
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    emit("NavigationError", { error: errorMsg });
    return {
      matched: true,
      status: 500,
      error: errorMsg,
      resolvedData,
    };
  }

  // 5. Evaluate CanDeactivate guards if component exists
  if (route.canDeactivate && route.canDeactivate.length > 0 && componentInstance) {
    emit("GuardsCheckStart", { stage: "canDeactivate" });
    for (const guard of route.canDeactivate) {
      if (typeof guard === "function") {
        const canLeave = await guard(componentInstance, ctx);
        if (!canLeave) {
          emit("GuardsCheckEnd", { stage: "canDeactivate", allowed: false });
          emit("NavigationCancel", { reason: "CanDeactivate guard rejected" });
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
    emit("GuardsCheckEnd", { stage: "canDeactivate", allowed: true });
  }

  emit("NavigationEnd");
  return {
    matched: true,
    status: 200,
    body: responseBody,
    resolvedData,
  };
}
