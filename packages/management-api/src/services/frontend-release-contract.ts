import { createHash } from "node:crypto";
import type { FrontendDeployment } from "../types/frontend";
import type { MutationPrincipal } from "./project-mutation.service";

export const FRONTEND_BASE_DIR = "/var/supacloud/frontends";
export const FRONTEND_RELEASE_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
export const FRONTEND_RELEASE_MAX_FILES = 10_000;
export const FRONTEND_RELEASE_MAX_UNCOMPRESSED_BYTES = 300 * 1024 * 1024;
export const FRONTEND_RELEASE_LIST_DEFAULT_LIMIT = 50;
export const FRONTEND_RELEASE_LIST_MAX_LIMIT = 100;
export const FRONTEND_RELEASE_SCHEMA = "supacloud.frontend-release.v1" as const;
export const FRONTEND_ACTIVE_RELEASE_SCHEMA = "supacloud.frontend-active-release.v1" as const;
export const FRONTEND_ACTIVATION_CHECKPOINT_SCHEMA = "supacloud.frontend-release-activation.v1" as const;
export const FRONTEND_GATEWAY_DURABILITY_UNKNOWN_CODE = "CADDY_GATEWAY_DURABILITY_UNKNOWN" as const;
export const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
export const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const RELEASE_ID_PATTERN = /^[0-9a-f]{64}$/;
export const MUTATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type ExpectedActiveReleaseId = "absent" | string;
export type ExpectedFrontendActivationId = "absent" | string;
export type ActivationPhase = "prepared" | "authority_applied" | "route_applied";

export interface FrontendReleaseRecord {
  schema: typeof FRONTEND_RELEASE_SCHEMA;
  project_ref: string;
  deployment_id: string;
  release_id: string;
  sha256: string;
  tree_sha256: string;
  size_bytes: number;
  file_count: number;
  created_at: string;
  kind: "prebuilt_static";
}

export interface FrontendActiveReleaseRecord {
  schema: typeof FRONTEND_ACTIVE_RELEASE_SCHEMA;
  project_ref: string;
  deployment_id: string;
  release_id: string;
  sha256: string;
  tree_sha256: string;
  activation_id: string;
  activated_at: string;
  mutation_id: string;
}

export interface FrontendActivationCheckpoint {
  schema: typeof FRONTEND_ACTIVATION_CHECKPOINT_SCHEMA;
  phase: ActivationPhase;
  deployment_id: string;
  release_id: string;
  expected_active_release_id: ExpectedActiveReleaseId;
  activation_id: string;
  expected_activation_id: ExpectedFrontendActivationId;
  activated_at: string;
  previous_authority: FrontendActiveReleaseRecord | null;
  previous_route: "absent" | "legacy" | "release";
}

export interface FrontendReleaseInventory {
  project_ref: string;
  deployment_id: string;
  active_release_id: string | null;
  active_activation_id: string | null;
  releases: FrontendReleaseRecord[];
  next_cursor: string | null;
}

export interface FrontendReleaseListPage {
  cursor?: string;
  limit: number;
}

export interface VerifiedStagedFrontendArchive {
  readonly size_bytes: number;
  readonly sha256: string;
}

export interface FrontendReleaseUploadSession {
  write(chunk: Uint8Array): Promise<void>;
  finish(expectedSha256: string): Promise<VerifiedStagedFrontendArchive>;
  abort(): Promise<void>;
}

export interface ActivateFrontendReleaseInput {
  projectRef: string;
  deploymentId: string;
  releaseId: string;
  expectedActiveReleaseId: ExpectedActiveReleaseId;
  expectedActivationId: ExpectedFrontendActivationId;
  mutationId: string;
  principal: MutationPrincipal;
}

export interface FrontendReleaseActivation {
  project_ref: string;
  deployment_id: string;
  active_release_id: string;
  activation_id: string;
  release: FrontendReleaseRecord;
  mutation: {
    mutation_id: string;
    status: "succeeded";
    replayed: boolean;
  };
}

export interface FrontendReleaseGateway {
  configureFrontendRoute(route: {
    projectRef: string;
    deploymentId: string;
    hosts: string[];
    root: string;
    mode: "static";
  }): Promise<void>;
  removeFrontendRoute(projectRef: string, deploymentId: string): Promise<void>;
  readFrontendStaticRoot(projectRef: string, deploymentId: string): Promise<string | null>;
}

