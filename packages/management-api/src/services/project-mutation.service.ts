import type { SQL } from "bun";
import { sql } from "../db";
import { stableSha256 } from "../utils/stable-json";

const MUTATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const OPERATION_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const RESOURCE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const LEASE_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/;
const PRINCIPAL_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,320}$/u;
const MAX_PUBLIC_PAYLOAD_BYTES = 65_536;
const MAX_JSON_DEPTH = 32;
const MAX_RECOVERY_OPERATIONS = 32;
const MAX_RECOVERY_CLAIMS = 100;
const SENSITIVE_PROJECTION_KEYS = new Set([
  "authorization", "cookie", "body", "headers", "password", "secret", "secrets",
  "token", "accesstoken", "refreshtoken", "idtoken", "apikey", "servicerolekey",
  "privatekey", "code", "sourcecode", "codebytes", "bundle", "requestbody", "requestheaders",
  "credential", "credentials", "credentialvalue",
]);

export function isProjectMutationId(candidate: unknown): candidate is string {
  return typeof candidate === "string" && MUTATION_ID_PATTERN.test(candidate);
}

export type ProjectMutationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed_retryable"
  | "failed_terminal"
  | "outcome_unknown";

export interface MutationPrincipal {
  type: "master" | "admin" | "project";
  id: string;
}

