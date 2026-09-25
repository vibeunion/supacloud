import type { AnyElysia, Elysia } from "elysia";
import type { ApplicationHttpContext, CompiledRoute } from "./index";

export interface HttpPolicyDeclaration {
  name: string;
  options?: unknown;
}

export interface HttpPolicyContext<Http extends AnyElysia = Elysia> {
  http: ApplicationHttpContext<Http>;
  requestContext: unknown;
}

export interface HttpPolicyResponseContext<Http extends AnyElysia = Elysia> extends HttpPolicyContext<Http> {
  response: unknown;
}

export type HttpPolicy<Http extends AnyElysia = Elysia> =
  ((context: HttpPolicyContext<Http>) => void | Response | Promise<void | Response>) & {
    /** Terminal policies (cache hits) must not skip later security checks. */
    terminal?: boolean;
    mapResponse?: (context: HttpPolicyResponseContext<Http>) => void | Response | Promise<void | Response>;
    afterResponse?: (context: HttpPolicyResponseContext<Http>) => void | Promise<void>;
  };

/** Factories validate configuration once at startup, never per request. */
export type HttpPolicyRegistry<Http extends AnyElysia = Elysia> = Readonly<Record<
  string,
  (options: unknown, route: Readonly<Pick<CompiledRoute, "method" | "path" | "command">>) => HttpPolicy<Http>
>>;

export class HttpPolicyConfigurationError extends Error {
  readonly code = "HTTP_POLICY_CONFIGURATION_INVALID";
}

export function compileHttpPolicies<Http extends AnyElysia>(
  route: CompiledRoute,
  path: string,
  registry: HttpPolicyRegistry<Http> = {},
): HttpPolicy<Http>[] {
  const declarations = route.data?.httpPolicies;
  if (declarations === undefined) return [];
  const fail = (): never => {
    throw new HttpPolicyConfigurationError(`Invalid HTTP policy configuration for ${route.method} ${path}`);
  };
  if (!Array.isArray(declarations)) return fail();
  return Array.from(declarations, (value: unknown, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const declaration = value as Record<string, unknown>;
    if (typeof declaration.name !== "string"
      || Object.keys(declaration).some((key) => key !== "name" && key !== "options")
      || !Object.hasOwn(registry, declaration.name)) return fail();
    const factory = registry[declaration.name];
    if (typeof factory !== "function") return fail();
    const policy = factory(declaration.options, Object.freeze({
      method: route.method, path, ...(route.command === undefined ? {} : { command: route.command }),
    }));
    if (typeof policy !== "function") return fail();
    if (policy.terminal && index !== declarations.length - 1) return fail();
    if (policy.afterResponse !== undefined && typeof policy.afterResponse !== "function") return fail();
    if (policy.mapResponse !== undefined && typeof policy.mapResponse !== "function") return fail();
    return policy;
  });
}
