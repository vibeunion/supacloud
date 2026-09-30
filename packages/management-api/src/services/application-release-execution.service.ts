import type { ApplicationReleaseRecord } from "@supacloud/delivery";
import { AppError } from "../utils/errors";
import { releaseRecoveryPaths } from "./application-release-evidence.service";

/**
 * Runtime release-execution evidence. This is deliberately separate from the
 * immutable `supacloud.release-evidence.v1` artifact document: the artifact
 * document describes what was built, this one records what actually happened
 * during activation. It is bound to the same `release_id` / `manifest_sha256` /
 * `target`, and a component without an observation stays `unknown` — never a
 * success.
 */
export const RELEASE_EXECUTION_SCHEMA = "supacloud.release-execution.v1";

export type ReleaseExecutionErrorCode =
  | "RELEASE_EXECUTION_TARGET_NOT_FOUND"
  | "RELEASE_EXECUTION_INVALID";

export class ReleaseExecutionError extends AppError {
  constructor(readonly executionCode: ReleaseExecutionErrorCode) {
    super(executionCode, executionCode === "RELEASE_EXECUTION_TARGET_NOT_FOUND" ? 404 : 422, executionCode);
    this.name = "ReleaseExecutionError";
  }
}

export type ReleaseExecutionComponent =
  | "application" | "migrations" | "configuration" | "resources" | "secrets" | "health";

export type ReleaseExecutionStatus = "succeeded" | "failed" | "unknown";

export interface ReleaseExecutionObservation {
  status: ReleaseExecutionStatus;
  /** Revision the result is bound to (release object id, migration version, config id). */
  version?: string;
  detail?: string;
  /** When the result was observed; required for a `succeeded`/`failed` result. */
  observedAt?: string;
}

export interface ReleaseExecutionComponentResult {
  name: ReleaseExecutionComponent;
  status: ReleaseExecutionStatus;
  required: boolean;
  version: string | null;
  detail: string | null;
  observedAt: string | null;
}

export interface ReleaseExecutionDocument {
  schema: typeof RELEASE_EXECUTION_SCHEMA;
  correlation: "release-execution-observation";
  target: string;
  release_id: string;
  manifestSha256: string;
  /** True only when every required component succeeded and nothing failed. */
  deploymentVerified: boolean;
  components: ReleaseExecutionComponentResult[];
  recovery: typeof releaseRecoveryPaths;
  notes: string[];
}

export interface ReleaseExecutionInput {
  record: ApplicationReleaseRecord;
  target: string;
  observations?: Partial<Record<ReleaseExecutionComponent, ReleaseExecutionObservation>>;
}

const COMPONENTS: ReadonlyArray<ReleaseExecutionComponent> = [
  "application", "migrations", "configuration", "resources", "secrets", "health",
];
const REQUIRED: ReadonlyArray<ReleaseExecutionComponent> = ["application", "migrations", "health"];
const STATUSES: ReadonlyArray<ReleaseExecutionStatus> = ["succeeded", "failed", "unknown"];

function invalid(): never {
  throw new ReleaseExecutionError("RELEASE_EXECUTION_INVALID");
}

function assertObserved(observation: ReleaseExecutionObservation): void {
  if (!STATUSES.includes(observation.status)) invalid();
  if (observation.status === "unknown" && (observation.version !== undefined || observation.detail !== undefined)) invalid();
  if (observation.status !== "unknown") {
    if (observation.observedAt === undefined || !Number.isFinite(Date.parse(observation.observedAt))) invalid();
  } else if (observation.observedAt !== undefined && !Number.isFinite(Date.parse(observation.observedAt))) {
    invalid();
  }
  if (observation.version !== undefined && (typeof observation.version !== "string" || observation.version.length === 0)) invalid();
  if (observation.detail !== undefined && (typeof observation.detail !== "string" || observation.detail.length > 512)) invalid();
}

export function createReleaseExecution(input: ReleaseExecutionInput): ReleaseExecutionDocument {
  if (!input.record.targets.some((target) => target.name === input.target)) {
    throw new ReleaseExecutionError("RELEASE_EXECUTION_TARGET_NOT_FOUND");
  }

  const components: ReleaseExecutionComponentResult[] = COMPONENTS.map((name) => {
    const observation = input.observations?.[name];
    if (!observation) {
      return { name, status: "unknown" as const, required: REQUIRED.includes(name), version: null, detail: null, observedAt: null };
    }
    assertObserved(observation);
    return {
      name,
      status: observation.status,
      required: REQUIRED.includes(name),
      version: observation.version ?? null,
      detail: observation.detail ?? null,
      observedAt: observation.observedAt ?? null,
    };
  });

  const deploymentVerified = components.every((component) => component.status !== "failed")
    && components.filter((component) => component.required).every((component) => component.status === "succeeded");

  return {
    schema: RELEASE_EXECUTION_SCHEMA,
    correlation: "release-execution-observation",
    target: input.target,
    release_id: input.record.release_id,
    manifestSha256: input.record.manifest_sha256,
    deploymentVerified,
    components,
    recovery: releaseRecoveryPaths,
    notes: [
      "Runtime observation only: a component without an observation stays `unknown` and is never counted as success.",
      "`deploymentVerified` requires the application, migrations and health results to succeed with no component failure.",
      "Migration execution and health results are bound to this release id and manifest digest; an update does not inherit them.",
    ],
  };
}