export interface ProjectMutationState {
  projectRef: string;
  mutationId: string;
  operation: string;
  resourceKey: string | null;
  requestFingerprint: string;
  principal: MutationPrincipal;
  status: ProjectMutationStatus;
  checkpoint: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
  responseStatus: number | null;
  failureCode: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fencingEpoch: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StoredProjectMutationRow {
  project_ref: string;
  mutation_id: string;
  operation: string;
  resource_key: string | null;
  request_fingerprint: string;
  principal_type: MutationPrincipal["type"];
  principal_id: string;
  status: ProjectMutationStatus;
  checkpoint: unknown;
  receipt: unknown;
  response_status: number | null;
  failure_code: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  fencing_epoch: number | string;
  recovery_not_before: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StoredMutationWithLeaseState extends StoredProjectMutationRow {
  lease_active: boolean;
}

export interface BeginProjectMutationInput {
  projectRef: string;
  mutationId: string;
  operation: string;
  resourceKey?: string;
  requestFingerprint: string;
  principal: MutationPrincipal;
}

export type BeginProjectMutationResult =
  | { kind: "started"; mutation: ProjectMutationState }
  | { kind: "replay"; mutation: ProjectMutationState }
  | { kind: "fingerprint_conflict" }
  | { kind: "principal_conflict" }
  | { kind: "resource_busy"; mutationId: string; status: ProjectMutationStatus };

export interface ClaimProjectMutationInput {
  projectRef: string;
  mutationId: string;
  leaseOwner: string;
  leaseToken: string;
  leaseSeconds: number;
}

export type ClaimProjectMutationResult =
  | { kind: "claimed"; mutation: ProjectMutationState }
  | { kind: "busy"; mutation: ProjectMutationState }
  | { kind: "terminal"; mutation: ProjectMutationState }
  | { kind: "not_found" };

export interface MutationLeaseInput {
  projectRef: string;
  mutationId: string;
  leaseToken: string;
  fencingEpoch: number;
}

export interface CheckpointProjectMutationInput extends MutationLeaseInput {
  checkpoint: Record<string, unknown>;
  leaseSeconds: number;
  recoveryNotBefore?: Date | string | null;
}

export interface CompleteProjectMutationSuccessInput extends MutationLeaseInput {
  receipt: Record<string, unknown>;
  responseStatus: number;
}

export interface CompleteProjectMutationFailureInput extends MutationLeaseInput {
  status: "failed_retryable" | "failed_terminal" | "outcome_unknown";
  failureCode: string;
  receipt?: Record<string, unknown>;
  responseStatus?: number;
  recoveryNotBefore?: Date | string | null;
}

export interface ClaimRecoverableProjectMutationsInput {
  operations: readonly string[];
  leaseOwner: string;
  leaseSeconds: number;
  limit: number;
}

export interface RecoverableProjectMutationClaim {
  projectRef: string;
  mutationId: string;
  operation: string;
  resourceKey: string | null;
  checkpoint: Record<string, unknown>;
  recoveryNotBefore: string;
  leaseToken: string;
  leaseExpiresAt: string;
  fencingEpoch: number;
}

interface StoredRecoverableMutationClaimRow {
  project_ref: string;
  mutation_id: string;
  operation: string;
  resource_key: string | null;
  checkpoint: unknown;
  recovery_not_before: Date | string;
  lease_token: string;
  lease_expires_at: Date | string;
  fencing_epoch: number | string;
}

function isPlainRecord(candidate: unknown): candidate is Record<string, unknown> {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const prototype = Object.getPrototypeOf(candidate);
  return prototype === Object.prototype || prototype === null;
}

function assertCanonicalJsonNode(candidate: unknown, seen: WeakSet<object>, depth: number): void {
  if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return;
  if (typeof candidate !== "object" || depth > MAX_JSON_DEPTH) {
    throw new Error("Mutation request must be bounded JSON");
  }
  if (seen.has(candidate)) throw new Error("Mutation request must not contain cycles");
  seen.add(candidate);
  const children = Array.isArray(candidate) ? candidate : isPlainRecord(candidate) ? Object.values(candidate) : null;
  if (!children) throw new Error("Mutation request must contain only JSON objects and arrays");
  for (const child of children) assertCanonicalJsonNode(child, seen, depth + 1);
  seen.delete(candidate);
}

function normalizedProjectionKey(key: string): string {
  return key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
}

function sensitiveProjectionKey(key: string): boolean {
  const normalized = normalizedProjectionKey(key);
  return SENSITIVE_PROJECTION_KEYS.has(normalized)
    || normalized.endsWith("password")
    || normalized.endsWith("secret")
    || normalized.endsWith("token")
    || normalized.endsWith("apikey");
}

function assertPublicProjectionKeys(candidate: unknown): void {
  if (Array.isArray(candidate)) {
    for (const entry of candidate) assertPublicProjectionKeys(entry);
    return;
  }
  if (!isPlainRecord(candidate)) return;
  for (const [key, field] of Object.entries(candidate)) {
    if (sensitiveProjectionKey(key)) throw new Error(`Mutation public projection cannot contain '${key}'`);
    assertPublicProjectionKeys(field);
  }
}

export function assertPublicMutationPayload(
  candidate: unknown,
): asserts candidate is Record<string, unknown> {
  if (!isPlainRecord(candidate)) throw new Error("Mutation public projection must be a JSON object");
  assertCanonicalJsonNode(candidate, new WeakSet(), 0);
  assertPublicProjectionKeys(candidate);
  if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_PUBLIC_PAYLOAD_BYTES) {
    throw new Error("Mutation public projection exceeds 64 KiB");
  }
}

export function projectMutationFingerprint(normalizedRequest: unknown): string {
  assertCanonicalJsonNode(normalizedRequest, new WeakSet(), 0);
  return stableSha256(normalizedRequest);
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function recoveryTimestamp(value: Date | string | null | undefined): Date | null | undefined {
  if (value === null || value === undefined) return value;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Mutation recovery timestamp is invalid");
  return parsed;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!isPlainRecord(parsed)) throw new Error("Stored mutation JSON projection is invalid");
  return parsed;
}

function publicJsonRecord(value: unknown): Record<string, unknown> {
  const record = jsonRecord(value);
  assertPublicMutationPayload(record);
  return record;
}

function projectMutationState(row: StoredProjectMutationRow): ProjectMutationState {
  return {
    projectRef: row.project_ref,
    mutationId: row.mutation_id,
    operation: row.operation,
    resourceKey: row.resource_key,
    requestFingerprint: row.request_fingerprint,
    principal: { type: row.principal_type, id: row.principal_id },
    status: row.status,
    checkpoint: publicJsonRecord(row.checkpoint),
    receipt: row.receipt === null ? null : publicJsonRecord(row.receipt),
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    failureCode: row.failure_code,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: timestamp(row.lease_expires_at),
    fencingEpoch: Number(row.fencing_epoch),
    completedAt: timestamp(row.completed_at),
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
  };
}

function assertMutationIdentity(projectRef: string, mutationId: string): void {
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(projectRef)) throw new Error("Project ref is invalid");
  if (!isProjectMutationId(mutationId)) throw new Error("mutation_id must be a UUIDv4");
}

