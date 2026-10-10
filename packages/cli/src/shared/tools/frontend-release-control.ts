import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import type { HttpResult } from "../transports/http";

const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,20}$/u;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const RELEASE_ID_PATTERN = /^[0-9a-f]{64}$/u;
const MUTATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
const ARCHIVE_CHUNK_BYTES = 64 * 1024;
const RESPONSE_MAX_BYTES = 1024 * 1024;
const UPLOAD_REQUEST_TIMEOUT_MS = 10 * 60_000;
const MUTATION_RESPONSE_TIMEOUT_MS = 5_000;
const RELEASE_LIST_LIMIT_MAX = 100;

type ToolResponse = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export interface FrontendReleaseHttp {
    get<T = unknown>(path: string, options?: { maxJsonBytes?: number }): Promise<HttpResult<T>>;
    post<T = unknown>(
        path: string,
        body?: unknown,
        options?: { maxJsonBytes?: number; responseTimeoutMs?: number },
    ): Promise<HttpResult<T>>;
    postBinary<T = unknown>(
        path: string,
        body: { stream: ReadableStream<Uint8Array>; byteLength: number },
        options: {
            contentType: string;
            contentLength: number;
            contentSha256: string;
            maxJsonBytes: number;
            timeoutMs?: number;
            responseTimeoutMs?: number;
        },
    ): Promise<HttpResult<T>>;
}

export interface FrontendReleaseRecord {
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

interface FrontendReleaseInventory {
    project_ref: string;
    deployment_id: string;
    active_release_id: string | null;
    active_activation_id: string | null;
    releases: FrontendReleaseRecord[];
    next_cursor: string | null;
}

type ActiveReleaseSnapshot =
    | { inventory: FrontendReleaseInventory; exactReadback: boolean }
    | { failure: ToolResponse; status: number };

interface LocalArchive {
    handle: FileHandle;
    sizeBytes: number;
    sha256: string;
}

function toolResponse(payload: object): ToolResponse {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function releaseFailure(
    operation: string,
    code: "HTTP_ERROR" | "INVALID_RESPONSE" | "OUTCOME_UNKNOWN" | "NO_ACTIVE_RELEASE"
        | "NO_PREVIOUS_RELEASE" | "PREVIOUS_RELEASE_UNSUPPORTED",
    status: number | null,
): ToolResponse {
    return {
        isError: true,
        content: [{
            type: "text",
            text: JSON.stringify({ ok: false, operation, error: { code, http_status: status } }),
        }],
    };
}

function exactKeys(candidate: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(candidate).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function releaseRecord(candidate: unknown): FrontendReleaseRecord | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    const keys = [
        "schema", "project_ref", "deployment_id", "release_id", "sha256", "tree_sha256",
        "size_bytes", "file_count", "created_at", "kind",
    ] as const;
    if (!exactKeys(record, keys) || record.schema !== "supacloud.frontend-release.v1"
        || typeof record.project_ref !== "string" || !PROJECT_REF_PATTERN.test(record.project_ref)
        || typeof record.deployment_id !== "string" || !DEPLOYMENT_ID_PATTERN.test(record.deployment_id)
        || typeof record.release_id !== "string" || !RELEASE_ID_PATTERN.test(record.release_id)
        || record.sha256 !== record.release_id || typeof record.tree_sha256 !== "string"
        || !RELEASE_ID_PATTERN.test(record.tree_sha256) || !Number.isSafeInteger(record.size_bytes)
        || Number(record.size_bytes) < 1 || !Number.isSafeInteger(record.file_count)
        || Number(record.file_count) < 1 || !canonicalTimestamp(record.created_at)
        || record.kind !== "prebuilt_static") return null;
    return {
        project_ref: record.project_ref,
        deployment_id: record.deployment_id,
        release_id: record.release_id,
        sha256: record.release_id,
        tree_sha256: record.tree_sha256,
        size_bytes: Number(record.size_bytes),
        file_count: Number(record.file_count),
        created_at: record.created_at,
        kind: "prebuilt_static",
    };
}

function releaseEnvelope(candidate: unknown, expected: {
    projectRef: string;
    deploymentId: string;
    releaseId: string;
}): FrontendReleaseRecord | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const envelope = candidate as Record<string, unknown>;
    const release = exactKeys(envelope, ["project_ref", "deployment_id", "release"])
        ? releaseRecord(envelope.release)
        : null;
    if (!release || envelope.project_ref !== expected.projectRef
        || envelope.deployment_id !== expected.deploymentId
        || release.project_ref !== expected.projectRef
        || release.deployment_id !== expected.deploymentId
        || release.release_id !== expected.releaseId) return null;
    return release;
}

function canonicalTimestamp(candidate: unknown): candidate is string {
    if (typeof candidate !== "string" || !TIMESTAMP_PATTERN.test(candidate)) return false;
    const milliseconds = Date.parse(candidate);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === candidate;
}

function nullableIdentity(candidate: unknown, pattern: RegExp): string | null | undefined {
    if (candidate === null) return null;
    return typeof candidate === "string" && pattern.test(candidate) ? candidate : undefined;
}

function releaseInventory(
    candidate: unknown,
    expected?: { projectRef: string; deploymentId: string },
): FrontendReleaseInventory | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    const keys = [
        "project_ref", "deployment_id", "active_release_id", "active_activation_id",
        "releases", "next_cursor",
    ] as const;
    if (!exactKeys(record, keys) || typeof record.project_ref !== "string"
        || !PROJECT_REF_PATTERN.test(record.project_ref) || typeof record.deployment_id !== "string"
        || !DEPLOYMENT_ID_PATTERN.test(record.deployment_id) || !Array.isArray(record.releases)) return null;
    const activeReleaseId = nullableIdentity(record.active_release_id, RELEASE_ID_PATTERN);
    const activeActivationId = nullableIdentity(record.active_activation_id, MUTATION_ID_PATTERN);
    const nextCursor = nullableIdentity(record.next_cursor, RELEASE_ID_PATTERN);
    const releases = record.releases.map(releaseRecord);
    if (activeReleaseId === undefined || activeActivationId === undefined || nextCursor === undefined
        || (activeReleaseId === null) !== (activeActivationId === null)
        || releases.some((release) => release === null)) return null;
    const verified = releases as FrontendReleaseRecord[];
    if (new Set(verified.map((release) => release.release_id)).size !== verified.length
        || verified.some((release) => release.project_ref !== record.project_ref
            || release.deployment_id !== record.deployment_id)
        || (expected && (record.project_ref !== expected.projectRef
            || record.deployment_id !== expected.deploymentId))) return null;
    return {
        project_ref: record.project_ref,
        deployment_id: record.deployment_id,
        active_release_id: activeReleaseId,
        active_activation_id: activeActivationId,
        releases: verified,
        next_cursor: nextCursor,
    };
}

