import { Elysia, type AnyElysia, type InferContext, type StatusMap, type TSchema } from "elysia";
import type {
  CommandRuntimeAudit,
  CommandRuntimeAuthorizer,
  CommandRuntimeGovernance,
  CommandRuntimeInvocation,
  CommandRuntimeMiddleware,
} from "@supacloud/app";
import { decodeCommandPreview, type CommandPreview } from "@supacloud/contracts";
import { commandErrorCode, commandErrorStatus } from "./command-errors";
import { compileHttpPolicies, type HttpPolicyRegistry } from "./http-policy";
import { httpRequestId } from "./http-telemetry";
export { HttpPolicyConfigurationError } from "./http-policy";
export type { HttpPolicy, HttpPolicyContext, HttpPolicyResponseContext, HttpPolicyDeclaration, HttpPolicyRegistry } from "./http-policy";
export { createHttpPolicySuite } from "./http-policy-suite";
export type { HttpPolicySuiteOptions, BuiltinHttpPolicyDeclaration } from "./http-policy-suite";
export { createMemoryHttpRateLimitStore, createMemoryHttpCacheStore } from "./http-policy-stores";
export type { HttpRateLimitStore, HttpRateLimitResult, HttpCacheStore, HttpCacheEntry } from "./http-policy-stores";
export { createPostgresHttpPolicyStores, HTTP_POLICY_STORE_SQL } from "./http-policy-postgres";
export type { HttpPolicyDatabase } from "./http-policy-postgres";
export { createHttpTelemetry } from "./http-telemetry";
export type { HttpTelemetryEvent, HttpTelemetryObserver } from "./http-telemetry";
import { executionTrace, observeExecution, type ExecutionObserver } from "./execution";
import {
  createSchemaDecoder,
  responseStatusDeclared,
  responseStatusOf,
  toElysiaRouteSchema,
} from "./schema_contract";
import {
  createDocumentationPlugin,
  type ApplicationDocumentationOptions,
} from "./documentation";

export type { ExecutionEvent, ExecutionObserver } from "./execution";
export { bindCompiledCommand } from "./command-binding";
export type {
  CompiledCommandBinding,
  CompiledCommandBindingOptions,
  CompiledCommandCallContext,
} from "./command-binding";
export {
  createSchemaDecoder,
  assertResponseStatusDeclared,
  defineElysiaRoute,
  defineJsonContract,
  defineRouteContract,
  registerElysiaRoute,
  responseSchemaForStatus,
  responseStatusDeclared,
  responseStatusOf,
  SchemaContractError,
  toElysiaRouteSchema,
} from "./schema_contract";
export type {
  ElysiaRouteContext,
  ElysiaRouteDefinition,
  ElysiaRouteHandler,
  ElysiaRouteSchema,
  ResponseMapSelector,
  RouteContractSchemas,
  SchemaDecoderOptions,
  SchemaNormalizeMode,
} from "./schema_contract";
export { createPersistentCommandAdapter, type PersistentCommandHandler } from "./persistent-command";
export { createDocumentationPlugin } from "./documentation";
export type {
  ApplicationDocumentationOptions,
  DocumentationSource,
  GraphqlDocumentationOptions,
  OpenApiDocumentationOptions,
} from "./documentation";

// ---------------------------------------------------------------------------
// Compiled module contract (mirrors @supacloud/compiler output)
// ---------------------------------------------------------------------------

