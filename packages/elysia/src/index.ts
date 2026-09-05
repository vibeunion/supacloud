import { Elysia } from "elysia";

// ---------------------------------------------------------------------------
// Compiled module contract (mirrors @supacloud/compiler output)
// ---------------------------------------------------------------------------

export interface CompiledRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  path: string;
  /** Method name on the controller instance. */
  handler: string;
  /** TypeBox schema; validation is enabled only when the field is present. */
  body?: unknown;
  params?: unknown;
  query?: unknown;
  response?: unknown;
  /** Class name of the @Command explicitly bound to this route. */
  command?: string;
}

export interface CompiledCommand {
  className: string;
  name: string;
  permission?: string;
  transaction?: "required" | "none" | string;
  audit?: string;
  idempotency?: "required" | "none" | string;
}

export interface CompiledController {
  /** Controller path prefix, e.g. "/cases". */
  path: string;
  /** Key of the controller instance on `services` or the request scope. */
  serviceKey: string;
  scope: "application" | "request" | "job";
  routes: CompiledRoute[];
}

export interface CompiledModule {
  name: string;
  createServices(
    deps: Record<string, unknown>,
    imported: Record<string, Record<string, unknown>>,
  ): Record<string, unknown>;
  createRequestScope?(
    services: Record<string, unknown>,
    ctx: unknown,
    imported?: Record<string, Record<string, unknown>>,
  ): Record<string, unknown>;
  destroyRequestScope?(scope: Record<string, unknown>): Promise<void>;
  controllers: CompiledController[];
  commands?: CompiledCommand[];
}

// ---------------------------------------------------------------------------
// Application options
// ---------------------------------------------------------------------------

export type RequestContextFactory = (
  request: Request,
) => unknown | Promise<unknown>;

export const VERIFIED_JWT_SUBJECT_HEADER = "x-supacloud-jwt-sub";
export const EXECUTION_ID_HEADER = "x-sb-execution-id";
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export interface TrustedRequestIdentity {
  authenticated: boolean;
  /** Subject verified and forwarded by the SupaCloud Edge Runtime. */
  subject?: string;
  /** Bearer token associated with the verified subject. Never log this value. */
  accessToken?: string;
}

export interface SupaCloudRequestContext {
  requestId: string;
  request: Request;
  identity: TrustedRequestIdentity;
  idempotencyKey?: string;
}

export interface CommandInvocation {
  command: CompiledCommand;
  input: {
    body: unknown;
    params: Record<string, string>;
    query: Record<string, unknown>;
  };
  request: Request;
  requestContext: unknown;
  scope?: Record<string, unknown>;
  services: Record<string, unknown>;
}

export type CommandExecutor = (
  invocation: CommandInvocation,
  next: () => unknown | Promise<unknown>,
) => unknown | Promise<unknown>;

export type CommandAuthorizer = (
  invocation: CommandInvocation,
) => void | Promise<void>;

export type CommandMiddleware = (
  invocation: CommandInvocation,
  next: () => unknown | Promise<unknown>,
) => unknown | Promise<unknown>;

export interface CommandAudit {
  succeeded(invocation: CommandInvocation, result: unknown): void | Promise<void>;
  failed(invocation: CommandInvocation, error: unknown): void | Promise<void>;
}

export interface CommandGovernance {
  authorize: CommandAuthorizer;
  idempotency?: CommandMiddleware;
  transaction?: CommandMiddleware;
  audit?: CommandAudit;
}

/**
 * Compose multiple CommandExecutors into a single onion-style pipeline.
 * Outer executors run first before calling `next()`, and complete last.
 */
