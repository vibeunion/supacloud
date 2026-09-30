import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Shared, browser-safe contract. Hash integrity does not imply a trusted producer. */
export const APPLICATION_DEVELOPMENT_SCHEMA = "supacloud.application-development.v1";
export const APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES = 524_288;
export const APPLICATION_DEVELOPMENT_LIMITS = Object.freeze({
  outputBytes: 65_536,
  modules: 64, providers: 128, routes: 256, commands: 128, jobs: 128,
  resources: 64, resourceUses: 128, plans: 128, diagnostics: 64,
});

export class DevelopmentContractError extends Error {
  constructor(readonly code: "APPLICATION_DEVELOPMENT_INVALID" | "APPLICATION_DEVELOPMENT_TOO_LARGE") {
    super(code);
    this.name = "DevelopmentContractError";
  }
}

const closed = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const texts = Type.Array(text);
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const mode = Type.Union([Type.Literal("required"), Type.Literal("none")]);
const operations = Type.Array(Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("publish"), Type.Literal("consume")]));
const resourceUse = Type.Object({ resource: text, operations }, closed);
const schemaKind = Type.Optional(Type.Union([Type.Literal("opaque"), Type.Literal("declared")]));
const stage = Type.Union([
  Type.Union([Type.Literal("commandExecutor"), Type.Literal("jobExecutor"), Type.Literal("authorize"), Type.Literal("idempotency"), Type.Literal("transaction"), Type.Literal("handler"), Type.Literal("audit")]),
  Type.String({ maxLength: 512, pattern: "^rpc:[^\\u0000-\\u001f\\u007f]+$" }),
  Type.String({ maxLength: 512,
    pattern: "^(?:module:[^\\u0000-\\u001f\\u007f]+|route|command|job)\\.aspect\\[(?:0|[1-9][0-9]*)\\]:[^\\u0000-\\u001f\\u007f]+$" }),
]);
const ContextSchema = Type.Object({
  schema: Type.Literal(APPLICATION_DEVELOPMENT_SCHEMA),
  source: Type.Literal("current-graph"), deploymentVerified: Type.Literal(false),
  modules: Type.Array(Type.Object({
    name: text, className: text, file: Type.Optional(text), tags: Type.Optional(texts),
    providers: texts, controllers: texts, commands: texts, jobs: texts, queries: texts, resources: texts,
  }, closed), { maxItems: APPLICATION_DEVELOPMENT_LIMITS.modules }),
  routes: Type.Array(Type.Object({
    module: text, method: Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("PATCH"), Type.Literal("DELETE"), Type.Literal("HEAD"), Type.Literal("OPTIONS")]),
    path: text, controller: text, handler: text, command: Type.Optional(text), aspects: texts,
    schemaKinds: Type.Optional(Type.Object({
      body: schemaKind, params: schemaKind, query: schemaKind, headers: schemaKind, cookie: schemaKind, response: schemaKind,
    }, closed)),
  }, closed), { maxItems: APPLICATION_DEVELOPMENT_LIMITS.routes }),
  commands: Type.Array(Type.Object({
    module: text, name: text, permission: Type.Optional(text), transaction: mode, idempotency: mode,
    audit: Type.Optional(text), resources: Type.Array(resourceUse),
  }, closed), { maxItems: APPLICATION_DEVELOPMENT_LIMITS.commands }),
  jobs: Type.Array(Type.Object({
    module: text, name: text, mode: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("workflow")])), resources: Type.Array(resourceUse),
  }, closed), { maxItems: APPLICATION_DEVELOPMENT_LIMITS.jobs }),
  resources: Type.Array(Type.Object({ name: text, kind: Type.Union([Type.Literal("database"), Type.Literal("bucket"), Type.Literal("queue"), Type.Literal("config"), Type.Literal("secret")]) }, closed),
    { maxItems: APPLICATION_DEVELOPMENT_LIMITS.resources }),
  resourceUses: Type.Array(Type.Object({
    module: text, owner: text, ownerKind: Type.Union([Type.Literal("command"), Type.Literal("job")]), resource: text, operations,
  }, closed), { maxItems: APPLICATION_DEVELOPMENT_LIMITS.resourceUses }),
  executionPlans: Type.Array(Type.Object({
    module: text, kind: Type.Union([Type.Literal("route"), Type.Literal("command"), Type.Literal("job")]), name: text, command: Type.Optional(text), stages: Type.Array(stage),
  }, closed), { maxItems: APPLICATION_DEVELOPMENT_LIMITS.plans }),
  diagnostics: Type.Array(Type.Object({
    code: text, severity: Type.Union([Type.Literal("error"), Type.Literal("warn")]), file: Type.Optional(text),
    line: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    repair: Type.Optional(Type.Object({
      type: Type.Union([Type.Literal("set_command_mode"), Type.Literal("add_module_import"), Type.Literal("add_provider"), Type.Literal("mark_optional_dependency"), Type.Literal("change_provider_scope"), Type.Literal("add_command_permission"), Type.Literal("add_route_parameter_binding"), Type.Literal("remove_route_body_binding")]),
      readiness: Type.Union([Type.Literal("preview"), Type.Literal("input-required"), Type.Literal("manual")]),
    }, closed)),
  }, closed), { maxItems: APPLICATION_DEVELOPMENT_LIMITS.diagnostics }),
  omitted: Type.Object({ modules: count, providers: count, routes: count, commands: count, jobs: count,
    resources: count, resourceUses: count, plans: count, diagnostics: count }, closed),
  limits: Type.Object({
    outputBytes: Type.Literal(APPLICATION_DEVELOPMENT_LIMITS.outputBytes),
    modules: Type.Literal(APPLICATION_DEVELOPMENT_LIMITS.modules), providers: Type.Literal(APPLICATION_DEVELOPMENT_LIMITS.providers),
    routes: Type.Literal(APPLICATION_DEVELOPMENT_LIMITS.routes), commands: Type.Literal(APPLICATION_DEVELOPMENT_LIMITS.commands),
    jobs: Type.Literal(APPLICATION_DEVELOPMENT_LIMITS.jobs), resources: Type.Literal(APPLICATION_DEVELOPMENT_LIMITS.resources),
    resourceUses: Type.Literal(APPLICATION_DEVELOPMENT_LIMITS.resourceUses), plans: Type.Literal(APPLICATION_DEVELOPMENT_LIMITS.plans),
    diagnostics: Type.Literal(APPLICATION_DEVELOPMENT_LIMITS.diagnostics),
  }, closed),
}, closed);

