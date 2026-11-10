import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const closed = { additionalProperties: false } as const;
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const releaseId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" });
const mutationId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" });
const isoDate = Type.String({ minLength: 20, maxLength: 40 });

export const PLATFORM_DEPLOYMENT_STATE_SCHEMA = "supacloud.platform-deployment-state.v1";

/** The edge runtime may be external; the host profile requires these components. */
export const SINGLE_NODE_REQUIRED_COMPONENTS = [
  "management-api", "web-console", "caddy", "postgres", "postgrest", "gotrue", "realtime", "storage", "victoria-logs",
] as const;

const componentName = Type.Union([
  Type.Literal("management-api"),
  Type.Literal("web-console"),
  Type.Literal("caddy"),
  Type.Literal("postgres"),
  Type.Literal("postgrest"),
  Type.Literal("gotrue"),
  Type.Literal("realtime"),
  Type.Literal("storage"),
  Type.Literal("victoria-logs"),
  Type.Literal("edge-runtime"),
]);

const componentStatus = Type.Union([
  Type.Literal("ready"),
  Type.Literal("stopped"),
  Type.Literal("starting"),
  Type.Literal("unhealthy"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
]);

const desiredStatus = Type.Union([Type.Literal("running"), Type.Literal("stopped")]);
const actualStatus = Type.Union([
  Type.Literal("absent"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("stopped"),
  Type.Literal("degraded"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
]);
const operationPhase = Type.Union([
  Type.Literal("idle"),
  Type.Literal("preparing"),
  Type.Literal("activating"),
  Type.Literal("verifying"),
  Type.Literal("confirmed"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
  Type.Literal("rolled-back"),
]);
const retryAction = Type.Union([
  Type.Literal("none"),
  Type.Literal("reconcile-same-mutation"),
  Type.Literal("manual-recovery"),
  Type.Literal("new-mutation"),
]);

export const PlatformDeploymentComponentSchema = Type.Object({
  name: componentName,
  version: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  status: componentStatus,
  health_check: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  checked_at: Type.Union([isoDate, Type.Null()]),
}, closed);

export const PlatformDeploymentStateSchema = Type.Object({
  schema: Type.Literal(PLATFORM_DEPLOYMENT_STATE_SCHEMA),
  profile: Type.Literal("single-node"),
  host: Type.Object({
    os: Type.Literal("linux"),
    distribution: Type.Literal("ubuntu"),
    version: Type.Literal("24.04"),
    architecture: Type.Literal("amd64"),
    init: Type.Literal("systemd"),
  }, closed),
  desired: Type.Object({
    state: desiredStatus,
    release_id: Type.Union([releaseId, Type.Null()]),
    manifest_sha256: Type.Union([sha256, Type.Null()]),
  }, closed),
  actual: Type.Object({
    state: actualStatus,
    release_id: Type.Union([releaseId, Type.Null()]),
    manifest_sha256: Type.Union([sha256, Type.Null()]),
    checked_at: Type.Union([isoDate, Type.Null()]),
    components: Type.Array(PlatformDeploymentComponentSchema, { minItems: 1, maxItems: 16 }),
  }, closed),
  operation: Type.Object({
    mutation_id: Type.Union([mutationId, Type.Null()]),
    phase: operationPhase,
    retry: retryAction,
    error: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  }, closed),
  rollback: Type.Object({
    release_id: Type.Union([releaseId, Type.Null()]),
    ready: Type.Boolean(),
  }, closed),
}, closed);

export type PlatformDeploymentComponent = Static<typeof PlatformDeploymentComponentSchema>;
export type PlatformDeploymentState = Static<typeof PlatformDeploymentStateSchema>;
export type PlatformDeploymentOperationPhase = PlatformDeploymentState["operation"]["phase"];
export type PlatformDeploymentStatus = "confirmed" | "incomplete" | "failed" | "unknown";

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function assertReleaseBinding(value: {
  state: string;
  release_id: string | null;
  manifest_sha256: string | null;
}, label: string): void {
  if (value.state === "running" && (value.release_id === null || value.manifest_sha256 === null)) {
    throw new Error(`Invalid platform deployment ${label} release binding.`);
  }
}

function hasRequiredComponents(value: PlatformDeploymentState): boolean {
  const names = new Set(value.actual.components.map(component => component.name));
  return SINGLE_NODE_REQUIRED_COMPONENTS.every(name => names.has(name));
}

function deriveActualStatus(value: PlatformDeploymentState): PlatformDeploymentStatus {
  if (value.actual.state === "failed" || value.actual.components.some(component => component.status === "failed")) {
    return "failed";
  }
  if (value.actual.state === "unknown" || value.actual.components.some(component => component.status === "unknown")) {
    return "unknown";
  }
  if (!hasRequiredComponents(value)) return "incomplete";
  if (value.desired.state === "stopped" && value.actual.state === "stopped"
    && value.actual.checked_at !== null
    && value.actual.components.every(component => component.status === "stopped")) return "confirmed";
  if (value.desired.state === "running" && value.actual.state === "running"
    && value.actual.checked_at !== null
    && value.actual.release_id === value.desired.release_id
    && value.actual.manifest_sha256 === value.desired.manifest_sha256
    && value.actual.components.every(component => component.status === "ready"
      && component.health_check !== null && component.checked_at !== null)) {
    return "confirmed";
  }
  return "incomplete";
}

/**
 * Derive the platform state from the observed snapshot. Unknown observations
 * never become successful, and an actual release must match the desired one.
 */
export function derivePlatformDeploymentStatus(value: PlatformDeploymentState): PlatformDeploymentStatus {
  return deriveActualStatus(value);
}

/**
 * An interrupted or lost response can only be recovered by reading back the
 * same mutation identity. This helper is intentionally separate from parsing
 * so controllers can apply it before issuing another mutation.
 */
export function platformDeploymentRetryAction(phase: PlatformDeploymentOperationPhase): PlatformDeploymentState["operation"]["retry"] {
  switch (phase) {
    case "preparing":
    case "activating":
    case "verifying":
    case "unknown":
      return "reconcile-same-mutation";
    case "failed":
      return "manual-recovery";
    case "rolled-back":
      return "new-mutation";
    case "idle":
    case "confirmed":
      return "none";
  }
}

export function assertPlatformDeploymentTransition(
  from: PlatformDeploymentOperationPhase,
  to: PlatformDeploymentOperationPhase,
): void {
  const allowed: Record<PlatformDeploymentOperationPhase, readonly PlatformDeploymentOperationPhase[]> = {
    idle: ["preparing"],
    preparing: ["activating", "failed", "unknown"],
    activating: ["verifying", "failed", "unknown"],
    verifying: ["confirmed", "failed", "unknown"],
    confirmed: ["preparing"],
    failed: ["preparing", "unknown"],
    unknown: ["verifying", "confirmed", "failed", "rolled-back"],
    "rolled-back": ["preparing"],
  };
  if (!allowed[from].includes(to)) throw new Error(`Invalid platform deployment transition: ${from} -> ${to}`);
}

export function parsePlatformDeploymentState(value: unknown): PlatformDeploymentState {
  if (!Value.Check(PlatformDeploymentStateSchema, value)
    || !isIsoDate(value.actual.checked_at ?? new Date(0).toISOString())
    || value.actual.checked_at === null
    || value.actual.components.some(component => component.checked_at !== null && !isIsoDate(component.checked_at))
    || new Set(value.actual.components.map(component => component.name)).size !== value.actual.components.length
    || !hasRequiredComponents(value)
    || (value.desired.state === "running"
      && (value.desired.release_id === null || value.desired.manifest_sha256 === null))
    || (value.actual.state === "running"
      && (value.actual.release_id === null || value.actual.manifest_sha256 === null))
    || (value.operation.phase !== "idle" && value.operation.mutation_id === null)
    || (value.operation.phase === "failed" && value.operation.error === null)
    || value.operation.retry !== platformDeploymentRetryAction(value.operation.phase)
    || (derivePlatformDeploymentStatus(value) === "confirmed" && value.operation.phase !== "confirmed")
    || (derivePlatformDeploymentStatus(value) !== "confirmed" && value.operation.phase === "confirmed")) {
    throw new Error("Invalid platform deployment state.");
  }
  assertReleaseBinding(value.desired, "desired");
  if (value.actual.state === "running") assertReleaseBinding(value.actual, "actual");
  return structuredClone(value);
}
