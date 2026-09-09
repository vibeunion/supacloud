import { Elysia } from "elysia";
import { CommandError } from "@supacloud/contracts";
import { commandErrorStatus } from "./command-errors";
import { executionRequestId, observeExecution, type ExecutionObserver } from "./execution";

export type { ExecutionEvent, ExecutionObserver } from "./execution";
export { createSchemaDecoder, defineJsonContract, SchemaContractError } from "./schema_contract";
export { createPersistentCommandAdapter, type PersistentCommandHandler } from "./persistent-command";

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
  /** Compiler-emitted positional invoker; used when available. */
  invoker?: (
    controller: unknown,
    request: {
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, unknown>;
      context?: unknown;
    },
  ) => Promise<unknown> | unknown;
  /** Class name of the @Command explicitly bound to this route. */
  command?: string;
  /** Statically generated route aspects. */
  aspects?: ApplicationAspect[];
}

export interface CompiledCommand {
  rpc?: string;
  className: string;
  name: string;
  permission?: string;
  transaction?: "required" | "none" | string;
  audit?: string;
  idempotency?: "required" | "none" | string;
  /** Statically generated command aspects. */
  aspects?: ApplicationAspect[];
}

export interface CompiledJob {
  className: string;
  name: string;
  serviceKey: string;
  scope: "application" | "request" | "job";
  aspects?: ApplicationAspect[];
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
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  destroyRequestScope?(scope: Record<string, unknown>): Promise<void>;
  createJobScope?(
    services: Record<string, unknown>,
    ctx: unknown,
    imported?: Record<string, Record<string, unknown>>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  destroyJobScope?(scope: Record<string, unknown>): Promise<void>;
  controllers: CompiledController[];
  commands?: CompiledCommand[];
  jobs?: CompiledJob[];
  /** Statically generated module aspects. */
  aspects?: ApplicationAspect[];
}

// ---------------------------------------------------------------------------
// Application options
// ---------------------------------------------------------------------------

export type RequestContextFactory = (
  request: Request,
) => unknown | Promise<unknown>;

export { createSupAuthRequestContext } from "./identity";
export type { SupAuthIdentity, SupAuthAccess, SupAuthRequestContext, SupAuthContextOptions } from "./identity";

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
    params: Record<string, unknown>;
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

export { assertFeatureTransition } from "./feature";
export type { FeatureTransitionSpec } from "./feature";

export interface ApplicationAspectContext {
  kind: "route" | "command" | "job";
  name: string;
  input: unknown;
  request?: Request;
  requestContext?: unknown;
  scope?: Record<string, unknown>;
  services?: Record<string, unknown>;
  metadata?: unknown;
}

export type ApplicationAspect = (
  context: ApplicationAspectContext,
  next: () => unknown | Promise<unknown>,
) => unknown | Promise<unknown>;

/**
 * Compose the compiler-emitted aspect list into a deterministic onion chain.
 * The runtime only executes the functions it receives; it never discovers or
 * registers aspects.
 */
export function composeAspects(
  ...aspects: (ApplicationAspect | undefined | null)[]
): ApplicationAspect {
  const active = aspects.filter(
    (aspect): aspect is ApplicationAspect => typeof aspect === "function",
  );
  return (context, next) => {
    let index = -1;
    const dispatch = (current: number): Promise<unknown> => {
      if (current <= index) {
        return Promise.reject(new Error("next() called multiple times"));
      }
      index = current;
      if (current === active.length) return Promise.resolve(next());
      return Promise.resolve(active[current](context, () => dispatch(current + 1)));
    };
    return dispatch(0);
  };
}

function observedAspects(
  aspects: ApplicationAspect[],
  boundary: string,
  observer?: ExecutionObserver,
): ApplicationAspect {
  return composeAspects(...aspects.map((aspect, index): ApplicationAspect =>
    (context, next) => observeExecution(observer, {
      kind: context.kind,
      operation: context.name,
      stage: `${boundary}.aspect[${index}]:${aspect.name || "anonymous"}`,
      requestId: executionRequestId(context.requestContext),
    }, () => aspect(context, next))));
}

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
  /** Application-owned adapters: a single RPC owns all declared persistence. */
  rpc?: Record<string, {
    capabilities: { audit?: boolean; transaction?: boolean; idempotency?: boolean; boundary?: "database" | "external" };
    execute: CommandMiddleware;
  }>;
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

export type JsonResponseValidator<T> = (value: unknown) => value is T;

/**
 * Validate the serialized JSON snapshot before creating a native Response.
 * Validators must be synchronous and side-effect free; response failures do not
 * imply that application writes were rolled back.
 */
export function validatedJsonResponse<T>(
  validate: JsonResponseValidator<T>,
  value: NoInfer<T>,
  init?: ResponseInit,
): Response {
  if (init?.status === 204 || init?.status === 205 || init?.status === 304) {
    throw new TypeError("JSON responses cannot use a null-body status");
  }
  let body: string;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || validate(JSON.parse(serialized)) !== true) {
      throw new Error("Invalid JSON response");
    }
    body = serialized;
  } catch {
    throw new ApplicationError("Response validation failed", {
      status: 500,
      code: "RESPONSE_VALIDATION_ERROR",
    });
  }

  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(body, { ...init, headers });
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
  /** false rejects extra schema properties instead of silently removing them. */
  normalize?: boolean;
  /** Modules in topological import order. */
  modules?: CompiledModule[];
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
  /** Best-effort execution metadata only; durable audit belongs to governance. */
  onExecution?: ExecutionObserver;
}