export interface FrontendReleaseStoragePort {
  assertMutationSupported(projectRef: string, deploymentId: string): Promise<void>;
  deployment(projectRef: string, deploymentId: string): Promise<FrontendDeployment>;
  prepareReleaseUpload(
    projectRef: string,
    deploymentId: string,
    expectedLength: number,
  ): Promise<FrontendReleaseUploadSession>;
  createRelease(
    projectRef: string,
    deploymentId: string,
    archive: VerifiedStagedFrontendArchive,
  ): Promise<FrontendReleaseRecord>;
  listReleases(
    projectRef: string,
    deploymentId: string,
    page: FrontendReleaseListPage,
  ): Promise<FrontendReleaseInventory>;
  releaseRecord(projectRef: string, deploymentId: string, releaseId: string): Promise<FrontendReleaseRecord>;
  activeRelease(projectRef: string, deploymentId: string): Promise<FrontendActiveReleaseRecord | null>;
  writeActiveRelease(
    projectRef: string,
    deploymentId: string,
    record: FrontendActiveReleaseRecord | null,
  ): Promise<void>;
  compareAndSwapActiveRelease(
    projectRef: string,
    deploymentId: string,
    expectedReleaseId: ExpectedActiveReleaseId,
    expectedActivationId: ExpectedFrontendActivationId,
    record: FrontendActiveReleaseRecord | null,
  ): Promise<"updated" | "conflict">;
  activeBuildDir(projectRef: string, deploymentId: string): Promise<string | null>;
  hasActiveRelease(projectRef: string, deploymentId: string): Promise<boolean>;
  releaseBuildDir(projectRef: string, deploymentId: string, releaseId: string): string;
  legacyBuildDir(projectRef: string, deploymentId: string): string;
}

export class FrontendReleaseError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "FrontendReleaseError";
  }
}

export function frontendReleaseError(
  code: string,
  statusCode: number,
  message: string,
): FrontendReleaseError {
  return new FrontendReleaseError(code, statusCode, message);
}

export function isFrontendGatewayDurabilityUnknown(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as Error & { code?: unknown }).code === FRONTEND_GATEWAY_DURABILITY_UNKNOWN_CODE;
}

export function frontendReleaseMutationPlatformSupported(): boolean {
  return process.platform === "linux" && typeof process.geteuid === "function";
}

export function nodeErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalTimestamp(candidate: unknown): candidate is string {
  if (typeof candidate !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(candidate)) return false;
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === candidate;
}

function exactRecord(candidate: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) ? record : null;
}

export function assertFrontendIdentity(projectRef: string, deploymentId: string): void {
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw frontendReleaseError("FRONTEND_RELEASE_PROJECT_INVALID", 400, "Project ref is invalid");
  }
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    throw frontendReleaseError("FRONTEND_RELEASE_DEPLOYMENT_INVALID", 400, "Frontend deployment id is invalid");
  }
}

export function assertReleaseId(releaseId: string): void {
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_ID_INVALID",
      400,
      "Frontend release id must be a SHA-256 digest",
    );
  }
}

export function assertExpectedActiveReleaseId(candidate: string): void {
  if (candidate !== "absent" && !RELEASE_ID_PATTERN.test(candidate)) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_EXPECTED_ACTIVE_INVALID",
      400,
      "expected_active_release_id must be 'absent' or a SHA-256 release id",
    );
  }
}

export function assertExpectedFrontendActivationId(candidate: string): void {
  if (candidate !== "absent" && !MUTATION_ID_PATTERN.test(candidate)) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_EXPECTED_ACTIVATION_INVALID",
      400,
      "expected_activation_id must be 'absent' or a UUIDv4",
    );
  }
}

export function parseReleaseRecord(candidate: unknown): FrontendReleaseRecord {
  const keys = [
    "schema", "project_ref", "deployment_id", "release_id", "sha256", "tree_sha256",
    "size_bytes", "file_count", "created_at", "kind",
  ] as const;
  const record = exactRecord(candidate, keys);
  if (!record || record.schema !== FRONTEND_RELEASE_SCHEMA || record.kind !== "prebuilt_static"
    || typeof record.project_ref !== "string" || typeof record.deployment_id !== "string"
    || typeof record.release_id !== "string" || !RELEASE_ID_PATTERN.test(record.release_id)
    || record.sha256 !== record.release_id || typeof record.tree_sha256 !== "string"
    || !RELEASE_ID_PATTERN.test(record.tree_sha256)
    || !Number.isSafeInteger(record.size_bytes) || Number(record.size_bytes) < 1
    || !Number.isSafeInteger(record.file_count) || Number(record.file_count) < 1
    || !canonicalTimestamp(record.created_at)) {
    throw frontendReleaseError("FRONTEND_RELEASE_STORAGE_INVALID", 500, "Frontend release metadata is invalid");
  }
  return record as unknown as FrontendReleaseRecord;
}

