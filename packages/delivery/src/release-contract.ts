import { createHash } from "node:crypto";

export const RELEASE_CONTRACT_SCHEMA = "supacloud.release-control.v2";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const ENVIRONMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FUNCTION_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/;

export type ReleaseComponent =
  | { kind: "migration"; name: string }
  | { kind: "function"; slug: string; artifactSha256: string }
  | { kind: "web"; artifactSha256: string };

export interface ReleaseScope {
  schema: typeof RELEASE_CONTRACT_SCHEMA;
  releaseId: string;
  sourceCommit: string;
  targetProjectRef: string;
  targetEnvironmentId: string;
  components: ReleaseComponent[];
}

export type ReleaseReceiptPhase =
  | "planned"
  | "mutating"
  | "applied"
  | "reconciled"
  | "rollback-required"
  | "rolled-back";

export interface ReleaseReceipt {
  schema: typeof RELEASE_CONTRACT_SCHEMA;
  releaseId: string;
  scopeSha256: string;
  phase: ReleaseReceiptPhase;
  beforeReadBack: Record<string, unknown> | null;
  afterReadBack: Record<string, unknown> | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function nonEmptyString(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseComponent(value: unknown, index: number): ReleaseComponent {
  const candidate = record(value, `Release component ${index}`);
  if (candidate.kind === "migration") {
    exactKeys(candidate, ["kind", "name"], `Release migration ${index}`);
    return { kind: "migration", name: nonEmptyString(candidate.name, `Release migration ${index}`, MIGRATION_NAME) };
  }
  if (candidate.kind === "function") {
    exactKeys(candidate, ["artifactSha256", "kind", "slug"], `Release Function ${index}`);
    return {
      kind: "function",
      slug: nonEmptyString(candidate.slug, `Release Function ${index}`, FUNCTION_SLUG),
      artifactSha256: nonEmptyString(candidate.artifactSha256, `Release Function ${index}`, SHA256),
    };
  }
  if (candidate.kind === "web") {
    exactKeys(candidate, ["artifactSha256", "kind"], `Release Web ${index}`);
    return {
      kind: "web",
      artifactSha256: nonEmptyString(candidate.artifactSha256, `Release Web ${index}`, SHA256),
    };
  }
  throw new Error(`Release component ${index} kind is invalid`);
}

function componentKey(component: ReleaseComponent): string {
  return component.kind === "migration"
    ? `${component.kind}:${component.name}`
    : component.kind === "function" ? `${component.kind}:${component.slug}` : component.kind;
}

export function parseReleaseScope(value: unknown): ReleaseScope {
  const candidate = record(value, "Release scope");
  exactKeys(candidate, [
    "components", "releaseId", "schema", "sourceCommit", "targetEnvironmentId", "targetProjectRef",
  ], "Release scope");
  if (candidate.schema !== RELEASE_CONTRACT_SCHEMA) {
    throw new Error("Release scope schema is invalid");
  }
  if (!Array.isArray(candidate.components) || candidate.components.length === 0) {
    throw new Error("Release scope components must be non-empty");
  }
  const components = candidate.components.map(parseComponent);
  const componentKeys = components.map(componentKey);
  if (new Set(componentKeys).size !== componentKeys.length
    || componentKeys.some((key, index) => key !== [...componentKeys].sort()[index])) {
    throw new Error("Release scope components must be unique and sorted");
  }
  return {
    schema: RELEASE_CONTRACT_SCHEMA,
    releaseId: nonEmptyString(candidate.releaseId, "Release scope releaseId"),
    sourceCommit: nonEmptyString(candidate.sourceCommit, "Release scope sourceCommit", COMMIT),
    targetEnvironmentId: nonEmptyString(candidate.targetEnvironmentId, "Release scope targetEnvironmentId", ENVIRONMENT_ID),
    targetProjectRef: nonEmptyString(candidate.targetProjectRef, "Release scope targetProjectRef", PROJECT_REF),
    components,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

export function releaseScopeSha256(scope: ReleaseScope): string {
  return createHash("sha256").update(JSON.stringify(canonical(scope))).digest("hex");
}

const VALID_PHASES: readonly ReleaseReceiptPhase[] = [
  "planned",
  "mutating",
  "applied",
  "reconciled",
  "rollback-required",
  "rolled-back",
];

export function parseReleaseReceipt(value: unknown): ReleaseReceipt {
  const candidate = record(value, "Release receipt");
  exactKeys(candidate, ["afterReadBack", "beforeReadBack", "phase", "releaseId", "schema", "scopeSha256"], "Release receipt");
  if (candidate.schema !== RELEASE_CONTRACT_SCHEMA
    || typeof candidate.phase !== "string"
    || !VALID_PHASES.includes(candidate.phase as ReleaseReceiptPhase)) {
    throw new Error("Release receipt identity is invalid");
  }
  for (const key of ["beforeReadBack", "afterReadBack"] as const) {
    if (candidate[key] !== null) record(candidate[key], `Release receipt ${key}`);
  }
  if ((candidate.phase === "applied" || candidate.phase === "reconciled")
    && (candidate.beforeReadBack === null || candidate.afterReadBack === null)) {
    throw new Error(`Release receipt ${candidate.phase} requires before and after read-back`);
  }
  return {
    schema: RELEASE_CONTRACT_SCHEMA,
    releaseId: nonEmptyString(candidate.releaseId, "Release receipt releaseId"),
    scopeSha256: nonEmptyString(candidate.scopeSha256, "Release receipt scopeSha256", SHA256),
    phase: candidate.phase as ReleaseReceiptPhase,
    beforeReadBack: candidate.beforeReadBack as Record<string, unknown> | null,
    afterReadBack: candidate.afterReadBack as Record<string, unknown> | null,
  };
}

const ALLOWED_PHASE_TRANSITIONS: ReadonlyMap<ReleaseReceiptPhase, readonly ReleaseReceiptPhase[]> = new Map([
  ["planned", ["mutating", "rollback-required"]],
  ["mutating", ["applied", "rollback-required"]],
  ["applied", ["reconciled", "rollback-required"]],
  ["reconciled", []],
  ["rollback-required", ["rolled-back", "reconciled"]],
  ["rolled-back", []],
]);

export function assertReleaseReceiptTransition(
  from: ReleaseReceiptPhase,
  to: ReleaseReceiptPhase,
): void {
  if (!ALLOWED_PHASE_TRANSITIONS.get(from)?.includes(to)) {
    throw new Error(`Invalid release receipt transition: ${from} -> ${to}`);
  }
}