export interface JobInvocation {
  job: CompiledJob;
  input: unknown;
  requestContext: unknown;
  scope?: Record<string, unknown>;
  services: Record<string, unknown>;
}

export type JobExecutor = (
  invocation: JobInvocation,
  next: () => unknown | Promise<unknown>,
) => unknown | Promise<unknown>;

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
export const createSupaCloudRequestContext = (
  request: Request,
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
  observer?: ExecutionObserver,
): CommandExecutor {
  return async (invocation, next) => {
    const { command } = invocation;
    for (const mode of [command.transaction, command.idempotency]) {
      if (mode !== undefined && mode !== "required" && mode !== "none") {
        throw new ApplicationError("Invalid command governance mode", { code: "COMMAND_MODE_INVALID" });
      }
    }
    if (command.rpc !== undefined) {
      const adapter = Object.hasOwn(governance.rpc ?? {}, command.rpc) ? governance.rpc?.[command.rpc] : undefined;
      if (!adapter) throw new ApplicationError("RPC governance adapter unavailable", { code: "COMMAND_RPC_UNAVAILABLE", status: 501 });
      for (const capability of ["audit", "transaction", "idempotency"] as const) {
        const required = capability === "audit" ? !!command.audit : command[capability] === "required";
        if (required && adapter.capabilities[capability] !== true) throw missingGovernanceAdapter(command, capability);
      }
      const event = { kind: "command" as const, operation: command.name,
        requestId: executionRequestId(invocation.requestContext) };
      await observeExecution(observer, { ...event, stage: "authorize" }, () => governance.authorize(invocation));
      return observeExecution(observer, { ...event, stage: `rpc:${command.rpc}` },
        () => adapter.execute(invocation, once(next)));
    }
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
      const observe = <T>(stage: string, next: () => T | Promise<T>) =>
        observeExecution(observer, {
          kind: "command", operation: command.name, stage,
          requestId: executionRequestId(invocation.requestContext),
        }, next);
      await observe("authorize", () => governance.authorize(invocation));
      let execute = async () => {
        const result = await observe("handler", invokeOnce);
        if (audit) await observe("audit", () => audit.succeeded.call(audit, invocation, result));
        return result;
      };
      const invokeOnce = once(next);
      if (command.transaction === "required") {
        if (!transaction) throw missingGovernanceAdapter(command, "transaction");
        const inner = execute;
        execute = () => observe("transaction", () => transaction.call(governance, invocation, once(inner)));
      }
      if (command.idempotency === "required") {
        if (!idempotency) throw missingGovernanceAdapter(command, "idempotency");
        const inner = execute;
        execute = () => observe("idempotency", () => idempotency.call(governance, invocation, once(inner)));
      }
      return await execute();
    } catch (error) {
      if (audit) await audit.failed.call(audit, invocation, error);
      throw error;
    }
  };
}

