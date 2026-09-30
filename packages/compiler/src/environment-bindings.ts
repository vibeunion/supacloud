import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ApplicationGraph, InfraResourceKind } from "./types";

/**
 * Static, per-environment binding of logical `@InfraResource` declarations.
 *
 * This is the declaration side only: it maps a logical resource name to an
 * opaque binding reference (for example `local` or `project:orders`). It never
 * carries a connection string, credential or hosting decision, and it never
 * proves that a target environment actually provides the resource. Runtime
 * credential resolution and deployment preflight remain separate concerns.
 */
export const ENVIRONMENT_BINDINGS_SCHEMA = "supacloud.environments.v1";
export const ENVIRONMENT_BINDINGS_PROJECTION_SCHEMA = "supacloud.environment-bindings.v1";
/** `local`, or a single `scheme:name` namespace; never a URL or credential. */
export const ENVIRONMENT_BINDING_REFERENCE_PATTERN = "^(?:local|[a-z][a-z0-9-]{0,15}:[A-Za-z0-9][A-Za-z0-9_.-]{0,63})$";

export const ENVIRONMENT_BINDINGS_LIMITS: {
  readonly environments: number;
  readonly bindings: number;
  readonly resources: number;
  readonly outputBytes: number;
} = Object.freeze({ environments: 32, bindings: 128, resources: 64, outputBytes: 65_536 });

export type EnvironmentBindingErrorCode =
  | "ENVIRONMENT_BINDINGS_INVALID"
  | "ENVIRONMENT_BINDINGS_TOO_LARGE"
  | "ENVIRONMENT_BINDINGS_UNKNOWN_ENVIRONMENT"
  | "ENVIRONMENT_BINDINGS_PRODUCTION_FORBIDDEN";

export class EnvironmentBindingError extends Error {
  constructor(readonly code: EnvironmentBindingErrorCode) {
    super(code);
    this.name = "EnvironmentBindingError";
  }
}

export type EnvironmentBindingDiagnosticCode =
  | "missing-environment-binding"
  | "unknown-environment-binding"
  | "invalid-environment-binding";

export interface EnvironmentBindingDiagnostic {
  code: EnvironmentBindingDiagnosticCode;
  severity: "error";
  environment: string;
  resource?: string;
  message: string;
}

export interface EnvironmentBindingsDocument {
  schema: typeof ENVIRONMENT_BINDINGS_SCHEMA;
  environments: Record<string, { bindings: Record<string, string> }>;
}

export interface EnvironmentBindingEntry {
  resource: string;
  kind: InfraResourceKind;
  binding: string;
}

export interface EnvironmentBindingsProjection {
  schema: typeof ENVIRONMENT_BINDINGS_PROJECTION_SCHEMA;
  environment: string;
  bindings: EnvironmentBindingEntry[];
  omitted: { resources: number };
  limits: typeof ENVIRONMENT_BINDINGS_LIMITS;
}

export interface EnvironmentBindingsResult {
  projection: EnvironmentBindingsProjection;
  diagnostics: EnvironmentBindingDiagnostic[];
}

const environmentName = Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9-]{0,31}$" });
const resourceName = Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const reference = Type.String({ minLength: 1, maxLength: 128 });
const documentSchema = Type.Object({
  schema: Type.Literal(ENVIRONMENT_BINDINGS_SCHEMA),
  environments: Type.Record(
    environmentName,
    Type.Object({ bindings: Type.Record(resourceName, reference) }, { additionalProperties: false }),
  ),
}, { additionalProperties: false });
const referencePattern = new RegExp(ENVIRONMENT_BINDING_REFERENCE_PATTERN);

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort((a, b) => a.localeCompare(b));
}

/** Parse and structurally validate the binding document. Reference grammar is checked during resolution. */
export function parseEnvironmentBindings(value: unknown): EnvironmentBindingsDocument {
  if (!Value.Check(documentSchema, value)) throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_INVALID");
  const document = value as EnvironmentBindingsDocument;
  if (Object.keys(document.environments).length > ENVIRONMENT_BINDINGS_LIMITS.environments) {
    throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_TOO_LARGE");
  }
  for (const [name, environment] of Object.entries(document.environments)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_INVALID");
    if (Object.keys(environment.bindings).length > ENVIRONMENT_BINDINGS_LIMITS.bindings) {
      throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_TOO_LARGE");
    }
    for (const resource of Object.keys(environment.bindings)) {
      if (resource.length === 0 || resource.length > 512 || /[\u0000-\u001f\u007f]/.test(resource)) {
        throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_INVALID");
      }
    }
  }
  return document;
}

export function formatEnvironmentBindings(
  result: EnvironmentBindingsResult,
): string {
  const { projection, diagnostics } = result;
  const lines = [
    `ENVIRONMENT ${projection.environment}`,
    ...projection.bindings.map((entry) => `  ${entry.resource} (${entry.kind}) -> ${entry.binding}`),
    ...(projection.omitted.resources > 0 ? [`  omitted: ${projection.omitted.resources} binding(s)`] : []),
    ...(diagnostics.length === 0
      ? []
      : ["", ...diagnostics.map((diagnostic) => `  [${diagnostic.code}] ${diagnostic.message}`)]),
  ];
  return lines.join("\n");
}

/**
 * Resolve the static binding projection for one environment against the declared
 * resources in the graph. Missing, unknown or credential-shaped references are
 * reported as diagnostics instead of silently passing.
 */