export interface CompiledRoute {
  /** Compiler-emitted route title, exposed as the OpenAPI operation summary. */
  title?: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  path: string;
  /** Method name on the controller instance. */
  handler: string;
  /** Static metadata preserved by the compiler; HTTP policies are adapter-owned. */
  data?: Record<string, unknown>;
  title?: string;
  /** TypeBox schema; validation is enabled only when the field is present. */
  body?: unknown;
  params?: unknown;
  query?: unknown;
  headers?: unknown;
  cookie?: unknown;
  /** @deprecated Use `responses` with an explicit HTTP status map. */
  response?: unknown;
  responses?: Record<string | number, unknown>;
  /** Compile-time ownership and transport classification for the route boundary. */
  contract?: {
    body?: "framework" | "domain";
    response?: "framework" | "native-json" | "binary" | "stream";
    evidence?: string;
  };
  /** Whether each declared schema is concrete or intentionally opaque. */
  schemaKinds?: Partial<Record<"body" | "params" | "query" | "headers" | "cookie" | "response", "opaque" | "declared">>;
  /** True when the handler returns a native Response rather than a framework value. */
  nativeResponse?: boolean;
  /** Compiler-emitted positional invoker; used when available. */
  invoker?: (
    controller: unknown,
    request: {
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, unknown>;
      cookie?: Record<string, unknown>;
      context?: unknown;
    },
  ) => Promise<unknown> | unknown;
  /** Class name of the @Command explicitly bound to this route. */
  command?: string;
  /** Statically generated route aspects. */
  aspects?: ApplicationAspect[];
  aspectPipeline?: ApplicationAspectPipeline;
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
  aspectPipeline?: ApplicationAspectPipeline;
}

export interface CompiledJob {
  className: string;
  name: string;
  serviceKey: string;
  scope: "application" | "request" | "job";
  /** TypeBox input schema emitted by the compiler. */
  input?: unknown;
  /** TypeBox output schema emitted by the compiler. */
  output?: unknown;
  mode?: "task" | "workflow";
  timeoutSec?: number;
  maxAttempts?: number;
  idempotency?: "required" | "none";
  aspects?: ApplicationAspect[];
  aspectPipeline?: ApplicationAspectPipeline;
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
  aspectPipeline?: ApplicationAspectPipeline;
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

export type CommandInvocation = CommandRuntimeInvocation<CompiledCommand>;

export type CommandExecutor = CommandRuntimeMiddleware<CommandInvocation>;

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
      const aspect = active[current];
      if (!aspect) return Promise.resolve(next());
      return Promise.resolve(aspect(context, () => dispatch(current + 1)));
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
      ...executionTrace(context.requestContext),
    }, () => aspect(context, next))));
}

export type ApplicationAspectPipeline = (
  context: ApplicationAspectContext,
  next: () => unknown | Promise<unknown>,
  observe?: (stage: string, run: () => unknown | Promise<unknown>) => unknown | Promise<unknown>,
) => unknown | Promise<unknown>;

function descriptorPipeline(
  descriptor: { aspects?: ApplicationAspect[]; aspectPipeline?: ApplicationAspectPipeline },
  boundary: string,
  observer?: ExecutionObserver,
): ApplicationAspect {
  const pipeline = descriptor.aspectPipeline;
  if (!pipeline) return observedAspects(descriptor.aspects ?? [], boundary, observer);
  return (context, next) => pipeline(context, next, observer
    ? (stage, run) => observeExecution(observer, {
      kind: context.kind, operation: context.name, stage: `${boundary}.${stage}`,
      ...executionTrace(context.requestContext),
    }, run)
    : undefined);
}

export type CommandAuthorizer = CommandRuntimeAuthorizer<CommandInvocation>;
export type CommandMiddleware = CommandRuntimeMiddleware<CommandInvocation>;
export type CommandAudit = CommandRuntimeAudit<CommandInvocation>;
export type CommandGovernance = CommandRuntimeGovernance<CommandInvocation>;

export interface CommandAuthorizationRequest {
  readonly principal: { readonly kind: "user" | "service"; readonly issuer: string; readonly subject: string };
  readonly applicationId: string;
  readonly domain: { readonly type: string; readonly id: string };
}

export interface CommandAuthorizationContext {
  readonly applicationId: string;
  readonly permissions: readonly string[];
  readonly permissionCatalogVersion?: string;
  readonly permissionCatalogDigest?: string;
}

export interface CommandAuthorizationCatalog {
  readonly version: string;
  readonly digest?: string;
}

export interface CommandAuthorizationAdapterOptions {
  readonly applicationId: string;
  readonly issuer: string;
  readonly domain: (invocation: CommandInvocation) => { readonly type: string; readonly id: string };
  readonly resolve: (request: CommandAuthorizationRequest) => Promise<CommandAuthorizationContext>;
  readonly catalog?: CommandAuthorizationCatalog;
}