function deploymentEndpoint(projectRef: string, deploymentId: string): string {
    if (!PROJECT_REF_PATTERN.test(projectRef)) throw new Error("'ref' is invalid for frontend releases");
    if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) throw new Error("'id' is invalid for frontend releases");
    return `/v1/projects/${encodeURIComponent(projectRef)}/frontend/deployments/${encodeURIComponent(deploymentId)}`;
}

function releaseEndpoint(projectRef: string, deploymentId: string): string {
    return `${deploymentEndpoint(projectRef, deploymentId)}/releases`;
}

function releasePath(projectRef: string, deploymentId: string, releaseId: string): string {
    if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error("'release_id' must be a SHA-256 digest");
    return `${releaseEndpoint(projectRef, deploymentId)}/${releaseId}`;
}

function sameArchiveIdentity(left: BigIntStats, right: BigIntStats): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size
        && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function archiveSha256(handle: FileHandle, sizeBytes: number): Promise<string> {
    const hash = createHash("sha256");
    const chunk = new Uint8Array(Math.min(sizeBytes, ARCHIVE_CHUNK_BYTES));
    for (let offset: number = 0; offset < sizeBytes;) {
        const requested = Math.min(chunk.byteLength, sizeBytes - offset);
        const { bytesRead } = await handle.read(chunk, 0, requested, offset);
        if (bytesRead < 1) throw new Error("Frontend release archive changed while it was hashed");
        hash.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
    }
    return hash.digest("hex");
}