export function composeCommandExecutors(
  ...executors: (CommandExecutor | undefined | null)[]
): CommandExecutor {
  const active = executors.filter(
    (e): e is CommandExecutor => typeof e === "function",
  );
  if (active.length === 0) return (_inv, next) => next();
  return (invocation, next) => {
    let index = -1;
    const dispatch = (i: number): Promise<unknown> => {
      if (i <= index) {
        return Promise.reject(new Error("next() called multiple times"));
      }
      index = i;
      if (i === active.length) {
        return Promise.resolve(next());
      }
      const fn = active[i];
      if (!fn) {
        return Promise.resolve(next());
      }
      return Promise.resolve(fn(invocation, () => dispatch(i + 1)));
    };
    return dispatch(0);
  };
}

export interface ApplicationErrorOptions {
  status?: number;
  code?: string;
  details?: unknown;
}

export interface PublicApplicationError extends Error {
  readonly expose: true;
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
}

export class ApplicationError extends Error implements PublicApplicationError {
  readonly expose = true as const;
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options: ApplicationErrorOptions = {}) {
    super(message);
    this.name = "ApplicationError";
    this.status = options.status ?? 500;
    this.code = options.code ?? "INTERNAL_ERROR";
    this.details = options.details;
  }
}

export interface ErrorContext {
  request: Request;
  requestContext: unknown;
  frameworkCode: string | number | undefined;
}

export type ErrorMapper = (
  error: unknown,
  context: ErrorContext,
) => Response | undefined | Promise<Response | undefined>;

export interface ApplicationOptions {
  name?: string;
  /** Modules in topological import order. */
  modules: CompiledModule[];
  /** Platform-level dependencies (db client etc.), passed to createServices. */
  deps?: Record<string, unknown>;
  /** Builds the per-request context object. Defaults to { requestId, request }. */
  requestContext?: RequestContextFactory;
  /** Enforces permission/audit/idempotency policy for command-bound routes. */
  commandGovernance?: CommandGovernance;
  /** Optional custom or composed executor. When provided alongside commandGovernance, it wraps or composes with governance. */
  commandExecutor?: CommandExecutor;
  /** Maps framework or application failures to the public HTTP contract. */
  errorMapper?: ErrorMapper;
}

