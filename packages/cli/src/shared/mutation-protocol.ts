import { createHash } from "node:crypto";
import { projectRefPathSegment } from "./project-ref";
import type { HttpTransport } from "./transports/http";

const MUTATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const OPERATION_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const RESOURCE_KEY_PATTERN = /^v1\/(?:[a-z0-9][a-z0-9._-]{0,63})\/([A-Za-z0-9_-]{2,171})$/;
const RESOURCE_ID_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const LEASE_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_STATUS_RESPONSE_BYTES = 196_608;
const MAX_JSON_DEPTH = 32;
const MAX_RESOURCE_ID_BYTES = 128;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MUTATION_STATUSES = new Set([
    "pending", "running", "succeeded", "failed_retryable", "failed_terminal", "outcome_unknown",
]);
const MUTATION_RESPONSE_KEYS = ["project_ref", "mutation"] as const;
const MUTATION_KEYS = [
    "project_ref", "mutation_id", "operation", "resource_key", "request_fingerprint", "principal",
    "status", "checkpoint", "receipt", "response_status", "failure_code", "lease", "completed_at",
    "created_at", "updated_at",
] as const;
const PRINCIPAL_KEYS = ["type", "id"] as const;
const LEASE_KEYS = ["owner", "expires_at", "fencing_epoch"] as const;