async function verifiedArchive(path: string): Promise<LocalArchive> {
    const archivePath = resolve(path);
    const handle = await open(archivePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
        const before = await handle.stat({ bigint: true });
        const sizeBytes = Number(before.size);
        if (!before.isFile() || sizeBytes < 1 || sizeBytes > ARCHIVE_MAX_BYTES) {
            throw new Error(`Frontend release archive must be a 1-${ARCHIVE_MAX_BYTES} byte regular file`);
        }
        const sha256 = await archiveSha256(handle, sizeBytes);
        const after = await handle.stat({ bigint: true });
        if (!sameArchiveIdentity(before, after)) {
            throw new Error("Frontend release archive identity changed while it was hashed");
        }
        return { handle, sizeBytes, sha256 };
    } catch (error: unknown) {
        await handle.close();
        throw error;
    }
}

function archiveStream(archive: LocalArchive): ReadableStream<Uint8Array> {
    let offset: number = 0;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (offset === archive.sizeBytes) {
                controller.close();
                return;
            }
            const length = Math.min(ARCHIVE_CHUNK_BYTES, archive.sizeBytes - offset);
            const chunk = new Uint8Array(length);
            const { bytesRead } = await archive.handle.read(chunk, 0, length, offset);
            if (bytesRead < 1) throw new Error("Frontend release archive changed while it was uploaded");
            offset += bytesRead;
            controller.enqueue(bytesRead === length ? chunk : chunk.subarray(0, bytesRead));
        },
    });
}

function releaseReadFailure(operation: string, response: HttpResult<unknown>): ToolResponse {
    return releaseFailure(operation, response.ok ? "INVALID_RESPONSE" : "HTTP_ERROR", response.status);
}

export async function listFrontendReleases(
    http: FrontendReleaseHttp,
    projectRef: string,
    deploymentId: string,
    cursor?: string,
    limit = 50,
): Promise<ToolResponse> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RELEASE_LIST_LIMIT_MAX) {
        throw new Error("'limit' must be 1-100");
    }
    if (cursor !== undefined && !RELEASE_ID_PATTERN.test(cursor)) throw new Error("'cursor' is invalid");
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const response = await http.get(`${releaseEndpoint(projectRef, deploymentId)}?${query}`, {
        maxJsonBytes: RESPONSE_MAX_BYTES,
    });
    const inventory = response.ok ? releaseInventory(response.data, { projectRef, deploymentId }) : null;
    if (!inventory || inventory.releases.length > limit) {
        return releaseReadFailure("frontend.list_releases", response);
    }
    return toolResponse(inventory);
}

export async function getFrontendRelease(
    http: FrontendReleaseHttp,
    projectRef: string,
    deploymentId: string,
    releaseId: string,
): Promise<ToolResponse> {
    const response = await http.get(releasePath(projectRef, deploymentId, releaseId), {
        maxJsonBytes: RESPONSE_MAX_BYTES,
    });
    const release = response.ok
        ? releaseEnvelope(response.data, { projectRef, deploymentId, releaseId })
        : null;
    if (!release) {
        return releaseReadFailure("frontend.get_release", response);
    }
    return toolResponse({ project_ref: projectRef, deployment_id: deploymentId, release });
}

export async function uploadFrontendRelease(
    http: FrontendReleaseHttp,
    projectRef: string,
    deploymentId: string,
    archivePath: string,
): Promise<ToolResponse> {
    const endpoint = releaseEndpoint(projectRef, deploymentId);
    const archive = await verifiedArchive(archivePath);
    let response: HttpResult<unknown>;
    try {
        response = await http.postBinary(endpoint, {
            stream: archiveStream(archive),
            byteLength: archive.sizeBytes,
        }, {
            contentType: "application/zip",
            contentLength: archive.sizeBytes,
            contentSha256: archive.sha256,
            maxJsonBytes: RESPONSE_MAX_BYTES,
            timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
            responseTimeoutMs: MUTATION_RESPONSE_TIMEOUT_MS,
        });
    } finally {
        await archive.handle.close();
    }
    const release = response.ok
        ? releaseEnvelope(response.data, { projectRef, deploymentId, releaseId: archive.sha256 })
        : null;
    if (!release) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408
            && !response.transportError) {
            return releaseFailure("frontend.upload_release", "HTTP_ERROR", response.status);
        }
        return uploadReadback(http, projectRef, deploymentId, archive.sha256, response.status);
    }
    const readback = await http.get(`${endpoint}/${release.release_id}`, { maxJsonBytes: RESPONSE_MAX_BYTES });
    const verified = readback.ok
        ? releaseEnvelope(readback.data, { projectRef, deploymentId, releaseId: release.release_id })
        : null;
    if (!verified || verified.tree_sha256 !== release.tree_sha256) {
        return releaseFailure("frontend.upload_release", "OUTCOME_UNKNOWN", readback.status);
    }
    return toolResponse({ project_ref: projectRef, deployment_id: deploymentId, release: verified });
}

