import { Type } from "@sinclair/typebox";
import { decodedSchema, optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";
import {
    releaseControlFailure,
    releaseControlMutationFailure,
    releaseControlSuccess,
    type ReleaseControlToolResponse,
} from "./release-control-response";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>,
    ) => void;
};

type StorageAction =
    | "status"
    | "list_buckets"
    | "get_bucket"
    | "create_bucket"
    | "update_bucket"
    | "delete_bucket"
    | "list_files"
    | "upload_base64"
    | "delete_file";

const MAX_BUCKET_ID_LENGTH = 100;
const MAX_MIME_TYPE_COUNT = 100;
const MAX_MIME_TYPE_LENGTH = 255;
const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BUCKET_ID_PATTERN = new RegExp(`^(?!\\.+$)[A-Za-z0-9._-]{1,${MAX_BUCKET_ID_LENGTH}}$`);
const MIME_TYPE_PATTERN = /^(?=\S)(?=.*\S$)[^\u0000-\u001f\u007f]+$/;
const BUCKET_REVISION_PATTERN = /^[0-9]{1,20}$/;
const ACTION_ARGUMENTS: Record<StorageAction, ReadonlySet<string>> = {
    status: new Set(["action"]),
    list_buckets: new Set(["action", "ref"]),
    get_bucket: new Set(["action", "ref", "bucket"]),
    create_bucket: new Set(["action", "ref", "bucket", "public", "file_size_limit", "allowed_mime_types"]),
    update_bucket: new Set(["action", "ref", "bucket", "expected_revision", "public", "file_size_limit", "allowed_mime_types"]),
    delete_bucket: new Set(["action", "ref", "bucket", "expected_revision", "require_empty"]),
    list_files: new Set(["action", "ref", "bucket"]),
    upload_base64: new Set(["action", "ref", "bucket", "filename", "base64_content", "mime_type"]),
    delete_file: new Set(["action", "ref", "bucket", "filename"]),
};

function normalizedMimeTypes(candidate: unknown): unknown {
    return Array.isArray(candidate)
        ? candidate.map((mimeType) => typeof mimeType === "string" ? mimeType.trim() : mimeType)
        : candidate;
}

function parseAllowedMimeTypes(input: string | string[]): unknown {
    if (Array.isArray(input)) return normalizedMimeTypes(input);
    const trimmed = input.trim();
    if (!trimmed) return [];
    if (!trimmed.startsWith("[")) {
        return normalizedMimeTypes(trimmed.split(","));
    }
    try {
        return normalizedMimeTypes(JSON.parse(trimmed));
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error("Invalid allowed_mime_types JSON array");
    }
}

const allowedMimeTypesSchema = Type.Optional(decodedSchema(
    Type.Union([Type.String(), Type.Array(Type.String())]),
    Type.Array(Type.String({
        minLength: 1,
        maxLength: MAX_MIME_TYPE_LENGTH,
        pattern: MIME_TYPE_PATTERN.source,
    }), { maxItems: MAX_MIME_TYPE_COUNT }),
    parseAllowedMimeTypes,
));
const fileSizeLimitSchema = Type.Optional(Type.Integer({
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
}));

function requiredText(args: Record<string, unknown>, field: string): string {
    const text = args[field];
    if (typeof text !== "string" || !text.trim()) {
        throw new Error(`'${field}' required for '${String(args.action)}'`);
    }
    return text.trim();
}

function validBucketId(bucket: string): boolean {
    return BUCKET_ID_PATTERN.test(bucket);
}

function requiredProjectRef(args: Record<string, unknown>): string {
    const ref = requiredText(args, "ref");
    if (!PROJECT_REF_PATTERN.test(ref)) throw new Error("'ref' is invalid for Storage buckets");
    return ref;
}

function requiredBucketId(args: Record<string, unknown>): string {
    const bucket = requiredText(args, "bucket");
    if (!validBucketId(bucket)) throw new Error("'bucket' is invalid for Storage buckets");
    return bucket;
}