export function resolveEnvironmentBindings(
  graph: ApplicationGraph,
  document: EnvironmentBindingsDocument,
  environment: string,
): EnvironmentBindingsResult {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(environment)) {
    throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_INVALID");
  }
  const selected = document.environments[environment];
  if (!selected) throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_UNKNOWN_ENVIRONMENT");

  const resources = [...(graph.resources ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const declared = new Set(resources.map((resource) => resource.name));
  const diagnostics: EnvironmentBindingDiagnostic[] = [];
  const bindings: EnvironmentBindingEntry[] = [];

  for (const resource of resources) {
    const binding = selected.bindings[resource.name];
    if (binding === undefined) {
      diagnostics.push({
        code: "missing-environment-binding", severity: "error", environment, resource: resource.name,
        message: `Resource '${resource.name}' has no binding in environment '${environment}'`,
      });
      continue;
    }
    if (!referencePattern.test(binding)) {
      diagnostics.push({
        code: "invalid-environment-binding", severity: "error", environment, resource: resource.name,
        message: `Binding for '${resource.name}' in environment '${environment}' must be 'local' or a 'scheme:name' reference, not a URL or credential`,
      });
      continue;
    }
    bindings.push({ resource: resource.name, kind: resource.kind, binding });
  }

  for (const name of sortedKeys(selected.bindings)) {
    if (!declared.has(name)) {
      diagnostics.push({
        code: "unknown-environment-binding", severity: "error", environment, resource: name,
        message: `Environment '${environment}' binds '${name}', which is not a declared @InfraResource`,
      });
    }
  }

  const projected = bindings.slice(0, ENVIRONMENT_BINDINGS_LIMITS.resources);
  return {
    projection: {
      schema: ENVIRONMENT_BINDINGS_PROJECTION_SCHEMA,
      environment,
      bindings: projected,
      omitted: { resources: bindings.length - projected.length },
      limits: ENVIRONMENT_BINDINGS_LIMITS,
    },
    diagnostics,
  };
}

/**
 * Local runtime consumption of a binding projection. This is the only place a
 * binding stops being purely static, and even here no credential is resolved:
 * the runner owns credentials. Only the explicit `fast` and `integration` local
 * profiles are allowed, and a production-shaped environment name is refused
 * outright so a local entry can never point at production by accident.
 */
export const RUNTIME_BINDINGS_SCHEMA = "supacloud.runtime-bindings.v1";
export type RuntimeBindingProfile = "fast" | "integration";
export type RuntimeBindingMode = "ephemeral" | "external";

const PRODUCTION_ENVIRONMENT = /^(?:prod|production|live|release)(?:[-_]|$)/i;

export interface RuntimeBindingEntry extends EnvironmentBindingEntry {
  mode: RuntimeBindingMode;
}

export interface RuntimeBindingsProjection {
  schema: typeof RUNTIME_BINDINGS_SCHEMA;
  profile: RuntimeBindingProfile;
  environment: string;
  credentials: "resolved-by-local-runner";
  bindings: RuntimeBindingEntry[];
  omitted: { resources: number };
  limits: typeof ENVIRONMENT_BINDINGS_LIMITS;
}

export interface RuntimeBindingsResult {
  projection: RuntimeBindingsProjection;
  diagnostics: EnvironmentBindingDiagnostic[];
}

export function formatRuntimeBindings(result: RuntimeBindingsResult): string {
  const { projection, diagnostics } = result;
  return [
    `RUNTIME ${projection.profile} / ${projection.environment} (credentials: ${projection.credentials})`,
    ...projection.bindings.map((entry) => `  ${entry.resource} (${entry.kind}) -> ${entry.binding} [${entry.mode}]`),
    ...(diagnostics.length === 0
      ? []
      : ["", ...diagnostics.map((diagnostic) => `  [${diagnostic.code}] ${diagnostic.message}`)]),
  ].join("\n");
}

/**
 * Classify a static projection for a local profile. `fast` requires every
 * resource to be `local` (fully ephemeral); `integration` accepts namespaced
 * references and never embeds credentials.
 */
export function resolveRuntimeBindings(
  graph: ApplicationGraph,
  document: EnvironmentBindingsDocument,
  environment: string,
  profile: RuntimeBindingProfile,
): RuntimeBindingsResult {
  if (profile !== "fast" && profile !== "integration") {
    throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_INVALID");
  }
  if (PRODUCTION_ENVIRONMENT.test(environment)) {
    throw new EnvironmentBindingError("ENVIRONMENT_BINDINGS_PRODUCTION_FORBIDDEN");
  }
  const staticResult = resolveEnvironmentBindings(graph, document, environment);
  const diagnostics = [...staticResult.diagnostics];
  const bindings: RuntimeBindingEntry[] = [];
  for (const entry of staticResult.projection.bindings) {
    const local = entry.binding === "local";
    if (profile === "fast" && !local) {
      diagnostics.push({
        code: "invalid-environment-binding", severity: "error", environment, resource: entry.resource,
        message: `Profile 'fast' requires '${entry.resource}' to bind to 'local', received '${entry.binding}'`,
      });
      continue;
    }
    bindings.push({ ...entry, mode: local ? "ephemeral" : "external" });
  }
  return {
    projection: {
      schema: RUNTIME_BINDINGS_SCHEMA,
      profile,
      environment,
      credentials: "resolved-by-local-runner",
      bindings,
      omitted: staticResult.projection.omitted,
      limits: ENVIRONMENT_BINDINGS_LIMITS,
    },
    diagnostics,
  };
}