async function uploadReadback(
    http: FrontendReleaseHttp,
    projectRef: string,
    deploymentId: string,
    releaseId: string,
    uploadStatus: number,
): Promise<ToolResponse> {
    const response = await http.get(releasePath(projectRef, deploymentId, releaseId), {
        maxJsonBytes: RESPONSE_MAX_BYTES,
    });
    const release = response.ok
        ? releaseEnvelope(response.data, { projectRef, deploymentId, releaseId })
        : null;
    if (!release) {
        return releaseFailure("frontend.upload_release", "OUTCOME_UNKNOWN", uploadStatus);
    }
    return toolResponse({ project_ref: projectRef, deployment_id: deploymentId, release });
}

interface PublicMutationReceipt {
    operation: string;
    status: string;
    responseStatus: number | null;
    failureCode: string | null;
}

interface ActivationIdentity {
    projectRef: string;
    deploymentId: string;
    releaseId: string;
    mutationId: string;
}

interface ActiveReleaseReadback {
    release: FrontendReleaseRecord | null;
    status: number;
}

function stableJson(candidate: unknown): string {
    if (candidate === null || typeof candidate !== "object") return JSON.stringify(candidate);
    if (Array.isArray(candidate)) return `[${candidate.map(stableJson).join(",")}]`;
    const record = candidate as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
        `${JSON.stringify(key)}:${stableJson(record[key])}`
    )).join(",")}}`;
}

function activationFingerprint(identity: ActivationIdentity & {
    expectedActiveReleaseId: string;
    expectedActivationId: string;
}): string {
    return createHash("sha256").update(stableJson({
        project_ref: identity.projectRef,
        deployment_id: identity.deploymentId,
        release_id: identity.releaseId,
        expected_active_release_id: identity.expectedActiveReleaseId,
        activation_id: identity.mutationId,
        expected_activation_id: identity.expectedActivationId,
    })).digest("hex");
}

function activationResourceKey(deploymentId: string): string {
    return `v1/frontend_release/${Buffer.from(deploymentId, "utf8").toString("base64url")}`;
}

function publicMutationReceipt(candidate: unknown, expected: {
    projectRef: string;
    mutationId: string;
    resourceKey: string;
    requestFingerprint: string;
}): PublicMutationReceipt | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const envelope = candidate as Record<string, unknown>;
    const mutation = envelope.mutation as Record<string, unknown> | null;
    const expectedKeys = [
        "project_ref", "mutation_id", "operation", "resource_key", "request_fingerprint",
        "principal", "status", "checkpoint", "receipt", "response_status", "failure_code",
        "lease", "completed_at", "created_at", "updated_at",
    ] as const;
    if (!mutation || !exactKeys(envelope, ["project_ref", "mutation"])
        || !exactKeys(mutation, expectedKeys) || envelope.project_ref !== expected.projectRef
        || mutation.project_ref !== expected.projectRef || mutation.mutation_id !== expected.mutationId
        || mutation.resource_key !== expected.resourceKey
        || mutation.request_fingerprint !== expected.requestFingerprint
        || typeof mutation.operation !== "string" || typeof mutation.status !== "string"
        || !(mutation.response_status === null || Number.isSafeInteger(mutation.response_status))
        || !(mutation.failure_code === null || typeof mutation.failure_code === "string")) return null;
    return {
        operation: mutation.operation,
        status: mutation.status,
        responseStatus: mutation.response_status as number | null,
        failureCode: mutation.failure_code as string | null,
    };
}

function activationReceipt(candidate: unknown, input: {
    projectRef: string;
    deploymentId: string;
    releaseId: string;
    mutationId: string;
}): FrontendReleaseRecord | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    const release = releaseRecord(record.release);
    const mutation = record.mutation as Record<string, unknown> | null;
    if (!release || !mutation || !exactKeys(record, [
        "project_ref", "deployment_id", "active_release_id", "activation_id", "release", "mutation",
    ]) || !exactKeys(mutation, ["mutation_id", "status", "replayed"])
        || record.project_ref !== input.projectRef || record.deployment_id !== input.deploymentId
        || record.active_release_id !== input.releaseId || record.activation_id !== input.mutationId
        || release.project_ref !== input.projectRef || release.deployment_id !== input.deploymentId
        || release.release_id !== input.releaseId || mutation.mutation_id !== input.mutationId
        || mutation.status !== "succeeded" || typeof mutation.replayed !== "boolean") return null;
    return release;
}

async function activeReleaseReadback(
    http: FrontendReleaseHttp,
    identity: ActivationIdentity,
): Promise<ActiveReleaseReadback> {
    const snapshot = await readActiveFrontendRelease(http, identity.projectRef, identity.deploymentId);
    if ("failure" in snapshot) return { release: null, status: snapshot.status };
    const inventory = snapshot.inventory;
    if (inventory.active_release_id !== identity.releaseId
        || inventory.active_activation_id !== identity.mutationId) {
        return { release: null, status: 200 };
    }
    if (snapshot.exactReadback) {
        return { release: inventory.releases[0] ?? null, status: 200 };
    }

    const releaseRead = await http.get(releasePath(
        identity.projectRef,
        identity.deploymentId,
        identity.releaseId,
    ), { maxJsonBytes: RESPONSE_MAX_BYTES });
    const release = releaseRead.ok
        ? releaseEnvelope(releaseRead.data, {
            projectRef: identity.projectRef,
            deploymentId: identity.deploymentId,
            releaseId: identity.releaseId,
        })
        : null;
    return { release, status: releaseRead.status };
}

async function readActiveFrontendRelease(
    http: FrontendReleaseHttp,
    projectRef: string,
    deploymentId: string,
): Promise<ActiveReleaseSnapshot> {
    const response = await http.get(`${deploymentEndpoint(projectRef, deploymentId)}/active-release`, {
        maxJsonBytes: RESPONSE_MAX_BYTES,
    });
    const inventory = response.ok && response.status === 200
        ? releaseInventory(response.data, { projectRef, deploymentId }) : null;
    if (inventory) {
        if (inventory.next_cursor !== null
            || inventory.releases.length !== (inventory.active_release_id === null ? 0 : 1)
            || (inventory.releases[0] && inventory.releases[0].release_id !== inventory.active_release_id)) {
            return { failure: releaseReadFailure("frontend.get_active_release", response), status: response.status };
        }
        return { inventory, exactReadback: false };
    }
    if (response.ok || response.status !== 404) {
        return { failure: releaseReadFailure("frontend.get_active_release", response), status: response.status };
    }

    // 旧 Management API 没有 active-release 路由：限制历史页为 1 条，
    // 再按权威 active_release_id 精确读回，避免把排序后的第一条误当成当前版本。
    const historyResponse = await http.get(`${releaseEndpoint(projectRef, deploymentId)}?limit=1`, {
        maxJsonBytes: RESPONSE_MAX_BYTES,
    });
    const history = historyResponse.ok && historyResponse.status === 200
        ? releaseInventory(historyResponse.data, { projectRef, deploymentId }) : null;
    if (!history || history.releases.length > 1) {
        return {
            failure: releaseReadFailure("frontend.get_active_release", historyResponse),
            status: historyResponse.status,
        };
    }
    if (history.active_release_id === null) {
        return { inventory: { ...history, releases: [], next_cursor: null }, exactReadback: false };
    }
    const exactResponse = await http.get(releasePath(projectRef, deploymentId, history.active_release_id), {
        maxJsonBytes: RESPONSE_MAX_BYTES,
    });
    const release = exactResponse.ok && exactResponse.status === 200
        ? releaseEnvelope(exactResponse.data, { projectRef, deploymentId, releaseId: history.active_release_id })
        : null;
    if (!release) {
        return {
            failure: releaseReadFailure("frontend.get_active_release", exactResponse),
            status: exactResponse.status,
        };
    }
    return { inventory: { ...history, releases: [release], next_cursor: null }, exactReadback: true };
}

export async function getActiveFrontendRelease(
    http: FrontendReleaseHttp,
    projectRef: string,
    deploymentId: string,
): Promise<ToolResponse> {
    const snapshot = await readActiveFrontendRelease(http, projectRef, deploymentId);
    return "failure" in snapshot ? snapshot.failure : toolResponse(snapshot.inventory);
}

export async function readFrontendReleaseAuthority(
    http: FrontendReleaseHttp,
    projectRef: string,
    deploymentId: string,
): Promise<ToolResponse> {
    return getActiveFrontendRelease(http, projectRef, deploymentId);
}

export async function rollbackFrontendRelease(
    http: FrontendReleaseHttp,
    projectRef: string,
    deploymentId: string,
    releaseId?: string,
): Promise<ToolResponse> {
    if (releaseId !== undefined && !RELEASE_ID_PATTERN.test(releaseId)) {
        throw new Error("'release_id' must be a SHA-256 digest");
    }
    const authority: ActiveReleaseSnapshot & { previousRelease?: FrontendReleaseRecord } = releaseId === undefined
        ? await readPreviousFrontendRelease(http, projectRef, deploymentId)
        : await readActiveFrontendRelease(http, projectRef, deploymentId);
    if ("failure" in authority) return authority.failure;
    const inventory = authority.inventory;
    if (releaseId === undefined) {
        releaseId = authority.previousRelease?.release_id;
    }
    if (releaseId === undefined) return releaseFailure("frontend.rollback", "NO_PREVIOUS_RELEASE", 409);
    if (inventory.active_release_id === releaseId) {
        return toolResponse({
            project_ref: projectRef,
            deployment_id: deploymentId,
            active_release_id: releaseId,
            activation_id: inventory.active_activation_id,
            unchanged: true,
        });
    }
    if (inventory.active_release_id === null || inventory.active_activation_id === null) {
        return releaseFailure("frontend.rollback", "NO_ACTIVE_RELEASE", 409);
    }
    if (!authority.previousRelease) {
        const target = await getFrontendRelease(http, projectRef, deploymentId, releaseId);
        if (target.isError) return target;
    }
    const mutationId = crypto.randomUUID();
    const activation = await activateFrontendRelease(http, {
        projectRef,
        deploymentId,
        releaseId,
        expectedActiveReleaseId: inventory.active_release_id,
        expectedActivationId: inventory.active_activation_id,
        mutationId,
    });
    if (activation.isError) {
        return {
            ...toolResponse({
                ...JSON.parse(activation.content[0]!.text),
                operation: "frontend.rollback",
                mutation_id: mutationId,
                target_release_id: releaseId,
                expected_active_release_id: inventory.active_release_id,
                expected_activation_id: inventory.active_activation_id,
            }),
            isError: true,
        };
    }
    return toolResponse({
        ...JSON.parse(activation.content[0]!.text),
        rollback: true,
        previous_release_id: inventory.active_release_id,
        previous_activation_id: inventory.active_activation_id,
    });
}

async function readPreviousFrontendRelease(
    http: FrontendReleaseHttp,
    projectRef: string,
    deploymentId: string,
): Promise<ActiveReleaseSnapshot & { previousRelease?: FrontendReleaseRecord }> {
    const response = await http.get(`${deploymentEndpoint(projectRef, deploymentId)}/rollback-release`, {
        maxJsonBytes: RESPONSE_MAX_BYTES,
    });
    if (!response.ok && response.status === 404) {
        return {
            failure: releaseFailure("frontend.rollback", "PREVIOUS_RELEASE_UNSUPPORTED", 404),
            status: 404,
        };
    }
    const data = response.data;
    const value = data && typeof data === "object" && !Array.isArray(data)
        ? data as Record<string, unknown> : null;
    const activeReleaseId = value ? nullableIdentity(value.active_release_id, RELEASE_ID_PATTERN) : undefined;
    const activeActivationId = value ? nullableIdentity(value.active_activation_id, MUTATION_ID_PATTERN) : undefined;
    const previousActivationId = value ? nullableIdentity(value.previous_activation_id, MUTATION_ID_PATTERN) : undefined;
    const previous = value?.previous_release === null ? null : releaseRecord(value?.previous_release);
    if (!response.ok || response.status !== 200 || !value || !exactKeys(value, [
        "schema", "project_ref", "deployment_id", "active_release_id", "active_activation_id",
        "previous_release", "previous_activation_id",
    ]) || value.schema !== "supacloud.frontend-rollback-snapshot.v1"
        || value.project_ref !== projectRef || value.deployment_id !== deploymentId
        || activeReleaseId === undefined || activeActivationId === undefined || previousActivationId === undefined
        || (activeReleaseId === null) !== (activeActivationId === null)
        || (previous === null && value.previous_release !== null)
        || (previous === null) !== (previousActivationId === null)
        || (previous && (activeReleaseId === null || previous.project_ref !== projectRef
            || previous.deployment_id !== deploymentId))) {
        return { failure: releaseReadFailure("frontend.rollback", response), status: response.status };
    }
    return {
        inventory: {
            project_ref: projectRef, deployment_id: deploymentId,
            active_release_id: activeReleaseId, active_activation_id: activeActivationId,
            releases: [], next_cursor: null,
        },
        exactReadback: false,
        ...(previous ? { previousRelease: previous } : {}),
    };
}

export async function activateFrontendRelease(
    http: FrontendReleaseHttp,
    input: {
        projectRef: string;
        deploymentId: string;
        releaseId: string;
        expectedActiveReleaseId: string;
        expectedActivationId: string;
        mutationId: string;
    },
): Promise<ToolResponse> {
    const mutationId = input.mutationId;
    if (!MUTATION_ID_PATTERN.test(mutationId)) throw new Error("'mutation_id' must be a UUIDv4");
    if (input.expectedActiveReleaseId !== "absent" && !RELEASE_ID_PATTERN.test(input.expectedActiveReleaseId)) {
        throw new Error("'expected_active_release_id' is invalid");
    }
    if (input.expectedActivationId !== "absent" && !MUTATION_ID_PATTERN.test(input.expectedActivationId)) {
        throw new Error("'expected_activation_id' is invalid");
    }
    const endpoint = `${releasePath(input.projectRef, input.deploymentId, input.releaseId)}/activate`;
    const response = await http.post(endpoint, {
        expected_active_release_id: input.expectedActiveReleaseId,
        expected_activation_id: input.expectedActivationId,
        mutation_id: mutationId,
    }, {
        maxJsonBytes: RESPONSE_MAX_BYTES,
        responseTimeoutMs: MUTATION_RESPONSE_TIMEOUT_MS,
    });
    const release = activationReceipt(response.data, { ...input, mutationId });
    if (!response.ok || !release) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408
            && !response.transportError) {
            return releaseFailure("frontend.activate_release", "HTTP_ERROR", response.status);
        }
        return activationReadback(http, input, mutationId, response.status);
    }
    const readback = await activeReleaseReadback(http, { ...input, mutationId });
    if (!readback.release || readback.release.tree_sha256 !== release.tree_sha256) {
        return releaseFailure("frontend.activate_release", "OUTCOME_UNKNOWN", readback.status);
    }
    return toolResponse({
        project_ref: input.projectRef,
        deployment_id: input.deploymentId,
        active_release_id: input.releaseId,
        activation_id: mutationId,
        release: readback.release,
    });
}

async function activationReadback(
    http: FrontendReleaseHttp,
    input: {
        projectRef: string;
        deploymentId: string;
        releaseId: string;
        expectedActiveReleaseId: string;
        expectedActivationId: string;
    },
    mutationId: string,
    activationStatus: number,
): Promise<ToolResponse> {
    const mutationRead = await http.get(
        `/v1/projects/${encodeURIComponent(input.projectRef)}/mutations/${mutationId}`,
        { maxJsonBytes: RESPONSE_MAX_BYTES },
    );
    const mutationEnvelope = mutationRead.data as Record<string, unknown> | null;
    const mutation = mutationRead.ok ? publicMutationReceipt(mutationRead.data, {
        projectRef: input.projectRef,
        mutationId,
        resourceKey: activationResourceKey(input.deploymentId),
        requestFingerprint: activationFingerprint({ ...input, mutationId }),
    }) : null;
    if (!mutation || mutationEnvelope?.project_ref !== input.projectRef
        || mutation.operation !== "frontend.release.activate" || mutation.status !== "succeeded"
        || mutation.responseStatus !== 200 || mutation.failureCode !== null) {
        return releaseFailure("frontend.activate_release", "OUTCOME_UNKNOWN", activationStatus);
    }
    const readback = await activeReleaseReadback(http, { ...input, mutationId });
    if (!readback.release) {
        return releaseFailure("frontend.activate_release", "OUTCOME_UNKNOWN", activationStatus);
    }
    return toolResponse({
        project_ref: input.projectRef,
        deployment_id: input.deploymentId,
        active_release_id: input.releaseId,
        activation_id: mutationId,
        release: readback.release,
    });
}