export function parseActiveRelease(candidate: unknown): FrontendActiveReleaseRecord {
  const keys = [
    "schema", "project_ref", "deployment_id", "release_id", "sha256", "tree_sha256",
    "activation_id", "activated_at", "mutation_id",
  ] as const;
  const record = exactRecord(candidate, keys);
  if (!record || record.schema !== FRONTEND_ACTIVE_RELEASE_SCHEMA
    || typeof record.project_ref !== "string" || typeof record.deployment_id !== "string"
    || typeof record.release_id !== "string" || !RELEASE_ID_PATTERN.test(record.release_id)
    || record.sha256 !== record.release_id || typeof record.tree_sha256 !== "string"
    || !RELEASE_ID_PATTERN.test(record.tree_sha256) || !canonicalTimestamp(record.activated_at)
    || typeof record.activation_id !== "string" || !MUTATION_ID_PATTERN.test(record.activation_id)
    || typeof record.mutation_id !== "string" || !MUTATION_ID_PATTERN.test(record.mutation_id)
    || record.activation_id !== record.mutation_id) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_AUTHORITY_INVALID",
      500,
      "Frontend active release authority is invalid",
    );
  }
  return record as unknown as FrontendActiveReleaseRecord;
}

export function parseActivationCheckpoint(candidate: unknown): FrontendActivationCheckpoint | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (Object.keys(candidate as Record<string, unknown>).length === 0) return null;
  const keys = [
    "schema", "phase", "deployment_id", "release_id", "expected_active_release_id",
    "activation_id", "expected_activation_id", "activated_at", "previous_authority",
    "previous_route",
  ] as const;
  const record = exactRecord(candidate, keys);
  if (!record || record.schema !== FRONTEND_ACTIVATION_CHECKPOINT_SCHEMA
    || !["prepared", "authority_applied", "route_applied"].includes(String(record.phase))
    || typeof record.deployment_id !== "string" || !DEPLOYMENT_ID_PATTERN.test(record.deployment_id)
    || typeof record.release_id !== "string" || !RELEASE_ID_PATTERN.test(record.release_id)
    || typeof record.expected_active_release_id !== "string"
    || (record.expected_active_release_id !== "absent"
      && !RELEASE_ID_PATTERN.test(record.expected_active_release_id))
    || typeof record.activation_id !== "string" || !MUTATION_ID_PATTERN.test(record.activation_id)
    || typeof record.expected_activation_id !== "string"
    || (record.expected_activation_id !== "absent"
      && !MUTATION_ID_PATTERN.test(record.expected_activation_id))
    || !canonicalTimestamp(record.activated_at)
    || !["absent", "legacy", "release"].includes(String(record.previous_route))) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_CHECKPOINT_INVALID",
      503,
      "Frontend release activation checkpoint is invalid",
    );
  }
  if (record.previous_authority !== null) {
    let previous: FrontendActiveReleaseRecord;
    try {
      previous = parseActiveRelease(record.previous_authority);
    } catch {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_CHECKPOINT_INVALID",
        503,
        "Frontend release activation checkpoint is invalid",
      );
    }
    if (record.previous_route !== "release"
      || previous.deployment_id !== record.deployment_id
      || previous.release_id !== record.expected_active_release_id
      || previous.activation_id !== record.expected_activation_id) {
      throw frontendReleaseError(
        "FRONTEND_RELEASE_CHECKPOINT_INVALID",
        503,
        "Frontend release activation checkpoint is invalid",
      );
    }
  } else if (record.previous_route === "release"
    || record.expected_active_release_id !== "absent"
    || record.expected_activation_id !== "absent") {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_CHECKPOINT_INVALID",
      503,
      "Frontend release activation checkpoint is invalid",
    );
  }
  return record as unknown as FrontendActivationCheckpoint;
}

export function assertActivationCheckpointIdentity(
  checkpoint: FrontendActivationCheckpoint,
  identity: { projectRef: string; mutationId: string },
): void {
  if (checkpoint.activation_id !== identity.mutationId
    || (checkpoint.previous_authority !== null
      && checkpoint.previous_authority.project_ref !== identity.projectRef)) {
    throw frontendReleaseError(
      "FRONTEND_RELEASE_CHECKPOINT_INVALID",
      503,
      "Frontend release activation checkpoint identity is invalid",
    );
  }
}