function assertLeaseSeconds(leaseSeconds: number): void {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw new Error("Mutation lease duration must be 1-3600 seconds");
  }
}

function assertBeginInput(input: BeginProjectMutationInput): void {
  assertMutationIdentity(input.projectRef, input.mutationId);
  if (!OPERATION_PATTERN.test(input.operation)) throw new Error("Mutation operation is invalid");
  if (input.resourceKey !== undefined && !RESOURCE_KEY_PATTERN.test(input.resourceKey)) {
    throw new Error("Mutation resource key is invalid");
  }
  if (!FINGERPRINT_PATTERN.test(input.requestFingerprint)) throw new Error("Mutation fingerprint is invalid");
  if (!PRINCIPAL_ID_PATTERN.test(input.principal.id) || input.principal.id.trim() !== input.principal.id) {
    throw new Error("Mutation principal is invalid");
  }
}

async function lockedMutation(
  transaction: SQL,
  projectRef: string,
  mutationId: string,
): Promise<StoredProjectMutationRow | null> {
  const [row] = await transaction`
    SELECT * FROM project_mutations
    WHERE project_ref = ${projectRef} AND mutation_id = ${mutationId}
    FOR UPDATE
  ` as StoredProjectMutationRow[];
  return row ?? null;
}

async function activeResourceMutation(
  transaction: SQL,
  projectRef: string,
  resourceKey: string,
): Promise<StoredProjectMutationRow | null> {
  const [row] = await transaction`
    SELECT * FROM project_mutations
    WHERE project_ref = ${projectRef} AND resource_key = ${resourceKey}
      AND status IN ('pending', 'running', 'failed_retryable', 'outcome_unknown')
    FOR UPDATE
  ` as StoredProjectMutationRow[];
  return row ?? null;
}

function existingMutationResult(
  row: StoredProjectMutationRow,
  input: BeginProjectMutationInput,
): BeginProjectMutationResult {
  const resourceKey = input.resourceKey ?? null;
  if (row.request_fingerprint !== input.requestFingerprint
    || row.operation !== input.operation || row.resource_key !== resourceKey) {
    return { kind: "fingerprint_conflict" };
  }
  if (row.principal_id !== input.principal.id || row.principal_type !== input.principal.type) {
    return { kind: "principal_conflict" };
  }
  return { kind: "replay", mutation: projectMutationState(row) };
}

async function insertProjectMutation(
  transaction: SQL,
  input: BeginProjectMutationInput,
): Promise<StoredProjectMutationRow | null> {
  const [inserted] = await transaction`
    INSERT INTO project_mutations (
      project_ref, mutation_id, operation, resource_key, request_fingerprint,
      principal_type, principal_id
    ) VALUES (
      ${input.projectRef}, ${input.mutationId}, ${input.operation}, ${input.resourceKey ?? null},
      ${input.requestFingerprint}, ${input.principal.type}, ${input.principal.id}
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  ` as StoredProjectMutationRow[];
  return inserted ?? null;
}

export async function beginProjectMutation(
  transaction: SQL,
  input: BeginProjectMutationInput,
): Promise<BeginProjectMutationResult> {
  assertBeginInput(input);
  const inserted = await insertProjectMutation(transaction, input);
  if (inserted) return { kind: "started", mutation: projectMutationState(inserted) };

  const existing = await lockedMutation(transaction, input.projectRef, input.mutationId);
  if (existing) return existingMutationResult(existing, input);
  if (input.resourceKey) {
    const blocker = await activeResourceMutation(transaction, input.projectRef, input.resourceKey);
    if (blocker) return { kind: "resource_busy", mutationId: blocker.mutation_id, status: blocker.status };
  }
  throw new Error("Mutation insert conflicted without a durable conflicting record");
}