function safeHeaderValue(value: string | null, maxLength: number): string | undefined {
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTrustedIdentity(value: unknown): value is TrustedRequestIdentity {
  return isRecord(value)
    && typeof value.authenticated === "boolean"
    && (value.subject === undefined || typeof value.subject === "string")
    && (value.accessToken === undefined || typeof value.accessToken === "string");
}

type AuthenticatedTrustedIdentity = TrustedRequestIdentity & {
  authenticated: true;
  subject: string;
  accessToken: string;
};

function isAuthenticatedTrustedIdentity(
  value: TrustedRequestIdentity | undefined,
): value is AuthenticatedTrustedIdentity {
  return value?.authenticated === true
    && typeof value.subject === "string"
    && value.subject.length > 0
    && typeof value.accessToken === "string"
    && value.accessToken.length > 0;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match ? safeHeaderValue(match[1], 16_384) : undefined;
}

/**
 * Build the standard request context for applications behind SupaCloud Edge
 * Runtime. The runtime strips incoming x-supacloud-jwt-sub values and writes
 * the header only after JWT verification.
 */
export const createSupaCloudRequestContext: RequestContextFactory = (
  request,
): SupaCloudRequestContext => {
  const subject = safeHeaderValue(
    request.headers.get(VERIFIED_JWT_SUBJECT_HEADER),
    1_024,
  );
  const accessToken = subject ? bearerToken(request) : undefined;
  const requestId = safeHeaderValue(
    request.headers.get(EXECUTION_ID_HEADER),
    256,
  ) ?? safeHeaderValue(request.headers.get("x-request-id"), 256)
    ?? crypto.randomUUID();
  const idempotencyKey = safeHeaderValue(
    request.headers.get(IDEMPOTENCY_KEY_HEADER),
    512,
  );

  const identity: TrustedRequestIdentity = {
    authenticated: subject !== undefined,
    ...(subject === undefined ? {} : { subject }),
  };
  if (accessToken !== undefined) {
    Object.defineProperty(identity, "accessToken", {
      value: accessToken,
      enumerable: false,
      configurable: false,
    });
  }

  return {
    requestId,
    request,
    identity,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
};

const defaultRequestContext: RequestContextFactory = createSupaCloudRequestContext;

function missingGovernanceAdapter(
  command: CompiledCommand,
  adapter: "idempotency" | "transaction" | "audit",
): ApplicationError {
  const codes = {
    idempotency: "COMMAND_IDEMPOTENCY_UNAVAILABLE",
    transaction: "COMMAND_TRANSACTION_UNAVAILABLE",
    audit: "COMMAND_AUDIT_UNAVAILABLE",
  } as const;
  return new ApplicationError(
    `Command "${command.name}" requires a ${adapter} adapter`,
    {
      status: 501,
      code: codes[adapter],
    },
  );
}

/**
 * Compose the standard command governance order:
 * authorization -> idempotency -> transaction -> audit -> handler.
 * Declared governance metadata fails closed when its adapter is absent.
 */
export function createCommandExecutor(
  governance: CommandGovernance,
): CommandExecutor {
  return async (invocation, next) => {
    const { command } = invocation;
    const audit = command.audit ? governance.audit : undefined;
    const transaction = command.transaction === "required"
      ? governance.transaction
      : undefined;
    const idempotency = command.idempotency === "required"
      ? governance.idempotency
      : undefined;

    if (command.audit && !audit) {
      throw missingGovernanceAdapter(command, "audit");
    }
    if (command.transaction === "required" && !transaction) {
      throw missingGovernanceAdapter(command, "transaction");
    }
    if (command.idempotency === "required" && !idempotency) {
      throw missingGovernanceAdapter(command, "idempotency");
    }

    try {
      await governance.authorize(invocation);
      let execute = async () => {
        const result = await next();
        if (audit) await audit.succeeded.call(audit, invocation, result);
        return result;
      };
      if (command.transaction === "required") {
        if (!transaction) throw missingGovernanceAdapter(command, "transaction");
        const inner = execute;
        execute = () => Promise.resolve(transaction.call(governance, invocation, inner));
      }
      if (command.idempotency === "required") {
        if (!idempotency) throw missingGovernanceAdapter(command, "idempotency");
        const inner = execute;
        execute = () => Promise.resolve(idempotency.call(governance, invocation, inner));
      }
      return await execute();
    } catch (error) {
      if (audit) await audit.failed.call(audit, invocation, error);
      throw error;
    }
  };
}

export function requireTrustedIdentity(
  requestContext: unknown,
): Required<Pick<TrustedRequestIdentity, "subject" | "accessToken">>
  & TrustedRequestIdentity {
  const context = isRecord(requestContext) ? requestContext : {};
  const identity = isTrustedIdentity(context.identity) ? context.identity : undefined;
  if (!isAuthenticatedTrustedIdentity(identity)) {
    throw new ApplicationError("Authenticated user context is required", {
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
  }
  return identity;
}

export function requireIdempotencyKey(invocation: CommandInvocation): string {
  const context = isRecord(invocation.requestContext) ? invocation.requestContext : {};
  const key = (typeof context.idempotencyKey === "string" ? context.idempotencyKey : undefined)
    ?? safeHeaderValue(invocation.request.headers.get(IDEMPOTENCY_KEY_HEADER), 512);
  if (!key) {
    throw new ApplicationError("Idempotency-Key header is required", {
      status: 400,
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
  }
  return key;
}

/** Join a controller prefix and a route path, normalizing slashes. */
function joinPaths(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
}

interface HttpContext {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, unknown>;
  request: Request;
  scope?: Record<string, unknown>;
  requestContext?: unknown;
}

type ControllerInstance = Record<string, unknown>;

function controllerInstance(value: unknown): ControllerInstance | undefined {
  return isRecord(value) ? value : undefined;
}

/**
 * Adapt a single compiled module into an Elysia plugin.
 *
 * The plugin decorates the context with `services`; when the module defines
 * `createRequestScope`, a fresh request scope is resolved per request and
 * exposed on the `scope` context key. Request-scoped controller instances are
 * looked up on `scope`, everything else on `services`.
 */
export function createModulePlugin(
  compiled: CompiledModule,
  services: Record<string, unknown>,
  ctxFactory: RequestContextFactory = defaultRequestContext,
  options: Pick<ApplicationOptions, "commandGovernance" | "commandExecutor" | "errorMapper"> = {},
  imported: Record<string, Record<string, unknown>> = {},
): Elysia {
  const hasCommandRoutes = compiled.controllers.some((controller) =>
    controller.routes.some((route) => route.command !== undefined),
  );
  if (hasCommandRoutes && !options.commandGovernance && !options.commandExecutor) {
    throw new ApplicationError(
      `Module "${compiled.name}" has command routes but no commandGovernance`,
      { code: "COMMAND_GOVERNANCE_UNCONFIGURED" },
    );
  }
  const commandsByClassName = new Map(
    (compiled.commands ?? []).map((command) => [command.className, command]),
  );
  for (const controller of compiled.controllers) {
    for (const route of controller.routes) {
      if (route.command && !commandsByClassName.has(route.command)) {
        throw new ApplicationError(`Command "${route.command}" is not registered`, {
          code: "COMMAND_NOT_REGISTERED",
        });
      }
    }
  }
  const requestContexts = new WeakMap<Request, unknown>();
  const governanceExecutor = options.commandGovernance
    ? createCommandExecutor(options.commandGovernance)
    : undefined;
  const commandExecutor = options.commandExecutor && governanceExecutor
    ? composeCommandExecutors(options.commandExecutor, governanceExecutor)
    : (options.commandExecutor ?? governanceExecutor);

  const plugin = new Elysia({ name: `supacloud:${compiled.name}` }).decorate(
    "services",
    services,
  );

  const createRequestScope = compiled.createRequestScope;
  const requestScopes = new WeakMap<Request, Record<string, unknown>>();
  if (compiled.destroyRequestScope) {
    const destroyRequestScope = compiled.destroyRequestScope;
    plugin.onAfterResponse(async ({ request }) => {
      const scope = requestScopes.get(request);
      if (!scope) return;
      requestScopes.delete(request);
      try {
        await destroyRequestScope(scope);
      } catch (error) {
        console.error(`supacloud: request scope cleanup failed for "${compiled.name}"`, error);
      }
    });
  }
  plugin.resolve(async ({ request }) => {
    const requestContext = await ctxFactory(request);
    requestContexts.set(request, requestContext);
    return { requestContext };
  });

  for (const controller of compiled.controllers) {
    for (const route of controller.routes) {
      const path = joinPaths(controller.path, route.path);
      const schema: Record<string, unknown> = {};
      if (route.body !== undefined) schema.body = route.body;
      if (route.params !== undefined) schema.params = route.params;
      if (route.query !== undefined) schema.query = route.query;
      if (route.response !== undefined) schema.response = route.response;

      const handler = async (ctx: HttpContext) => {
        const requestContext = ctx.requestContext ?? await ctxFactory(ctx.request);
        const requestScope = createRequestScope
          ? createRequestScope(services, requestContext, imported)
          : undefined;
        if (requestScope && compiled.destroyRequestScope) requestScopes.set(ctx.request, requestScope);
        const source =
          controller.scope === "request" ? requestScope : services;
        const instance = controllerInstance(source?.[controller.serviceKey]);
        const method = instance?.[route.handler];
        if (typeof method !== "function") {
          throw new Error(
            `supacloud: controller "${controller.serviceKey}" has no handler "${route.handler}" in scope "${controller.scope}"`,
          );
        }
        const input = {
          body: ctx.body,
          params: ctx.params,
          query: ctx.query,
          request: ctx.request,
          scope: requestScope,
          requestContext,
        };
        const invoke = () => Reflect.apply(method, instance, [input]);
        if (!route.command) return invoke();

        const command = commandsByClassName.get(route.command);
        if (!command) {
          throw new ApplicationError(`Command "${route.command}" is not registered`, {
            code: "COMMAND_NOT_REGISTERED",
          });
        }
        if (!commandExecutor) {
          throw new ApplicationError(`Command "${command.name}" has no executor`, {
            status: 501,
            code: "COMMAND_EXECUTOR_UNAVAILABLE",
          });
        }
        return commandExecutor({
          command,
          input,
          request: ctx.request,
          requestContext,
          scope: requestScope,
          services,
        }, invoke);
      };

      switch (route.method) {
        case "GET":
          plugin.get(path, handler, schema);
          break;
        case "POST":
          plugin.post(path, handler, schema);
          break;
        case "PUT":
          plugin.put(path, handler, schema);
          break;
        case "PATCH":
          plugin.patch(path, handler, schema);
          break;
        case "DELETE":
          plugin.delete(path, handler, schema);
          break;
        case "HEAD":
          plugin.head(path, handler, schema);
          break;
        case "OPTIONS":
          plugin.options(path, handler, schema);
          break;
      }
    }
  }

  plugin.onError({ as: "global" }, async ({ code, error, request }) => {
    const context: ErrorContext = {
      request,
      requestContext: requestContexts.get(request),
      frameworkCode: code,
    };
    const mapped = await options.errorMapper?.(error, context);
    return mapped ?? defaultErrorResponse(error, code);
  });

  return plugin as unknown as Elysia;
}

export function defaultErrorResponse(
  error: unknown,
  frameworkCode?: string | number,
): Response {
  if (isPublicApplicationError(error)) {
    return Response.json({
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }, { status: error.status });
  }
  if (frameworkCode === "VALIDATION") {
    return Response.json({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
    }, { status: 422 });
  }
  return Response.json({
    ok: false,
    code: "INTERNAL_ERROR",
    message: "Internal Server Error",
  }, { status: 500 });
}

function isPublicApplicationError(error: unknown): error is PublicApplicationError {
  if (!(error instanceof Error) || !isRecord(error)) return false;
  return error.expose === true
    && typeof error.status === "number"
    && Number.isInteger(error.status)
    && error.status >= 400
    && error.status <= 599
    && typeof error.code === "string"
    && error.code.length > 0;
}

/**
 * Create the root Elysia application from compiled modules.
 *
 * Modules are instantiated in the given (topological) order: each module's
 * `createServices` receives `deps` plus the services of all previously
 * created modules, keyed by module name.
 */
export function createApplication(options: ApplicationOptions): Elysia {
  const app = new Elysia({ name: options.name ?? "supacloud:app" });
  const configuredContextFactory = options.requestContext ?? defaultRequestContext;
  const contextCache = new WeakMap<Request, Promise<unknown>>();
  const ctxFactory: RequestContextFactory = (request) => {
    const cached = contextCache.get(request);
    if (cached) return cached;
    const pending = Promise.resolve(configuredContextFactory(request));
    contextCache.set(request, pending);
    return pending;
  };
  const imported: Record<string, Record<string, unknown>> = {};

  for (const module of options.modules) {
    const services = module.createServices(options.deps ?? {}, imported);
    imported[module.name] = services;
    app.use(createModulePlugin(module, services, ctxFactory, {
      commandGovernance: options.commandGovernance,
      commandExecutor: options.commandExecutor,
      errorMapper: options.errorMapper,
    }, imported));
  }

  return app;
}

/** Semantic alias of createApplication for readable tests. */
export function createTestApp(options: ApplicationOptions): Elysia {
  return createApplication(options);
}