export interface SafeMutationStatus {
    project_ref: string;
    mutation_id: string;
    operation: string;
    resource_key: string | null;
    request_fingerprint: string;
    principal: { type: "master" | "admin" | "project"; id: string };
    status: "pending" | "running" | "succeeded" | "failed_retryable" | "failed_terminal" | "outcome_unknown";
    checkpoint: Record<string, unknown>;
    receipt: Record<string, unknown> | null;
    response_status: number | null;
    failure_code: string | null;
    lease: { owner: string | null; expires_at: string | null; fencing_epoch: number };
    completed_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface MutationExpectation {
    ref: string;
    mutationId: string;
    operation: string;
    requestFingerprint: string;
}

export type MutationStatusReadback =
    | { kind: "available"; mutation: SafeMutationStatus }
    | { kind: "unavailable"; httpStatus: number | null }
    | { kind: "invalid" };

export function isMutationId(candidate: unknown): candidate is string {
    return typeof candidate === "string" && MUTATION_ID_PATTERN.test(candidate);
}

function assertCanonicalJsonNode(candidate: unknown, seen: WeakSet<object>, depth: number): void {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return;
    if (typeof candidate !== "object" || depth > MAX_JSON_DEPTH) {
        throw new Error("Mutation request must be bounded JSON");
    }
    if (seen.has(candidate)) throw new Error("Mutation request must not contain cycles");
    seen.add(candidate);
    const prototype = Object.getPrototypeOf(candidate);
    const plainRecord = prototype === Object.prototype || prototype === null;
    const children = Array.isArray(candidate) ? candidate : plainRecord ? Object.values(candidate) : null;
    if (!children) throw new Error("Mutation request must contain only JSON objects and arrays");
    for (const child of children) assertCanonicalJsonNode(child, seen, depth + 1);
    seen.delete(candidate);
}

function stableStringifyNode(jsonValue: unknown): string {
    if (jsonValue === null || typeof jsonValue !== "object") {
        const serialized = JSON.stringify(jsonValue);
        if (serialized === undefined) throw new Error("Mutation request must contain exact JSON values");
        return serialized;
    }
    if (Array.isArray(jsonValue)) return `[${jsonValue.map(stableStringifyNode).join(",")}]`;
    const record = jsonValue as Record<string, unknown>;
    const fields = Object.keys(record).sort().map(
        (key) => `${JSON.stringify(key)}:${stableStringifyNode(record[key])}`,
    );
    return `{${fields.join(",")}}`;
}

export function mutationRequestFingerprint(normalizedRequest: unknown): string {
    assertCanonicalJsonNode(normalizedRequest, new WeakSet(), 0);
    return createHash("sha256").update(stableStringifyNode(normalizedRequest)).digest("hex");
}

function objectRecord(candidate: unknown): Record<string, unknown> | null {
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

function exactRecord(candidate: unknown, keys: readonly string[]): Record<string, unknown> | null {
    const record = objectRecord(candidate);
    if (!record || Object.keys(record).length !== keys.length) return null;
    return keys.every((key) => Object.hasOwn(record, key)) ? record : null;
}

function emptyProjection(candidate: unknown): Record<string, unknown> | null {
    const record = objectRecord(candidate);
    return record && Object.keys(record).length === 0 ? record : null;
}

function canonicalTimestamp(candidate: unknown): candidate is string {
    if (typeof candidate !== "string" || !TIMESTAMP_PATTERN.test(candidate)) return false;
    const milliseconds = Date.parse(candidate);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === candidate;
}

function nullableTimestamp(candidate: unknown): candidate is string | null {
    return candidate === null || canonicalTimestamp(candidate);
}

function safePrincipal(candidate: unknown): SafeMutationStatus["principal"] | null {
    const principal = exactRecord(candidate, PRINCIPAL_KEYS);
    if (!principal || !["master", "admin", "project"].includes(String(principal.type))) return null;
    if (typeof principal.id !== "string" || !principal.id || principal.id.length > 320
        || principal.id.trim() !== principal.id || /[\u0000-\u001f\u007f]/u.test(principal.id)) return null;
    return { type: principal.type as SafeMutationStatus["principal"]["type"], id: principal.id };
}

function safeLease(candidate: unknown): SafeMutationStatus["lease"] | null {
    const lease = exactRecord(candidate, LEASE_KEYS);
    if (!lease || (lease.owner !== null
        && (typeof lease.owner !== "string" || !LEASE_OWNER_PATTERN.test(lease.owner)))) return null;
    if (!nullableTimestamp(lease.expires_at)
        || !Number.isSafeInteger(lease.fencing_epoch) || Number(lease.fencing_epoch) < 0) return null;
    return {
        owner: lease.owner as string | null,
        expires_at: lease.expires_at,
        fencing_epoch: Number(lease.fencing_epoch),
    };
}

function safeResponseStatus(candidate: unknown): number | null | undefined {
    if (candidate === null) return null;
    return Number.isInteger(candidate) && Number(candidate) >= 100 && Number(candidate) <= 599
        ? Number(candidate)
        : undefined;
}

function validLeaseState(status: string, lease: SafeMutationStatus["lease"]): boolean {
    const running = status === "running";
    return running
        ? lease.owner !== null && lease.expires_at !== null && lease.fencing_epoch > 0
        : lease.owner === null && lease.expires_at === null;
}

function validMutationLifecycle(
    mutation: Record<string, unknown>,
    receipt: Record<string, unknown> | null,
    responseStatus: number | null,
): boolean {
    const terminal = ["succeeded", "failed_terminal", "outcome_unknown"].includes(String(mutation.status));
    if ((mutation.completed_at !== null) !== terminal) return false;
    if (mutation.status === "succeeded") {
        return receipt !== null && responseStatus !== null && responseStatus >= 200 && responseStatus < 300
            && mutation.failure_code === null;
    }
    if (mutation.status === "failed_terminal") {
        return receipt !== null && typeof mutation.failure_code === "string";
    }
    if (mutation.status === "failed_retryable" || mutation.status === "outcome_unknown") {
        return receipt !== null && typeof mutation.failure_code === "string";
    }
    if (mutation.status === "pending") {
        return receipt === null && responseStatus === null && mutation.failure_code === null;
    }
    return true;
}

function canonicalMutationResourceKey(candidate: unknown): candidate is string {
    if (typeof candidate !== "string") return false;
    const match = RESOURCE_KEY_PATTERN.exec(candidate);
    if (!match) return false;
    const encodedResourceId = match[1]!;
    const resourceIdBytes = Buffer.from(encodedResourceId, "base64url");
    if (resourceIdBytes.byteLength < 1 || resourceIdBytes.byteLength > MAX_RESOURCE_ID_BYTES
        || resourceIdBytes.toString("base64url") !== encodedResourceId) return false;
    let resourceId: string;
    try {
        resourceId = FATAL_UTF8_DECODER.decode(resourceIdBytes);
    } catch (decodeError) {
        if (decodeError instanceof TypeError) return false;
        throw decodeError;
    }
    return resourceId.trim() === resourceId
        && !RESOURCE_ID_CONTROL_PATTERN.test(resourceId)
        && Buffer.from(resourceId, "utf8").equals(resourceIdBytes);
}

function validMutationIdentity(mutation: Record<string, unknown>): boolean {
    if (!isMutationId(mutation.mutation_id) || typeof mutation.project_ref !== "string") return false;
    if (typeof mutation.operation !== "string" || !OPERATION_PATTERN.test(mutation.operation)) return false;
    if (mutation.resource_key !== null && !canonicalMutationResourceKey(mutation.resource_key)) return false;
    return typeof mutation.request_fingerprint === "string"
        && FINGERPRINT_PATTERN.test(mutation.request_fingerprint);
}

function validMutationTerminalFields(mutation: Record<string, unknown>): boolean {
    if (typeof mutation.status !== "string" || !MUTATION_STATUSES.has(mutation.status)) return false;
    if (mutation.failure_code !== null
        && (typeof mutation.failure_code !== "string" || !FAILURE_CODE_PATTERN.test(mutation.failure_code))) return false;
    return nullableTimestamp(mutation.completed_at)
        && canonicalTimestamp(mutation.created_at) && canonicalTimestamp(mutation.updated_at);
}

function safeMutationStatus(candidate: unknown): SafeMutationStatus | null {
    const mutation = exactRecord(candidate, MUTATION_KEYS);
    if (!mutation || !validMutationIdentity(mutation) || !validMutationTerminalFields(mutation)) return null;
    const principal = safePrincipal(mutation.principal);
    const checkpoint = emptyProjection(mutation.checkpoint);
    const receipt = mutation.receipt === null ? null : emptyProjection(mutation.receipt);
    const responseStatus = safeResponseStatus(mutation.response_status);
    const lease = safeLease(mutation.lease);
    if (!principal || !checkpoint || (mutation.receipt !== null && !receipt)
        || responseStatus === undefined || !lease || !validLeaseState(String(mutation.status), lease)
        || !validMutationLifecycle(mutation, receipt, responseStatus)) return null;
    return {
        project_ref: mutation.project_ref as string,
        mutation_id: mutation.mutation_id as string,
        operation: mutation.operation as string,
        resource_key: mutation.resource_key as string | null,
        request_fingerprint: mutation.request_fingerprint as string,
        principal, status: mutation.status as SafeMutationStatus["status"], checkpoint, receipt,
        response_status: responseStatus, failure_code: mutation.failure_code as string | null, lease,
        completed_at: mutation.completed_at as string | null,
        created_at: mutation.created_at as string,
        updated_at: mutation.updated_at as string,
    };
}

export function mutationStatusPath(ref: string, mutationId: string): string {
    if (!isMutationId(mutationId)) throw new Error("'mutation_id' must be a UUIDv4");
    return `/v1/projects/${projectRefPathSegment(ref, "Mutations")}/mutations/${encodeURIComponent(mutationId)}`;
}

function mutationStatusResponse(ref: string, mutationId: string, payload: unknown): SafeMutationStatus | null {
    const response = exactRecord(payload, MUTATION_RESPONSE_KEYS);
    const mutation = safeMutationStatus(response?.mutation);
    return response?.project_ref === ref && mutation?.project_ref === ref && mutation.mutation_id === mutationId
        ? mutation
        : null;
}

export async function fetchMutationStatus(
    http: HttpTransport,
    ref: string,
    mutationId: string,
): Promise<MutationStatusReadback> {
    const response = await http.get(mutationStatusPath(ref, mutationId), {
        maxResponseBytes: MAX_STATUS_RESPONSE_BYTES,
    });
    if (!response.ok) {
        return { kind: "unavailable", httpStatus: response.transportError ? null : response.status };
    }
    const mutation = mutationStatusResponse(ref, mutationId, response.data);
    return mutation ? { kind: "available", mutation } : { kind: "invalid" };
}

export async function verifiedMutationReadback(
    http: HttpTransport,
    expectation: MutationExpectation,
): Promise<MutationStatusReadback> {
    const readback = await fetchMutationStatus(http, expectation.ref, expectation.mutationId);
    if (readback.kind !== "available") return readback;
    const mutation = readback.mutation;
    return mutation.operation === expectation.operation
        && mutation.request_fingerprint === expectation.requestFingerprint
        && mutation.principal.type === "project"
        && mutation.principal.id === `project:${expectation.ref}`
        ? readback
        : { kind: "invalid" };
}