/**
 * Adapt a SupAuth-style resolver to the standard command governance port.
 * The resolver remains the authorization source of truth; this adapter only
 * maps trusted request identity and normalizes public failure statuses.
 */
export function createCommandAuthorizationAdapter(
  options: CommandAuthorizationAdapterOptions,
): CommandAuthorizer {
  return async invocation => {
    const permission = invocation.command.permission;
    if (!permission || !/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/.test(permission)) {
      throw new ApplicationError("Command permission must use resource:action syntax", {
        status: 500, code: "COMMAND_PERMISSION_INVALID",
      });
    }
    const context = invocation.requestContext;
    const identity = isRecord(context) && isTrustedIdentity(context.identity) ? context.identity : undefined;
    if (!isAuthenticatedTrustedIdentity(identity)) {
      throw new ApplicationError("Authentication required", { status: 401, code: "AUTHENTICATION_REQUIRED" });
    }
    const request: CommandAuthorizationRequest = {
      principal: { kind: "user", issuer: options.issuer, subject: identity.subject },
      applicationId: options.applicationId,
      domain: options.domain(invocation),
    };
    // Resolver data may originate from JSON or untyped adapters. Never treat a
    // string's substring search (or a custom includes method) as a permission grant.
    let resolved: unknown;
    try {
      resolved = await options.resolve(request);
    } catch {
      throw new ApplicationError("Authorization is unavailable", { status: 503, code: "AUTHORIZATION_UNAVAILABLE" });
    }
    if (!isRecord(resolved)
      || !Array.isArray(resolved.permissions)
      || !resolved.permissions.every((value: unknown) => typeof value === "string")
      || (resolved.permissionCatalogVersion !== undefined && typeof resolved.permissionCatalogVersion !== "string")
      || (resolved.permissionCatalogDigest !== undefined && typeof resolved.permissionCatalogDigest !== "string")
      || resolved.applicationId !== options.applicationId
      || (options.catalog !== undefined && (
        resolved.permissionCatalogVersion !== options.catalog.version
        || (options.catalog.digest !== undefined && resolved.permissionCatalogDigest !== options.catalog.digest)
      ))) {
      throw new ApplicationError("Authorization context is not bound to this application", {
        status: 503, code: "AUTHORIZATION_CONTEXT_INVALID",
      });
    }
    if (!resolved.permissions.includes(permission)) {
      throw new ApplicationError("Permission denied", { status: 403, code: "PERMISSION_DENIED" });
    }
  };
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

const httpPluginIds = new WeakMap<object, number>();
let nextHttpPluginId = 0;

function contextPlugin<const Http extends AnyElysia = Elysia>(http?: Http) {
  let seed = http ? httpPluginIds.get(http) : 0;
  if (http && seed === undefined) {
    seed = ++nextHttpPluginId;
    httpPluginIds.set(http, seed);
  }
  // A stable native plugin identity deduplicates anonymous global hooks across
  // modules. Re-export inherited scoped hooks without promoting private ones.
  return new Elysia({ name: "supacloud:http-context", seed })
    .use((http ?? new Elysia()) as Http)
    .as("scoped");
}

function mountHttp<const Http extends AnyElysia = Elysia>(http?: Http, name?: string, normalize = true) {
  return new Elysia({ name, normalize }).use(contextPlugin(http));
}

export type ApplicationHttpContext<Http extends AnyElysia = Elysia> =
  Omit<InferContext<ReturnType<typeof mountHttp<Http>>>, "body" | "params" | "query" | "headers" | "cookie">
  & Pick<HttpContext, "body" | "params" | "query" | "headers" | "cookie">;

export type HttpRequestContextFactory<Http extends AnyElysia = Elysia, Value = unknown> = (
  request: Request,
  context: ApplicationHttpContext<Http>,
) => Value | Promise<Value>;

export interface ApplicationOptions<Http extends AnyElysia = Elysia, RequestContext = unknown> {
  name?: string;
  /** false rejects extra schema properties instead of silently removing them. */
  normalize?: boolean;
  /** Modules in topological import order. */
  modules?: CompiledModule[];
  /** Platform-level dependencies (db client etc.), passed to createServices. */
  deps?: Record<string, unknown>;
  /** Native plugin. Use scoped/global derive/resolve hooks to extend compiled routes. */
  http?: Http;
  /** Startup-compiled policies selected by route.data.httpPolicies, in declaration order. */
  httpPolicies?: HttpPolicyRegistry<Http>;
  /** Runs after validation and HTTP resolvers, with the validated native context. */
  requestContext?: HttpRequestContextFactory<Http, RequestContext>;
  /** Enforces permission/audit/idempotency policy for command-bound routes. */
  commandGovernance?: CommandGovernance;
  /** Optional custom or composed executor. When provided alongside commandGovernance, it wraps or composes with governance. */
  commandExecutor?: CommandExecutor;
  /** Maps framework or application failures to the public HTTP contract. */
  errorMapper?: ErrorMapper;
  /** Best-effort execution metadata only; durable audit belongs to governance. */
  onExecution?: ExecutionObserver;
  /** Optional read-only OpenAPI and GraphQL documentation endpoints. */
  documentation?: ApplicationDocumentationOptions;
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

type JobContractBoundary = "input" | "output";

function decodeJobContract(
  schema: unknown,
  value: unknown,
  boundary: JobContractBoundary,
): unknown {
  if (schema === undefined) return value;
  try {
    return createSchemaDecoder(schema as TSchema)(value);
  } catch {
    const input = boundary === "input";
    throw new ApplicationError(
      input ? "Job input contract validation failed" : "Job output contract validation failed",
      {
        status: input ? 422 : 500,
        code: input ? "JOB_INPUT_VALIDATION_ERROR" : "JOB_OUTPUT_VALIDATION_ERROR",
      },
    );
  }
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
  return match?.[1] ? safeHeaderValue(match[1], 16_384) : undefined;
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
  const requestId = httpRequestId(request) ?? safeHeaderValue(
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
        ...executionTrace(invocation.requestContext) };
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
          ...executionTrace(invocation.requestContext),
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
  module: Pick<CompiledModule, "name" | "commands" | "aspects" | "aspectPipeline">;
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
  const command = matches[0];
  if (!command) throw new Error(`Command not found: ${options.command}`);
  const invocation: CommandInvocation = {
    command, input: { body: options.input, params: {}, query: {} },
    request: options.request, requestContext: options.requestContext,
    services: options.services ?? {}, ...(options.scope ? { scope: options.scope } : {}),
  };
  const aspects = composeAspects(
    descriptorPipeline(options.module, `module:${options.module.name}`, options.observer),
    descriptorPipeline(command, "command", options.observer),
  );
  // Authorization encloses aspects so denied calls cannot trigger their side effects.
  const value = await createCommandExecutor(options.governance, options.observer)(invocation,
    once(() => aspects({ kind: "command", name: command.name, input: options.input,
      request: options.request, requestContext: options.requestContext,
      services: invocation.services, ...(invocation.scope ? { scope: invocation.scope } : {}), metadata: command },
    once(() => options.handler(options.input)))));
  return options.decode(value);
}

/** Read-only actionability. Accepts the same governance object as execute, but only runs authorize. */
export async function previewCompiledCommand<Input>(options: {
  module: Pick<CompiledModule, "name" | "commands">;
  command: string;
  input: Input;
  request: Request;
  requestContext: unknown;
  services?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  governance: CommandGovernance;
  preview: (input: Input) => unknown;
}): Promise<CommandPreview> {
  const matches = options.module.commands?.filter((item) => item.className === options.command) ?? [];
  if (matches.length !== 1) throw new ApplicationError("Command descriptor missing or ambiguous", { code: "COMMAND_NOT_REGISTERED" });
  const command = matches[0];
  if (!command) throw new Error(`Command not found: ${options.command}`);
  const invocation: CommandInvocation = {
    command, input: { body: options.input, params: {}, query: {} },
    request: options.request, requestContext: options.requestContext,
    services: options.services ?? {}, ...(options.scope ? { scope: options.scope } : {}),
  };
  try {
    await options.governance.authorize(invocation);
  } catch (error) {
    if (error instanceof ApplicationError && (error.status === 401 || error.status === 403)) {
      return decodeCommandPreview({
        command: command.name,
        allowed: false,
        blockers: [{ code: error.code, message: error.message }],
      });
    }
    throw error;
  }
  const preview = decodeCommandPreview(await options.preview(options.input));
  if (preview.command !== command.name && preview.command !== command.className) {
    throw new TypeError("Mismatched command identity");
  }
  return preview;
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

function assertCommandGovernanceReady(
  compiled: CompiledModule,
  governance: CommandGovernance | undefined,
  executor: CommandExecutor | undefined,
): void {
  if ((compiled.commands ?? []).length === 0) return;
  if (executor !== undefined && typeof executor !== "function") {
    throw new ApplicationError(`Module "${compiled.name}" has no callable command executor`, {
      code: "COMMAND_EXECUTOR_UNCONFIGURED",
    });
  }
  if (!governance && !executor) {
    throw new ApplicationError(`Module "${compiled.name}" has commands but no command governance`, {
      code: "COMMAND_GOVERNANCE_UNCONFIGURED",
    });
  }
  if (!governance) return;
  if (typeof governance.authorize !== "function") {
    throw new ApplicationError(`Module "${compiled.name}" has no authorization adapter`, {
      code: "COMMAND_AUTHORIZATION_UNCONFIGURED",
    });
  }
  for (const command of compiled.commands ?? []) {
    if (command.audit && command.rpc === undefined
      && (typeof governance.audit?.succeeded !== "function" || typeof governance.audit?.failed !== "function")) {
      throw new ApplicationError(`Command "${command.name}" has no audit adapter`, {
        code: "COMMAND_AUDIT_UNCONFIGURED",
      });
    }
    if (command.idempotency === "required" && typeof governance.idempotency !== "function" && command.rpc === undefined) {
      throw new ApplicationError(`Command "${command.name}" has no idempotency adapter`, {
        code: "COMMAND_IDEMPOTENCY_UNCONFIGURED",
      });
    }
    if (command.transaction === "required" && typeof governance.transaction !== "function" && command.rpc === undefined) {
      throw new ApplicationError(`Command "${command.name}" has no transaction adapter`, {
        code: "COMMAND_TRANSACTION_UNCONFIGURED",
      });
    }
    if (command.rpc !== undefined) {
      const adapter = Object.hasOwn(governance.rpc ?? {}, command.rpc) ? governance.rpc?.[command.rpc] : undefined;
      if (!adapter || typeof adapter.execute !== "function" || !isRecord(adapter.capabilities)) {
        throw new ApplicationError(`Command "${command.name}" has no RPC governance adapter`, {
          code: "COMMAND_RPC_UNCONFIGURED",
        });
      }
      if (command.audit && adapter.capabilities.audit !== true) {
        throw new ApplicationError(`Command "${command.name}" RPC adapter has no audit capability`, {
          code: "COMMAND_AUDIT_UNCONFIGURED",
        });
      }
      if (command.idempotency === "required" && adapter.capabilities.idempotency !== true) {
        throw new ApplicationError(`Command "${command.name}" RPC adapter has no idempotency capability`, {
          code: "COMMAND_IDEMPOTENCY_UNCONFIGURED",
        });
      }
      if (command.transaction === "required" && adapter.capabilities.transaction !== true) {
        throw new ApplicationError(`Command "${command.name}" RPC adapter has no transaction capability`, {
          code: "COMMAND_TRANSACTION_UNCONFIGURED",
        });
      }
    }
  }
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
  headers?: Record<string, unknown>;
  cookie?: Record<string, unknown>;
  request: Request;
  set: {
    status?: number | keyof StatusMap;
  };
  scope?: Record<string, unknown>;
  requestContext?: unknown;
}

type ControllerInstance = Record<string, unknown>;

function controllerInstance(value: unknown): ControllerInstance | undefined {
  return isRecord(value) ? value : undefined;
}

function cookieValues(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    result[name] = isRecord(entry) && "value" in entry ? entry.value : entry;
  }
  return result;
}

function assertDeclaredResponseStatus(
  route: CompiledRoute,
  value: unknown,
  configuredStatus: number | string | undefined,
): void {
  if (route.responses === undefined) return;
  const status = responseStatusOf(value, configuredStatus);
  if (responseStatusDeclared(route.responses, status)) return;
  // Binary/stream routes may intentionally declare only JSON error responses.
  // Their successful transport is validated by bytes/headers at the host boundary.
  const transport = route.contract?.response;
  if ((transport === "binary" || transport === "stream") && status >= 200 && status < 300) return;
  throw new ApplicationError(
    "Response validation failed",
    { status: 500, code: "RESPONSE_CONTRACT_UNDECLARED" },
  );
}

/**
 * Adapt a single compiled module into an Elysia plugin.
 *
 * The plugin resolves module-local `services`; when the module defines
 * `createRequestScope`, a fresh scope is created inside the governed handler
 * and passed to the controller input as `scope`. Request-scoped controllers
 * are looked up on that scope, everything else on `services`.
 */
export function createModulePlugin<
  const Services extends Record<string, unknown>,
  const Http extends AnyElysia = Elysia,
>(
  compiled: CompiledModule,
  services: Services,
  ctxFactory: HttpRequestContextFactory<Http> = defaultRequestContext,
  options: Pick<ApplicationOptions<Http>, "http" | "httpPolicies" | "commandGovernance" | "commandExecutor" | "errorMapper" | "onExecution" | "normalize"> = {},
  imported: Record<string, Record<string, unknown>> = {},
) {
  // Compiled descriptors are also loadable from JavaScript and older generators.
  // Reject options we cannot preserve instead of silently dropping native hooks.
  const supportedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
  const supportedFields = new Set([
    "method", "path", "handler", "body", "params", "query", "headers", "cookie",
    "response", "responses", "contract", "schemaKinds", "nativeResponse", "invoker",
    "command", "aspects", "aspectPipeline",
    "paramTransforms", "paramDefaults", "queryTransforms", "queryDefaults", "title", "data",
    // defineJsonContract can be spread into a route; these helpers are not hooks.
    "input", "result", "request",
  ]);
  for (const controller of compiled.controllers) {
    for (const route of controller.routes) {
      const unsupported = Object.keys(route).filter((field) => !supportedFields.has(field));
      if (!supportedMethods.has(route.method) || unsupported.length > 0) {
        throw new ApplicationError(
          `Unsupported compiled route ${route.method} ${controller.path}${route.path}`
          + (unsupported.length > 0 ? `: ${unsupported.join(", ")}` : ""),
          { code: "ROUTE_DESCRIPTOR_UNSUPPORTED" },
        );
      }
    }
  }
  const hasCommandRoutes = compiled.controllers.some((controller) =>
    controller.routes.some((route) => route.command !== undefined),
  );
  if (hasCommandRoutes && !options.commandGovernance && !options.commandExecutor) {
    throw new ApplicationError(
      `Module "${compiled.name}" has command routes but no commandGovernance`,
      { code: "COMMAND_GOVERNANCE_UNCONFIGURED" },
    );
  }
  assertCommandGovernanceReady(compiled, options.commandGovernance, options.commandExecutor);
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

  const plugin = mountHttp(options.http, `supacloud:${compiled.name}`, options.normalize ?? true)
    .resolve(async (context) => {
      const requestContext = await ctxFactory(context.request, context as ApplicationHttpContext<Http>);
      requestContexts.set(context.request, requestContext);
      // Elysia merges decorators across siblings. Resolve the original map
      // locally so colliding service names cannot change module ownership.
      return { services, requestContext };
    });

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

  // Compiled descriptors carry runtime schemas, not native literal route types.
  // Widen only registration; keep the public plugin's context/service inference.
  const routeRegistrar = plugin as unknown as Elysia;
  for (const controller of compiled.controllers) {
    for (const route of controller.routes) {
      const path = joinPaths(controller.path, route.path);
      const schema = {
        ...toElysiaRouteSchema(route),
        ...(route.title ? { detail: { summary: route.title } } : {}),
      };
      const policies = compileHttpPolicies(route, path, options.httpPolicies);
      if (policies.length > 0) {
        Object.assign(schema, {
          beforeHandle: async (context: ApplicationHttpContext<Http>) => {
            for (const policy of policies) {
              const result = await policy({
                http: context,
                requestContext: requestContexts.get(context.request),
              });
              if (result instanceof Response) return result;
              if (result !== undefined) {
                throw new Error("HTTP policies must return Response or undefined");
              }
            }
          },
        });
      }
      const responsePolicies = policies.filter((policy) => policy.afterResponse);
      const mappingPolicies = policies.filter((policy) => policy.mapResponse);
      if (mappingPolicies.length > 0) {
        Object.assign(schema, {
          mapResponse: async (context: ApplicationHttpContext<Http> & { response: unknown }) => {
            let response = context.response;
            let mapped: Response | undefined;
            for (const policy of mappingPolicies) {
              const result = await policy.mapResponse!({
                http: context, requestContext: requestContexts.get(context.request), response,
              });
              if (result !== undefined) {
                if (!(result instanceof Response)) throw new Error("HTTP response policies must return Response or undefined");
                mapped = result;
                response = result;
              }
            }
            return mapped;
          },
        });
      }
      if (responsePolicies.length > 0) {
        Object.assign(schema, {
          afterResponse: async (context: ApplicationHttpContext<Http> & { response: unknown }) => {
            for (const policy of responsePolicies) {
              await policy.afterResponse!({
                http: context,
                requestContext: requestContexts.get(context.request),
                response: context.response,
              });
            }
          },
        });
      }

      const handler = async (ctx: HttpContext) => {
        const requestContext = requestContexts.get(ctx.request);
        const execute = async () => {
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
          const normalizedCookie = ctx.cookie === undefined ? undefined : cookieValues(ctx.cookie);
          const input = {
            body: ctx.body,
            params: ctx.params,
            query: ctx.query,
            headers: ctx.headers ?? Object.fromEntries(ctx.request.headers.entries()),
            ...(normalizedCookie === undefined ? {} : { cookie: normalizedCookie }),
            context: requestContext,
            request: ctx.request,
            ...(requestScope ? { scope: requestScope } : {}),
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
              ...executionTrace(requestContext),
            }, handlerCall));
          const routeContext: ApplicationAspectContext = {
            kind: "route",
            name: `${route.method} ${path}`,
            input,
            request: ctx.request,
            requestContext,
            ...(requestScope ? { scope: requestScope } : {}),
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
            ...(requestScope ? { scope: requestScope } : {}),
            services,
            metadata: command ?? route,
          };
          const routePipeline = descriptorPipeline(route, "route", options.onExecution);
          const commandPipeline = descriptorPipeline(command ?? {}, "command", options.onExecution);
          const modulePipeline = descriptorPipeline(compiled, `module:${compiled.name}`, options.onExecution);
          const invokeRoute = () => modulePipeline(
            route.command ? commandContext : routeContext,
            once(() => routePipeline(routeContext, once(() => route.command
              ? commandPipeline(commandContext, once(invoke))
              : invoke()))),
          );
          const invokeCommand = () => {
            if (!route.command) return invokeRoute();
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
              ...(requestScope ? { scope: requestScope } : {}),
              services,
            };
            return observeExecution(options.onExecution, {
              kind: "command", operation: command.name, stage: "commandExecutor",
              ...executionTrace(requestContext),
            }, () => commandExecutor(invocation, once(invokeRoute)));
          };
          return invokeCommand();
        };
        const result = await execute();
        assertDeclaredResponseStatus(route, result, ctx.set.status);
        return result;
      };

      switch (route.method) {
        case "GET":
          routeRegistrar.get(path, handler, schema);
          break;
        case "POST":
          routeRegistrar.post(path, handler, schema);
          break;
        case "PUT":
          routeRegistrar.put(path, handler, schema);
          break;
        case "PATCH":
          routeRegistrar.patch(path, handler, schema);
          break;
        case "DELETE":
          routeRegistrar.delete(path, handler, schema);
          break;
        case "HEAD":
          routeRegistrar.head(path, handler, schema);
          break;
        case "OPTIONS":
          routeRegistrar.options(path, handler, schema);
          break;
      }
    }
  }

  return plugin;
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
  // Validate before creating a job scope so malformed input cannot construct
  // providers or perform any application work.
  const decodedInput = decodeJobContract(job.input, input, "input");
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
      input: decodedInput,
      requestContext,
      ...(jobScope ? { scope: jobScope } : {}),
      services,
    };
    const context: ApplicationAspectContext = {
      kind: "job",
      name: job.name,
      input: decodedInput,
      requestContext,
      ...(jobScope ? { scope: jobScope } : {}),
      services,
      metadata: job,
    };
    const invoke = once(() => observeExecution(observer, {
      kind: "job", operation: job.name, stage: "handler",
      ...executionTrace(requestContext),
    }, () => Reflect.apply(method, instance, [decodedInput])));
    const pipeline = descriptorPipeline(compiled, `module:${compiled.name}`, observer);
    const jobPipeline = descriptorPipeline(job, "job", observer);

    const result = await pipeline(
      context,
      () => jobPipeline(context, () => observeExecution(observer, {
        kind: "job", operation: job.name, stage: "jobExecutor",
        ...executionTrace(requestContext),
      }, executor ? () => executor(invocation, invoke) : invoke)),
    );
    return decodeJobContract(job.output, result, "output");
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
  const protocolCode = commandErrorCode(error);
  if (protocolCode) {
    return Response.json({ ok: false, code: protocolCode, message: protocolCode }, {
      status: commandErrorStatus(protocolCode),
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
  if (frameworkCode === "PARSE") {
    return Response.json({
      ok: false,
      code: "PARSE_ERROR",
      message: "Request body could not be parsed",
    }, { status: 400 });
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
export function createApplication<const Http extends AnyElysia = Elysia>(
  options: ApplicationOptions<Http>,
) {
  const app = new Elysia({ name: options.name ?? "supacloud:app", normalize: options.normalize ?? true });
  if (options.documentation) app.use(createDocumentationPlugin(options.documentation));
  const configuredContextFactory = options.requestContext ?? defaultRequestContext;
  const contextCache = new WeakMap<Request, Promise<unknown>>();
  const ctxFactory: HttpRequestContextFactory<Http> = (request, context) => {
    const cached = contextCache.get(request);
    if (cached) return cached;
    const pending = Promise.resolve(configuredContextFactory(request, context));
    contextCache.set(request, pending);
    return pending;
  };
  const imported: Record<string, Record<string, unknown>> = {};

  for (const module of options.modules ?? []) {
    const services = module.createServices(options.deps ?? {}, imported);
    imported[module.name] = services;
    app.use(createModulePlugin(module, services, ctxFactory, options, imported));
  }

  // Install root extensions after compiled routes: each module already owns
  // its hooks. Installing earlier would execute anonymous hooks twice.
  return app.use(contextPlugin(options.http));
}

/** Semantic alias of createApplication for readable tests. */
export function createTestApp<const Http extends AnyElysia = Elysia>(options: ApplicationOptions<Http>) {
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
export {
  createQueueWorkerTransport,
  createWorker,
  SupaCloudWorker,
  WorkerRegistrationError,
  WorkerReceiptUnconfirmedError,
} from "./worker";
export type {
  WorkerAcknowledge,
  WorkerClaim,
  WorkerFail,
  WorkerOptions,
  QueueWorkerTransportOptions,
  WorkerQueueFailureOptions,
  WorkerQueueMessage,
  WorkerQueuePort,
  WorkerQueueReceiveOptions,
  WorkerReceiptContext,
  WorkerReceiptOperation,
  WorkerRunResult,
  WorkerState,
  WorkerTransport,
} from "./worker";