function assertClaimInput(input: ClaimProjectMutationInput): void {
  assertMutationIdentity(input.projectRef, input.mutationId);
  if (!LEASE_OWNER_PATTERN.test(input.leaseOwner)) throw new Error("Mutation lease owner is invalid");
  if (!isProjectMutationId(input.leaseToken)) throw new Error("Mutation lease token must be a UUIDv4");
  assertLeaseSeconds(input.leaseSeconds);
}

async function lockedMutationLeaseState(
  transaction: SQL,
  input: ClaimProjectMutationInput,
): Promise<StoredMutationWithLeaseState | null> {
  const [row] = await transaction`
    SELECT *, COALESCE(lease_expires_at > NOW(), false) AS lease_active
    FROM project_mutations
    WHERE project_ref = ${input.projectRef} AND mutation_id = ${input.mutationId}
    FOR UPDATE
  ` as StoredMutationWithLeaseState[];
  return row ?? null;
}

function unclaimedMutationResult(
  row: StoredMutationWithLeaseState,
  input: ClaimProjectMutationInput,
): ClaimProjectMutationResult {
  const mutation = projectMutationState(row);
  if (row.status === "running" && row.lease_active
    && row.lease_owner === input.leaseOwner && row.lease_token === input.leaseToken) {
    return { kind: "claimed", mutation };
  }
  if (row.status === "running") return { kind: "busy", mutation };
  if (["succeeded", "failed_terminal", "outcome_unknown"].includes(row.status)) {
    return { kind: "terminal", mutation };
  }
  throw new Error(`Mutation status '${row.status}' could not be claimed`);
}

export async function claimOrResumeProjectMutation(
  transaction: SQL,
  input: ClaimProjectMutationInput,
): Promise<ClaimProjectMutationResult> {
  assertClaimInput(input);
  const [claimed] = await transaction`
    UPDATE project_mutations
    SET status = 'running', lease_owner = ${input.leaseOwner}, lease_token = ${input.leaseToken},
        lease_expires_at = NOW() + (${input.leaseSeconds} * INTERVAL '1 second'),
        fencing_epoch = fencing_epoch + 1, completed_at = NULL, updated_at = NOW()
    WHERE project_ref = ${input.projectRef} AND mutation_id = ${input.mutationId}
      AND (status IN ('pending', 'failed_retryable')
        OR (status = 'running' AND lease_expires_at <= NOW()))
    RETURNING *
  ` as StoredProjectMutationRow[];
  if (claimed) return { kind: "claimed", mutation: projectMutationState(claimed) };
  const current = await lockedMutationLeaseState(transaction, input);
  return current ? unclaimedMutationResult(current, input) : { kind: "not_found" };
}

function assertRecoverableClaimInput(input: ClaimRecoverableProjectMutationsInput): void {
  if (input.operations.length < 1 || input.operations.length > MAX_RECOVERY_OPERATIONS
    || input.operations.some((operation) => !OPERATION_PATTERN.test(operation))) {
    throw new Error("Mutation recovery operations must contain 1-32 exact operation names");
  }
  if (!LEASE_OWNER_PATTERN.test(input.leaseOwner)) throw new Error("Mutation lease owner is invalid");
  assertLeaseSeconds(input.leaseSeconds);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_RECOVERY_CLAIMS) {
    throw new Error("Mutation recovery claim limit must be 1-100");
  }
}

function recoverableMutationClaim(row: StoredRecoverableMutationClaimRow): RecoverableProjectMutationClaim {
  assertMutationIdentity(row.project_ref, row.mutation_id);
  if (!OPERATION_PATTERN.test(row.operation)) throw new Error("Stored mutation operation is invalid");
  if (row.resource_key !== null && !RESOURCE_KEY_PATTERN.test(row.resource_key)) {
    throw new Error("Stored mutation resource key is invalid");
  }
  if (!isProjectMutationId(row.lease_token)) throw new Error("Stored mutation lease token is invalid");
  const fencingEpoch = Number(row.fencing_epoch);
  if (!Number.isSafeInteger(fencingEpoch) || fencingEpoch < 1) {
    throw new Error("Stored mutation fencing epoch is invalid");
  }
  const checkpoint = publicJsonRecord(row.checkpoint);
  return {
    projectRef: row.project_ref, mutationId: row.mutation_id, operation: row.operation,
    resourceKey: row.resource_key, checkpoint, recoveryNotBefore: timestamp(row.recovery_not_before)!,
    leaseToken: row.lease_token, leaseExpiresAt: timestamp(row.lease_expires_at)!, fencingEpoch,
  };
}