function requiredBucketRevision(args: Record<string, unknown>): string {
    const revision = requiredText(args, "expected_revision");
    if (!BUCKET_REVISION_PATTERN.test(revision)) throw new Error("'expected_revision' is invalid for Storage buckets");
    return revision;
}

function assertEmptyBucketDeletion(args: Record<string, unknown>): void {
    if (args.require_empty !== true) throw new Error("'require_empty=true' required for 'delete_bucket'");
}

function assertActionArguments(action: StorageAction, args: Record<string, unknown>): void {
    const allowedArguments = ACTION_ARGUMENTS[action];
    if (!allowedArguments) throw new Error(`Unsupported Storage action '${action}'`);
    const unsupported = Object.keys(args).filter((field) => !allowedArguments.has(field));
    if (unsupported.length > 0) throw new Error(`'${unsupported[0]}' is not supported for '${action}'`);
}

function storageBucketPath(ref: string, bucket?: string): string {
    if (!PROJECT_REF_PATTERN.test(ref)) throw new Error("'ref' is invalid for Storage buckets");
    if (bucket !== undefined && !validBucketId(bucket)) {
        throw new Error("'bucket' is invalid for Storage buckets");
    }
    const root = `/v1/projects/${encodeURIComponent(ref)}/storage/buckets`;
    return bucket === undefined ? root : `${root}/${encodeURIComponent(bucket)}`;
}