/** Execute at the business-selected boundary without binding or re-entering an HTTP route. */
export async function executeCompiledCommand<Input, Result>(options: {
  module: Pick<CompiledModule, "name" | "commands" | "aspects">;
  command: string;
  input: Input;
  request: Request;
  requestContext: unknown;
  services?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  governance: CommandGovernance;
  observer?: ExecutionObserver;
  handler: (input: Input) => Result | Promise<Result>;
  decode: (value: unknown) => Result;
}): Promise<Result> {
  const matches = options.module.commands?.filter((item) => item.className === options.command) ?? [];
  if (matches.length !== 1) throw new ApplicationError("Command descriptor missing or ambiguous", { code: "COMMAND_NOT_REGISTERED" });
  const command = matches[0]!;
  const invocation: CommandInvocation = {
    command, input: { body: options.input, params: {}, query: {} },
    request: options.request, requestContext: options.requestContext,
    services: options.services ?? {}, scope: options.scope,
  };
  const aspects = composeAspects(
    observedAspects(options.module.aspects ?? [], `module:${options.module.name}`, options.observer),
    observedAspects(command.aspects ?? [], "command", options.observer),
  );
  // Authorization encloses aspects so denied calls cannot trigger their side effects.
  const value = await createCommandExecutor(options.governance, options.observer)(invocation,
    once(() => aspects({ kind: "command", name: command.name, input: options.input,
      request: options.request, requestContext: options.requestContext,
      services: invocation.services, scope: invocation.scope, metadata: command },
    once(() => options.handler(options.input)))));
  return options.decode(value);
}