async function claimRecoverableRows(
  transaction: SQL,
  input: ClaimRecoverableProjectMutationsInput,
): Promise<StoredRecoverableMutationClaimRow[]> {
  const operations = transaction.array([...new Set(input.operations)], "TEXT");
  const rows = await transaction`
    WITH candidates AS (
      SELECT project_ref, mutation_id
      FROM project_mutations
      WHERE operation = ANY(${operations})
        AND recovery_not_before IS NOT NULL
        AND recovery_not_before <= NOW()
        AND (status IN ('pending', 'failed_retryable')
          OR (status = 'running' AND lease_expires_at <= NOW()))
      ORDER BY recovery_not_before ASC, updated_at ASC, project_ref ASC, mutation_id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${input.limit}
    )
    UPDATE project_mutations AS mutation
    SET status = 'running', lease_owner = ${input.leaseOwner}, lease_token = gen_random_uuid(),
        lease_expires_at = NOW() + (${input.leaseSeconds} * INTERVAL '1 second'),
        fencing_epoch = mutation.fencing_epoch + 1, completed_at = NULL, updated_at = NOW()
    FROM candidates
    WHERE mutation.project_ref = candidates.project_ref
      AND mutation.mutation_id = candidates.mutation_id
    RETURNING mutation.project_ref, mutation.mutation_id, mutation.operation, mutation.resource_key,
      mutation.checkpoint, mutation.recovery_not_before, mutation.lease_token,
      mutation.lease_expires_at, mutation.fencing_epoch
  ` as StoredRecoverableMutationClaimRow[];
  return rows;
}

export async function claimRecoverableProjectMutations(
  input: ClaimRecoverableProjectMutationsInput,
): Promise<RecoverableProjectMutationClaim[]> {
  assertRecoverableClaimInput(input);
  return sql.begin(async (transaction) => {
    const rows = await claimRecoverableRows(transaction, input);
    return rows.map(recoverableMutationClaim);
  });
}

function assertLeaseInput(input: MutationLeaseInput): void {
  assertMutationIdentity(input.projectRef, input.mutationId);
  if (!isProjectMutationId(input.leaseToken)) throw new Error("Mutation lease token must be a UUIDv4");
  if (!Number.isSafeInteger(input.fencingEpoch) || input.fencingEpoch < 1) {
    throw new Error("Mutation fencing epoch is invalid");
  }
}

export async function checkpointProjectMutation(
  transaction: SQL,
  input: CheckpointProjectMutationInput,
): Promise<"updated" | "lease_lost"> {
  assertLeaseInput(input);
  assertPublicMutationPayload(input.checkpoint);
  assertLeaseSeconds(input.leaseSeconds);
  const recoveryNotBefore = recoveryTimestamp(input.recoveryNotBefore);
  const preserveRecoveryTime = recoveryNotBefore === undefined;
  const [updated] = await transaction`
    UPDATE project_mutations
    SET checkpoint = ${input.checkpoint}::jsonb,
        recovery_not_before = CASE WHEN ${preserveRecoveryTime}
          THEN recovery_not_before ELSE ${recoveryNotBefore ?? null}::timestamptz END,
        lease_expires_at = NOW() + (${input.leaseSeconds} * INTERVAL '1 second'), updated_at = NOW()
    WHERE project_ref = ${input.projectRef} AND mutation_id = ${input.mutationId}
      AND status = 'running' AND lease_token = ${input.leaseToken}
      AND fencing_epoch = ${input.fencingEpoch}
    RETURNING mutation_id
  ` as Array<{ mutation_id: string }>;
  return updated ? "updated" : "lease_lost";
}

interface FinishProjectMutationInput extends MutationLeaseInput {
  status: "succeeded" | "failed_retryable" | "failed_terminal" | "outcome_unknown";
  receipt: Record<string, unknown>;
  responseStatus: number | null;
  failureCode: string | null;
  recoveryNotBefore?: Date | null;
}

