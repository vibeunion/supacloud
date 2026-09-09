import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const objectOptions = { additionalProperties: false } as const;
const reference = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z][A-Za-z0-9_.:/-]*$" });
const references = Type.Array(reference, { uniqueItems: true });
const kind = Type.Union([Type.Literal("api"), Type.Literal("jobs"), Type.Literal("webhook")]);
const isolation = Type.Union([Type.Literal("shared"), Type.Literal("process")]);
export const DeliveryFilePathSchema = Type.String({
  maxLength: 512,
  pattern: "^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$",
});

export const DeliveryOptionsSchema = Type.Object({
  version: Type.Literal(1),
  targets: Type.Optional(Type.Array(Type.Object({
    name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
    kind,
    modules: Type.Array(reference, { minItems: 1, uniqueItems: true }),
    isolation: Type.Optional(isolation),
    capabilities: Type.Optional(references),
  }, objectOptions))),
  // These are declarations, never evidence that a remote host enforces isolation.
  runtime: Type.Optional(Type.Object({
    processIsolation: Type.Boolean(),
    durableQueue: Type.Boolean(),
    capabilities: references,
  }, objectOptions)),
  build: Type.Optional(Type.Object({
    minify: Type.Optional(Type.Boolean()),
    environmentContract: Type.Optional(reference),
    assets: Type.Optional(Type.Array(Type.Object({
      target: Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
      source: DeliveryFilePathSchema,
      path: DeliveryFilePathSchema,
    }, objectOptions))),
  }, objectOptions)),
}, objectOptions);

export type DeliveryOptions = Static<typeof DeliveryOptionsSchema>;

export const DeliveryDiagnosticSchema = Type.Object({
  severity: Type.Union([Type.Literal("error"), Type.Literal("warn")]),
  code: Type.String(),
  message: Type.String(),
  suggestion: Type.Optional(Type.String()),
  file: Type.Optional(Type.String()),
  line: Type.Optional(Type.Integer({ minimum: 1 })),
}, objectOptions);

const routeSchema = Type.Object({
  module: Type.String(),
  controller: Type.String(),
  handler: Type.String(),
  method: Type.Union([
    Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("PATCH"),
    Type.Literal("DELETE"), Type.Literal("HEAD"), Type.Literal("OPTIONS"),
  ]),
  path: Type.String(),
  command: Type.Optional(Type.String()),
  reason: Type.Union([Type.Literal("default-http"), Type.Literal("explicit-module")]),
}, objectOptions);

const jobSchema = Type.Object({
  module: Type.String(),
  name: Type.String(),
  className: Type.String(),
  serviceKey: Type.String(),
  reason: Type.Union([Type.Literal("declared-job"), Type.Literal("explicit-module")]),
}, objectOptions);

export const DeliveryTargetSchema = Type.Object({
  name: Type.String(),
  kind,
  isolation,
  roots: Type.Array(Type.String()),
  modules: Type.Array(Type.Object({
    name: Type.String(),
    reason: Type.Union([Type.Literal("owner"), Type.Literal("dependency")]),
    importedBy: Type.Array(Type.String()),
  }, objectOptions)),
  routes: Type.Array(routeSchema),
  jobs: Type.Array(jobSchema),
  externalTokens: Type.Array(Type.String()),
  requirements: Type.Object({
    processIsolation: Type.Boolean(),
    durableQueue: Type.Boolean(),
    capabilities: references,
  }, objectOptions),
  runtimeStatus: Type.Union([Type.Literal("unchecked"), Type.Literal("declared-compatible")]),
}, objectOptions);

export const DeliveryPlanSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  policyVersion: Type.Literal("module-workload-v1"),
  digestScope: Type.Literal("topology-only"),
  topologyDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  deploymentReady: Type.Literal(false),
  targets: Type.Array(DeliveryTargetSchema),
}, objectOptions);

export const DeliveryPlanResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    plan: DeliveryPlanSchema,
    diagnostics: Type.Array(DeliveryDiagnosticSchema),
    written: Type.Array(Type.String(), { maxItems: 0 }),
  }, objectOptions),
  Type.Object({
    ok: Type.Literal(false),
    plan: Type.Null(),
    diagnostics: Type.Array(DeliveryDiagnosticSchema),
    written: Type.Array(Type.String(), { maxItems: 0 }),
  }, objectOptions),
]);

export type DeliveryTarget = Static<typeof DeliveryTargetSchema>;
export type DeliveryPlan = Static<typeof DeliveryPlanSchema>;
export type DeliveryDiagnostic = Static<typeof DeliveryDiagnosticSchema>;
export type DeliveryPlanResult = Static<typeof DeliveryPlanResultSchema>;

export class DeliveryConfigurationError extends Error {
  readonly code = "delivery-config-invalid";

  constructor() {
    // Never include rejected values: configuration may accidentally contain secrets.
    super("Invalid delivery configuration. Expected version: 1, optional targets, runtime and build; unknown keys and invalid references are rejected.");
    this.name = "DeliveryConfigurationError";
  }
}

export function parseDeliveryOptions(value: unknown): DeliveryOptions {
  if (value === undefined) return { version: 1 };
  if (!Value.Check(DeliveryOptionsSchema, value)) throw new DeliveryConfigurationError();
  return value;
}

/** Validate plans received from files/messages before using their typed contract. */
export function parseDeliveryPlanResult(value: unknown): DeliveryPlanResult {
  if (!Value.Check(DeliveryPlanResultSchema, value)) throw new Error("Invalid delivery plan result.");
  return value;
}