function once(next: () => unknown | Promise<unknown>): () => Promise<unknown> {
  let called = false;
  return async () => {
    if (called) {
      throw new ApplicationError("Command continuation called multiple times", {
        code: "COMMAND_CONTINUATION_REUSED",
      });
    }
    called = true;
    return await next();
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
  params: Record<string, unknown>;
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
  options: Pick<ApplicationOptions, "commandGovernance" | "commandExecutor" | "errorMapper" | "onExecution" | "normalize"> = {},
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
    ? createCommandExecutor(options.commandGovernance, options.onExecution)
    : undefined;
  const commandExecutor = options.commandExecutor && governanceExecutor
    ? composeCommandExecutors(options.commandExecutor, governanceExecutor)
    : (options.commandExecutor ?? governanceExecutor);

  const plugin = new Elysia({ name: `supacloud:${compiled.name}`, normalize: options.normalize ?? true }).decorate(
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

  // Bind before routes and keep the handler local to its module's request context.
  plugin.onError(async ({ code, error, request }) => {
    const context: ErrorContext = {
      request,
      requestContext: requestContexts.get(request),
      frameworkCode: code,
    };
    const mapped = await options.errorMapper?.(error, context);
    return mapped ?? defaultErrorResponse(error, code);
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
          ? await createRequestScope(services, requestContext, imported)
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
          headers: Object.fromEntries(ctx.request.headers.entries()),
          context: requestContext,
          request: ctx.request,
          scope: requestScope,
          requestContext,
        };
        const handlerCall = () => route.invoker
          ? route.invoker(instance, input)
          : Reflect.apply(method, instance, [input]);
        const invoke = once(() => route.command && options.commandGovernance ? handlerCall()
          : observeExecution(options.onExecution, {
            kind: route.command ? "command" : "route",
            operation: route.command ?? `${route.method} ${path}`,
            stage: "handler",
            requestId: executionRequestId(requestContext),
          }, handlerCall));
        const routeContext: ApplicationAspectContext = {
          kind: "route",
          name: `${route.method} ${path}`,
          input,
          request: ctx.request,
          requestContext,
          scope: requestScope,
          services,
          metadata: route,
        };
        const command = route.command
          ? commandsByClassName.get(route.command)
          : undefined;
        const commandContext: ApplicationAspectContext = {
          kind: "command",
          name: command?.name ?? route.command ?? `${route.method} ${path}`,
          input,
          request: ctx.request,
          requestContext,
          scope: requestScope,
          services,
          metadata: command ?? route,
        };
        const commandAspects = route.command
          ? commandsByClassName.get(route.command)?.aspects ?? []
          : [];
        const routePipeline = observedAspects(route.aspects ?? [], "route", options.onExecution);
        const commandPipeline = observedAspects(commandAspects, "command", options.onExecution);
        const modulePipeline = observedAspects(compiled.aspects ?? [], `module:${compiled.name}`, options.onExecution);
        const invokeRoute = () => routePipeline(
          routeContext,
          () => route.command
            ? commandPipeline(commandContext, () => invokeCommand())
            : invoke(),
        );
        const invokeCommand = () => {
          if (!route.command) return invoke();
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
          const invocation: CommandInvocation = {
            command,
            input,
            request: ctx.request,
            requestContext,
            scope: requestScope,
            services,
          };
          return observeExecution(options.onExecution, {
            kind: "command", operation: command.name, stage: "commandExecutor",
            requestId: executionRequestId(requestContext),
          }, () => commandExecutor(invocation, invoke));
        };
        return modulePipeline(
          route.command ? commandContext : routeContext,
          invokeRoute,
        );
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

  return plugin as unknown as Elysia;
}

/**
 * Execute one compiler-emitted Job descriptor.
 *
 * Job classes use `run(input)` as their entry method; `execute(input)` is also
 * accepted for command-like job implementations. The scope factory and
 * destruction hooks are generated statically by the compiler.
 */
export async function executeJob(
  compiled: CompiledModule,
  services: Record<string, unknown>,
  job: CompiledJob,
  input: unknown,
  requestContext: unknown,
  imported: Record<string, Record<string, unknown>> = {},
  executor?: JobExecutor,
  observer?: ExecutionObserver,
): Promise<unknown> {
  const jobScope = job.scope === "job" && compiled.createJobScope
    ? await compiled.createJobScope(services, requestContext, imported)
    : undefined;

  try {
    const source = job.scope === "job" ? jobScope : services;
    const instance = controllerInstance(source?.[job.serviceKey]);
    const method = instance?.run ?? instance?.execute;
    if (typeof method !== "function") {
      throw new ApplicationError(
        `Job "${job.name}" has no run(input) or execute(input) handler`,
        { code: "JOB_HANDLER_UNAVAILABLE" },
      );
    }

    const invocation: JobInvocation = {
      job,
      input,
      requestContext,
      scope: jobScope,
      services,
    };
    const context: ApplicationAspectContext = {
      kind: "job",
      name: job.name,
      input,
      requestContext,
      scope: jobScope,
      services,
      metadata: job,
    };
    const invoke = once(() => observeExecution(observer, {
      kind: "job", operation: job.name, stage: "handler",
      requestId: executionRequestId(requestContext),
    }, () => Reflect.apply(method, instance, [input])));
    const pipeline = observedAspects(compiled.aspects ?? [], `module:${compiled.name}`, observer);
    const jobPipeline = observedAspects(job.aspects ?? [], "job", observer);

    return await pipeline(
      context,
      () => jobPipeline(context, () => observeExecution(observer, {
        kind: "job", operation: job.name, stage: "jobExecutor",
        requestId: executionRequestId(requestContext),
      }, executor ? () => executor(invocation, invoke) : invoke)),
    );
  } finally {
    if (jobScope && compiled.destroyJobScope) {
      await compiled.destroyJobScope(jobScope);
    }
  }
}

export function defaultErrorResponse(
  error: unknown,
  frameworkCode?: string | number,
): Response {
  if (error instanceof CommandError) {
    return Response.json({ ok: false, code: error.code, message: error.code }, {
      status: commandErrorStatus(error.code),
    });
  }
  if (isPublicApplicationError(error)) {
    return Response.json({
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }, { status: error.status });
  }
  if (frameworkCode === "VALIDATION") {
    // A response failure can occur after a command commits; it is not invalid input.
    if (isRecord(error) && error.type === "response") {
      return Response.json({
        ok: false,
        code: "RESPONSE_VALIDATION_ERROR",
        message: "Response validation failed",
      }, { status: 500 });
    }
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
  const app = new Elysia({ name: options.name ?? "supacloud:app", normalize: options.normalize ?? true });
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

  for (const module of options.modules ?? []) {
    const services = module.createServices(options.deps ?? {}, imported);
    imported[module.name] = services;
    app.use(createModulePlugin(module, services, ctxFactory, {
      normalize: options.normalize,
      commandGovernance: options.commandGovernance,
      commandExecutor: options.commandExecutor,
      errorMapper: options.errorMapper,
      onExecution: options.onExecution,
    }, imported));
  }

  return app;
}

/** Semantic alias of createApplication for readable tests. */
export function createTestApp(options: ApplicationOptions): Elysia {
  return createApplication(options);
}

export {
  createMemorySandbox,
} from "./memory";
export type {
  HandleLike as MemoryHandleLike,
  MemoryDatabase,
  MemorySandbox,
  MemorySandboxOptions,
  MemoryStorage,
  MemoryStorageObject,
} from "./memory";
export { createMemoryPolicy } from "./memory_policy";
export type { MemoryPolicy } from "./memory_policy";