function validCompletionResponseStatus(
  status: FinishProjectMutationInput["status"],
  responseStatus: number | null,
): boolean {
  if (responseStatus === null) return status !== "succeeded";
  if (!Number.isInteger(responseStatus)) return false;
  return status === "succeeded"
    ? responseStatus >= 200 && responseStatus < 300
    : responseStatus >= 100 && responseStatus <= 599;
}

async function finishProjectMutation(
  transaction: SQL,
  input: FinishProjectMutationInput,
): Promise<"updated" | "lease_lost"> {
  assertLeaseInput(input);
  assertPublicMutationPayload(input.receipt);
  if (!validCompletionResponseStatus(input.status, input.responseStatus)) {
    throw new Error("Mutation response status is invalid");
  }
  const preserveRecoveryTime = input.status === "failed_retryable"
    && input.recoveryNotBefore === undefined;
  const [updated] = await transaction`
    UPDATE project_mutations
    SET status = ${input.status}, receipt = ${input.receipt}::jsonb,
        response_status = ${input.responseStatus}, failure_code = ${input.failureCode},
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        recovery_not_before = CASE WHEN ${preserveRecoveryTime}
          THEN recovery_not_before ELSE ${input.recoveryNotBefore ?? null}::timestamptz END,
        completed_at = CASE WHEN ${input.status} IN ('succeeded', 'failed_terminal', 'outcome_unknown')
          THEN NOW() ELSE NULL END,
        updated_at = NOW()
    WHERE project_ref = ${input.projectRef} AND mutation_id = ${input.mutationId}
      AND status = 'running' AND lease_token = ${input.leaseToken}
      AND fencing_epoch = ${input.fencingEpoch}
    RETURNING mutation_id
  ` as Array<{ mutation_id: string }>;
  return updated ? "updated" : "lease_lost";
}

export async function completeProjectMutationSuccess(
  transaction: SQL,
  input: CompleteProjectMutationSuccessInput,
): Promise<"updated" | "lease_lost"> {
  return finishProjectMutation(transaction, {
    ...input,
    status: "succeeded",
    failureCode: null,
  });
}

export async function completeProjectMutationFailure(
  transaction: SQL,
  input: CompleteProjectMutationFailureInput,
): Promise<"updated" | "lease_lost"> {
  if (!FAILURE_CODE_PATTERN.test(input.failureCode)) throw new Error("Mutation failure code is invalid");
  if (input.status !== "failed_retryable" && input.recoveryNotBefore !== undefined) {
    throw new Error("Only retryable mutation failures may set a recovery timestamp");
  }
  return finishProjectMutation(transaction, {
    ...input,
    recoveryNotBefore: recoveryTimestamp(input.recoveryNotBefore),
    receipt: input.receipt ?? {},
    responseStatus: input.responseStatus ?? null,
  });
}

export async function readProjectMutation(input: {
  projectRef: string;
  mutationId: string;
}): Promise<ProjectMutationState | null> {
  assertMutationIdentity(input.projectRef, input.mutationId);
  const [row] = await sql`
    SELECT * FROM project_mutations
    WHERE project_ref = ${input.projectRef} AND mutation_id = ${input.mutationId}
  ` as StoredProjectMutationRow[];
  return row ? projectMutationState(row) : null;
}

export function publicProjectMutation(mutation: ProjectMutationState): Record<string, unknown> {
  return {
    project_ref: mutation.projectRef,
    mutation_id: mutation.mutationId,
    operation: mutation.operation,
    resource_key: mutation.resourceKey,
    request_fingerprint: mutation.requestFingerprint,
    principal: mutation.principal,
    status: mutation.status,
    checkpoint: {},
    receipt: mutation.receipt === null ? null : {},
    response_status: mutation.responseStatus,
    failure_code: mutation.failureCode,
    lease: {
      owner: mutation.leaseOwner,
      expires_at: mutation.leaseExpiresAt,
      fencing_epoch: mutation.fencingEpoch,
    },
    completed_at: mutation.completedAt,
    created_at: mutation.createdAt,
    updated_at: mutation.updatedAt,
  };
}