export type DevelopmentContext = Static<typeof ContextSchema>;

/** Relative, non-traversing source paths only, independent of the reader's OS. */
function safeSourceFile(file: string): boolean {
  return !file.startsWith("/") && !file.startsWith("\\")
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(file)
    && !file.split(/[\\/]/).includes("..");
}

/** Validate nested fields and the detached representation; never echo rejected input. */
export function parseDevelopmentContext(input: unknown): DevelopmentContext {
  const invalid = () => new DevelopmentContractError("APPLICATION_DEVELOPMENT_INVALID");
  try {
    if (!Value.Check(ContextSchema, input)) throw invalid();
    const json = JSON.stringify(input, null, 2) + "\n";
    if (new TextEncoder().encode(json).byteLength > APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES) {
      throw new DevelopmentContractError("APPLICATION_DEVELOPMENT_TOO_LARGE");
    }
    const value: unknown = JSON.parse(json);
    if (!Value.Check(ContextSchema, value)) throw invalid();
    const files = [...value.modules.flatMap(module => module.file ?? []),
      ...value.diagnostics.flatMap(diagnostic => diagnostic.file ?? [])];
    if (files.some(file => !safeSourceFile(file))
      || value.modules.reduce((total, module) => total + module.providers.length, 0) > APPLICATION_DEVELOPMENT_LIMITS.providers) {
      throw invalid();
    }
    return value;
  } catch (error) {
    if (error instanceof DevelopmentContractError) throw error;
    throw invalid();
  }
}

/** Bind every included entry to the hashed target; projection omissions remain valid. */
export function assertDevelopmentTarget(
  context: DevelopmentContext,
  planned: import("./delivery-schema").DeliveryTarget,
): void {
  const modules = new Set(planned.modules.map(module => module.name));
  if (context.modules.some(module => !modules.has(module.name))
    || [...context.commands, ...context.resourceUses, ...context.executionPlans].some(item => !modules.has(item.module))
    || context.routes.some(route => !planned.routes.some(owned => owned.module === route.module
      && owned.method === route.method && owned.path === route.path
      && owned.controller === route.controller && owned.handler === route.handler))
    || context.jobs.some(job => !planned.jobs.some(owned => owned.module === job.module && owned.name === job.name))
    || context.resourceUses.some(use => use.ownerKind === "job"
      && !planned.jobs.some(job => job.module === use.module && job.name === use.owner))
    || context.executionPlans.some(plan => plan.kind === "job"
      ? !planned.jobs.some(job => job.module === plan.module && job.name === plan.name)
      : plan.kind === "route" && !planned.routes.some(route => route.module === plan.module
        && `${route.method} ${route.path}` === plan.name))) {
    throw new DevelopmentContractError("APPLICATION_DEVELOPMENT_INVALID");
  }
}