function bucketRecord(candidate: unknown): Record<string, unknown> | null {
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

type SafeBucket = {
    id: string;
    name: string;
    public: boolean;
    file_size_limit: number | null;
    allowed_mime_types: string[] | null;
    revision: string | null;
};

function isFileSizeLimit(candidate: unknown): candidate is number | null {
    return candidate === null
        || (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0);
}

function assertBucketSettings(args: Record<string, unknown>): void {
    if (args.file_size_limit !== undefined
        && (args.file_size_limit === null || !isFileSizeLimit(args.file_size_limit))) {
        throw new Error("'file_size_limit' must be a positive safe integer");
    }
    if (args.allowed_mime_types !== undefined
        && (args.allowed_mime_types === null || !isAllowedMimeTypes(args.allowed_mime_types))) {
        throw new Error("'allowed_mime_types' is invalid");
    }
}

function isAllowedMimeTypes(candidate: unknown): candidate is string[] | null {
    return candidate === null
        || (Array.isArray(candidate) && candidate.length <= MAX_MIME_TYPE_COUNT
            && candidate.every((mimeType) => typeof mimeType === "string"
                && mimeType.length <= MAX_MIME_TYPE_LENGTH && MIME_TYPE_PATTERN.test(mimeType)));
}

function isBucketRevision(candidate: unknown): candidate is string | null {
    return candidate === null
        || (typeof candidate === "string" && BUCKET_REVISION_PATTERN.test(candidate));
}

function safeBucket(candidate: unknown, expectedBucket?: string): SafeBucket | null {
    const bucket = bucketRecord(candidate);
    if (bucket === null || typeof bucket.id !== "string" || !validBucketId(bucket.id)
        || typeof bucket.name !== "string" || !validBucketId(bucket.name)
        || typeof bucket.public !== "boolean" || !isFileSizeLimit(bucket.file_size_limit)
        || !isAllowedMimeTypes(bucket.allowed_mime_types)
        || !isBucketRevision(bucket.revision)
        || (expectedBucket !== undefined && bucket.id !== expectedBucket && bucket.name !== expectedBucket)) {
        return null;
    }
    return {
        id: bucket.id,
        name: bucket.name,
        public: bucket.public,
        file_size_limit: bucket.file_size_limit,
        allowed_mime_types: bucket.allowed_mime_types === null ? null : [...bucket.allowed_mime_types],
        revision: bucket.revision,
    };
}

function safeExactBucket(candidate: unknown, expectedBucket: string): SafeBucket | null {
    const bucket = safeBucket(candidate);
    return bucket?.id === expectedBucket ? bucket : null;
}

function safeBucketList(candidate: unknown): SafeBucket[] | null {
    if (!Array.isArray(candidate)) return null;
    const buckets = candidate.map((bucket) => safeBucket(bucket));
    if (buckets.some((bucket) => bucket === null)) return null;
    const safeBuckets = buckets as SafeBucket[];
    const ids = safeBuckets.map((bucket) => bucket.id);
    const names = safeBuckets.map((bucket) => bucket.name);
    return new Set(ids).size === ids.length && new Set(names).size === names.length
        ? safeBuckets
        : null;
}

function safeCreatedBucketReceipt(
    candidate: unknown,
    expectedBucket: string,
    request: Record<string, unknown>,
): Record<string, unknown> | null {
    const bucket = bucketRecord(candidate);
    if (bucket?.id !== expectedBucket || bucket.name !== expectedBucket
        || bucket.public !== (request.public === true)) return null;
    return { bucket: { id: expectedBucket, name: expectedBucket, public: request.public === true } };
}

function safeDeletedBucket(
    candidate: unknown,
    expectedBucket: string,
    expectedRevision: string,
): Record<string, unknown> | null {
    const receipt = bucketRecord(candidate);
    return receipt?.id === expectedBucket
        && receipt.deleted === true
        && receipt.require_empty === true
        && receipt.previous_revision === expectedRevision
        && receipt.new_revision === null
        ? {
            bucket_id: expectedBucket,
            deleted: true,
            require_empty: true,
            previous_revision: expectedRevision,
            new_revision: null,
        }
        : null;
}

type MutationReadbackExpectation = {
    operation: string;
    ref: string;
    response: HttpResult<unknown>;
    expectedBucket: string;
    request: Record<string, unknown>;
    previousRevision: string | null;
    expectedNewRevision?: string;
};

function mutationReadbackResponse(expectation: MutationReadbackExpectation): ReleaseControlToolResponse {
    const { operation, ref, response, expectedBucket, request, previousRevision, expectedNewRevision } = expectation;
    const readback = safeExactBucket(response.data, expectedBucket);
    const validReadback = readback?.name === expectedBucket
        && readback.revision !== null
        && (expectedNewRevision === undefined || readback.revision === expectedNewRevision)
        && bucketMatchesRequest(readback, request);
    if (!response.ok || !validReadback || !readback) {
        return releaseControlFailure(operation, "OUTCOME_UNKNOWN", response.transportError ? null : response.status);
    }
    return releaseControlSuccess(operation, {
        project_ref: ref,
        bucket_id: expectedBucket,
        previous_revision: previousRevision,
        new_revision: readback.revision,
        bucket: readback,
    });
}

type BucketResponseExpectation = {
    operation: string;
    ref: string;
    response: HttpResult<unknown>;
    operationKind: "read" | "mutation";
    safePayload: (candidate: unknown) => Record<string, unknown> | null;
};

function bucketResponse(expectation: BucketResponseExpectation): ReleaseControlToolResponse {
    const { operation, ref, response, operationKind, safePayload } = expectation;
    if (!response.ok) {
        return operationKind === "mutation"
            ? releaseControlMutationFailure(operation, response)
            : releaseControlFailure(operation, "HTTP_ERROR", response.transportError ? null : response.status);
    }
    const payload = safePayload(response.data);
    if (!payload) {
        return operationKind === "mutation"
            ? releaseControlFailure(operation, "OUTCOME_UNKNOWN", response.status)
            : releaseControlFailure(operation, "INVALID_RESPONSE", null);
    }
    return releaseControlSuccess(operation, { project_ref: ref, ...payload });
}

function createBucketRequest(args: Record<string, unknown>): Record<string, unknown> {
    assertBucketSettings(args);
    const request: Record<string, unknown> = { name: requiredText(args, "bucket") };
    if (args.public !== undefined) request.public = args.public;
    if (args.file_size_limit !== undefined) request.file_size_limit = args.file_size_limit;
    if (args.allowed_mime_types !== undefined) request.allowed_mime_types = args.allowed_mime_types;
    return request;
}

function updateBucketRequest(args: Record<string, unknown>): Record<string, unknown> {
    assertBucketSettings(args);
    const settings = Object.fromEntries(
        ["public", "file_size_limit", "allowed_mime_types"]
            .filter((field) => args[field] !== undefined)
            .map((field) => [field, args[field]]),
    );
    if (Object.keys(settings).length === 0) throw new Error("Bucket update requires at least one field");
    return { expected_revision: requiredBucketRevision(args), ...settings };
}

function equalAllowedMimeTypes(candidate: unknown, expected: unknown): boolean {
    if (!Array.isArray(expected)) return false;
    if (expected.length === 0 && candidate === null) return true;
    return Array.isArray(candidate)
        && candidate.length === expected.length
        && candidate.every((mimeType, index) => mimeType === expected[index]);
}

function bucketMatchesRequest(candidate: unknown, request: Record<string, unknown>): boolean {
    const bucket = bucketRecord(candidate);
    if (!bucket) return false;
    if (request.public !== undefined && bucket.public !== request.public) return false;
    if (request.file_size_limit !== undefined && bucket.file_size_limit !== request.file_size_limit) return false;
    return request.allowed_mime_types === undefined
        || equalAllowedMimeTypes(bucket.allowed_mime_types, request.allowed_mime_types);
}

async function createBucketMutationReceipt(
    http: HttpTransport,
    ref: string,
    bucket: string,
    request: Record<string, unknown>,
): Promise<ReleaseControlToolResponse> {
    return bucketResponse({
        operation: "storage.create_bucket",
        ref,
        response: await http.post(storageBucketPath(ref), request),
        operationKind: "mutation",
        safePayload: (candidate) => safeCreatedBucketReceipt(candidate, bucket, request),
    });
}

function safeUpdatedBucket(
    candidate: unknown,
    expectedBucket: string,
    expectedRevision: string,
    request: Record<string, unknown>,
): SafeBucket | null {
    const receipt = bucketRecord(candidate);
    const bucket = safeExactBucket(candidate, expectedBucket);
    return bucket
        && bucket.name === expectedBucket
        && bucket.revision !== null
        && bucket.revision !== expectedRevision
        && receipt?.previous_revision === expectedRevision
        && receipt.new_revision === bucket.revision
        && bucketMatchesRequest(bucket, request)
        ? bucket
        : null;
}

async function listBuckets(http: HttpTransport, args: Record<string, unknown>): Promise<ReleaseControlToolResponse> {
    const ref = requiredProjectRef(args);
    return bucketResponse({
        operation: "storage.list_buckets",
        ref,
        response: await http.get(storageBucketPath(ref)),
        operationKind: "read",
        safePayload: (candidate) => {
            const buckets = safeBucketList(candidate);
            return buckets ? { buckets } : null;
        },
    });
}

async function getBucket(http: HttpTransport, args: Record<string, unknown>): Promise<ReleaseControlToolResponse> {
    const ref = requiredProjectRef(args);
    const bucket = requiredBucketId(args);
    return bucketResponse({
        operation: "storage.get_bucket",
        ref,
        response: await http.get(storageBucketPath(ref, bucket)),
        operationKind: "read",
        safePayload: (candidate) => {
            const safeReadback = safeBucket(candidate, bucket);
            return safeReadback ? { bucket: safeReadback } : null;
        },
    });
}

async function createBucket(http: HttpTransport, args: Record<string, unknown>): Promise<ReleaseControlToolResponse> {
    const ref = requiredProjectRef(args);
    const request = createBucketRequest(args);
    const bucket = request.name as string;
    const bucketPath = storageBucketPath(ref, bucket);
    const receipt = await createBucketMutationReceipt(http, ref, bucket, request);
    if (receipt.isError) return receipt;
    const expectedReadback = { ...request, public: request.public === true };
    return mutationReadbackResponse({
        operation: "storage.create_bucket",
        ref,
        response: await http.get(bucketPath),
        expectedBucket: bucket,
        request: expectedReadback,
        previousRevision: null,
    });
}

async function updateBucket(http: HttpTransport, args: Record<string, unknown>): Promise<ReleaseControlToolResponse> {
    const ref = requiredProjectRef(args);
    const bucket = requiredBucketId(args);
    const request = updateBucketRequest(args);
    const expectedRevision = request.expected_revision as string;
    const bucketPath = storageBucketPath(ref, bucket);
    const mutation = await http.put(bucketPath, request);
    if (!mutation.ok) return releaseControlMutationFailure("storage.update_bucket", mutation);
    const updated = safeUpdatedBucket(mutation.data, bucket, expectedRevision, request);
    if (!updated) return releaseControlFailure("storage.update_bucket", "OUTCOME_UNKNOWN", mutation.status);
    return mutationReadbackResponse({
        operation: "storage.update_bucket",
        ref,
        response: await http.get(bucketPath),
        expectedBucket: bucket,
        request,
        previousRevision: expectedRevision,
        expectedNewRevision: updated.revision ?? undefined,
    });
}

async function deleteBucket(http: HttpTransport, args: Record<string, unknown>): Promise<ReleaseControlToolResponse> {
    const ref = requiredProjectRef(args);
    const bucket = requiredBucketId(args);
    const expectedRevision = requiredBucketRevision(args);
    assertEmptyBucketDeletion(args);
    const bucketPath = storageBucketPath(ref, bucket);
    const deletePath = `${bucketPath}?expected_revision=${encodeURIComponent(expectedRevision)}&require_empty=true`;
    const receipt = bucketResponse({
        operation: "storage.delete_bucket",
        ref,
        response: await http.delete(deletePath),
        operationKind: "mutation",
        safePayload: (candidate) => safeDeletedBucket(candidate, bucket, expectedRevision),
    });
    if (receipt.isError) return receipt;
    const readback = await http.get(bucketPath);
    if (readback.ok || readback.transportError || readback.status !== 404) {
        return releaseControlFailure("storage.delete_bucket", "OUTCOME_UNKNOWN", readback.transportError ? null : readback.status);
    }
    return receipt;
}

type BucketActionHandler = (
    http: HttpTransport,
    args: Record<string, unknown>,
) => Promise<ReleaseControlToolResponse>;

const BUCKET_ACTION_HANDLERS = {
    list_buckets: listBuckets,
    get_bucket: getBucket,
    create_bucket: createBucket,
    update_bucket: updateBucket,
    delete_bucket: deleteBucket,
} satisfies Record<string, BucketActionHandler>;

type BucketAction = keyof typeof BUCKET_ACTION_HANDLERS;

function executeBucketAction(
    action: string,
    http: HttpTransport,
    args: Record<string, unknown>,
): Promise<ReleaseControlToolResponse> | null {
    if (!Object.hasOwn(BUCKET_ACTION_HANDLERS, action)) return null;
    return BUCKET_ACTION_HANDLERS[action as BucketAction](http, args);
}

export function registerStorageTools(server: ToolServer, http: HttpTransport): void {
    server.tool(
        "storage",
        `S3/MinIO storage management.
Actions: status, list_buckets, get_bucket, create_bucket, update_bucket, delete_bucket, list_files, upload_base64, delete_file`,
        {
            action: withDescription(stringEnum([
                "status", "list_buckets", "get_bucket", "create_bucket", "update_bucket", "delete_bucket",
                "list_files", "upload_base64", "delete_file",
            ]), "Action"),
            ref: optional(Type.String({ pattern: PROJECT_REF_PATTERN.source }), "[list_buckets/get_bucket/create_bucket/update_bucket/delete_bucket/list_files/upload_base64/delete_file] Project ref"),
            bucket: optional(Type.String({ pattern: BUCKET_ID_PATTERN.source }), "[get_bucket/create_bucket/update_bucket/delete_bucket/list_files/upload_base64/delete_file] Bucket name or ID"),
            public: optional(Type.Boolean(), "[create_bucket/update_bucket] Public bucket access"),
            file_size_limit: withDescription(fileSizeLimitSchema, "[create_bucket/update_bucket] Positive safe-integer per-file size limit in bytes"),
            allowed_mime_types: withDescription(allowedMimeTypesSchema, "[create_bucket/update_bucket] MIME types as a comma-separated or JSON array"),
            expected_revision: optional(Type.String({ pattern: BUCKET_REVISION_PATTERN.source }), "[update_bucket/delete_bucket] Exact revision from list_buckets/get_bucket"),
            require_empty: optional(Type.Boolean(), "[delete_bucket] Must be true; deletion never empties a bucket"),
            filename: optional(Type.String(), "[upload_base64/delete_file] File name/path"),
            base64_content: optional(Type.String(), "[upload_base64] Base64 encoded content"),
            mime_type: optional(Type.String(), "[upload_base64] MIME type (default: application/octet-stream)"),
        },
        async (args) => {
            const action = String(args.action) as StorageAction;
            assertActionArguments(action, args);
            const bucketAction = executeBucketAction(action, http, args);
            const bucketActionResponse = bucketAction ? await bucketAction : null;
            if (bucketActionResponse) return bucketActionResponse;

            let text: string;
            switch (action) {
                case "status":
                    text = JSON.stringify((await http.get("/v1/storage/status")).data, null, 2);
                    break;
                case "list_files": {
                    const ref = requiredProjectRef(args);
                    const bucket = requiredBucketId(args);
                    const response = await http.get(`/v1/storage/${ref}/buckets/${bucket}/files`);
                    if (!response.ok) { text = `❌ Failed (${response.status})`; break; }
                    const files = response.data as any[];
                    if (!Array.isArray(files) || !files.length) { text = "No files."; break; }
                    text = `📁 Files (${files.length}):\n` + files.map((file: any) => `  - ${file.name} (${file.size ? (file.size / 1024).toFixed(1) + "KB" : "?"})`).join("\n");
                    break;
                }
                case "upload_base64": {
                    const ref = requiredProjectRef(args);
                    const bucket = requiredBucketId(args);
                    const filename = requiredText(args, "filename");
                    const base64Content = requiredText(args, "base64_content");
                    try {
                        const buffer = Buffer.from(base64Content, "base64");
                        const blob = new Blob([buffer], { type: typeof args.mime_type === "string" ? args.mime_type : "application/octet-stream" });
                        const formData = new FormData();
                        formData.append("file", blob, filename);
                        const response = await http.postMultipart(`/v1/storage/${ref}/buckets/${bucket}/upload`, formData);
                        text = response.ok ? `✅ File ${filename} uploaded to ${bucket}` : `❌ Upload failed (${response.status})`;
                    } catch (error: unknown) {
                        text = `❌ Error: ${error instanceof Error ? error.message : String(error)}`;
                    }
                    break;
                }
                case "delete_file": {
                    const ref = requiredProjectRef(args);
                    const bucket = requiredBucketId(args);
                    const filename = requiredText(args, "filename");
                    text = (await http.delete(`/v1/storage/${ref}/buckets/${bucket}/files/${filename}`)).ok
                        ? `✅ File ${filename} deleted` : "❌ Failed";
                    break;
                }
                default:
                    return releaseControlFailure(`storage.${action}`, "INVALID_RESPONSE", null);
            }
            return { content: [{ type: "text", text }] };
        },
    );
}
