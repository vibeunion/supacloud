import { Type } from "@sinclair/typebox";
import { decodedSchema, optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";
import {
    releaseControlFailure,
    releaseControlMutationFailure,
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

const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BUCKET_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function parseAllowedMimeTypes(input: string | string[]): unknown {
    if (Array.isArray(input)) return input;
    const trimmed = input.trim();
    if (!trimmed) return [];
    if (!trimmed.startsWith("[")) {
        return trimmed.split(",").map((mimeType) => mimeType.trim()).filter(Boolean);
    }
    try {
        return JSON.parse(trimmed);
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error("Invalid allowed_mime_types JSON array");
    }
}

const allowedMimeTypesSchema = Type.Optional(decodedSchema(
    Type.Union([Type.String(), Type.Array(Type.String())]),
    Type.Array(Type.String()),
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

function storageBucketPath(ref: string, bucket?: string): string {
    if (!PROJECT_REF_PATTERN.test(ref)) throw new Error("'ref' is invalid for Storage buckets");
    if (bucket !== undefined && (!BUCKET_ID_PATTERN.test(bucket) || bucket === "." || bucket === "..")) {
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
};

function isFileSizeLimit(candidate: unknown): candidate is number | null {
    return candidate === null
        || (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0);
}

function isAllowedMimeTypes(candidate: unknown): candidate is string[] | null {
    return candidate === null
        || (Array.isArray(candidate) && candidate.every((mimeType) => typeof mimeType === "string"));
}

function safeBucket(candidate: unknown, expectedBucket?: string): SafeBucket | null {
    const bucket = bucketRecord(candidate);
    if (bucket === null || typeof bucket.id !== "string" || typeof bucket.name !== "string"
        || typeof bucket.public !== "boolean" || !isFileSizeLimit(bucket.file_size_limit)
        || !isAllowedMimeTypes(bucket.allowed_mime_types)
        || (expectedBucket !== undefined && bucket.id !== expectedBucket && bucket.name !== expectedBucket)) {
        return null;
    }
    return {
        id: bucket.id,
        name: bucket.name,
        public: bucket.public,
        file_size_limit: bucket.file_size_limit,
        allowed_mime_types: bucket.allowed_mime_types === null ? null : [...bucket.allowed_mime_types],
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
    return { id: expectedBucket, name: expectedBucket, public: request.public === true };
}

function safeDeletedBucket(candidate: unknown, expectedBucket: string): Record<string, unknown> | null {
    const receipt = bucketRecord(candidate);
    return receipt?.id === expectedBucket && receipt.deleted === true
        ? { id: expectedBucket, deleted: true }
        : null;
}

function bucketSuccess(apiPayload: object): ReleaseControlToolResponse {
    return { content: [{ type: "text", text: JSON.stringify(apiPayload, null, 2) }] };
}

function createReadbackResponse(
    response: HttpResult<unknown>,
    expectedBucket: string,
    request: Record<string, unknown>,
): ReleaseControlToolResponse {
    const readback = safeExactBucket(response.data, expectedBucket);
    const validReadback = readback?.name === expectedBucket
        && readback.public === (request.public === true)
        && bucketMatchesRequest(readback, request);
    if (!response.ok || !validReadback || !readback) {
        return releaseControlFailure("storage.create_bucket", "OUTCOME_UNKNOWN", response.transportError ? null : response.status);
    }
    return bucketSuccess(readback);
}

function bucketResponse(
    operation: string,
    response: HttpResult<unknown>,
    operationKind: "read" | "mutation",
    safePayload: (candidate: unknown) => object | null,
): ReleaseControlToolResponse {
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
    return bucketSuccess(payload);
}

function createBucketRequest(args: Record<string, unknown>): Record<string, unknown> {
    const request: Record<string, unknown> = { name: requiredText(args, "bucket") };
    if (args.public !== undefined) request.public = args.public;
    if (args.file_size_limit !== undefined) request.file_size_limit = args.file_size_limit;
    if (args.allowed_mime_types !== undefined) request.allowed_mime_types = args.allowed_mime_types;
    return request;
}

function updateBucketRequest(args: Record<string, unknown>): Record<string, unknown> {
    const request = Object.fromEntries(
        ["public", "file_size_limit", "allowed_mime_types"]
            .filter((field) => args[field] !== undefined)
            .map((field) => [field, args[field]]),
    );
    if (Object.keys(request).length === 0) throw new Error("Bucket update requires at least one field");
    return request;
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

async function listBuckets(http: HttpTransport, args: Record<string, unknown>): Promise<ReleaseControlToolResponse> {
    const ref = requiredText(args, "ref");
    return bucketResponse("storage.list_buckets", await http.get(storageBucketPath(ref)), "read", safeBucketList);
}

async function getBucket(http: HttpTransport, args: Record<string, unknown>): Promise<ReleaseControlToolResponse> {
    const ref = requiredText(args, "ref");
    const bucket = requiredText(args, "bucket");
    return bucketResponse("storage.get_bucket", await http.get(storageBucketPath(ref, bucket)), "read",
        (apiPayload) => safeBucket(apiPayload, bucket));
}

async function createBucket(http: HttpTransport, args: Record<string, unknown>): Promise<ReleaseControlToolResponse> {
    const ref = requiredText(args, "ref");
    const request = createBucketRequest(args);
    const bucket = request.name as string;
    const bucketPath = storageBucketPath(ref, bucket);
    const receipt = bucketResponse("storage.create_bucket", await http.post(storageBucketPath(ref), request), "mutation",
        (apiPayload) => safeCreatedBucketReceipt(apiPayload, bucket, request));
    if (receipt.isError) return receipt;
    return createReadbackResponse(await http.get(bucketPath), bucket, request);
}

async function updateBucket(http: HttpTransport, args: Record<string, unknown>): Promise<ReleaseControlToolResponse> {
    const ref = requiredText(args, "ref");
    const bucket = requiredText(args, "bucket");
    const request = updateBucketRequest(args);
    return bucketResponse("storage.update_bucket", await http.put(storageBucketPath(ref, bucket), request), "mutation",
        (apiPayload) => {
            const updated = safeExactBucket(apiPayload, bucket);
            return updated && bucketMatchesRequest(updated, request) ? updated : null;
        });
}

async function deleteBucket(http: HttpTransport, args: Record<string, unknown>): Promise<ReleaseControlToolResponse> {
    const ref = requiredText(args, "ref");
    const bucket = requiredText(args, "bucket");
    return bucketResponse("storage.delete_bucket", await http.delete(storageBucketPath(ref, bucket)), "mutation",
        (apiPayload) => safeDeletedBucket(apiPayload, bucket));
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
            ref: optional(Type.String(), "[list_buckets/get_bucket/create_bucket/update_bucket/delete_bucket/list_files/upload_base64/delete_file] Project ref"),
            bucket: optional(Type.String(), "[get_bucket/create_bucket/update_bucket/delete_bucket/list_files/upload_base64/delete_file] Bucket name or ID"),
            public: optional(Type.Boolean(), "[create_bucket/update_bucket] Public bucket access"),
            file_size_limit: withDescription(fileSizeLimitSchema, "[create_bucket/update_bucket] Positive safe-integer per-file size limit in bytes"),
            allowed_mime_types: withDescription(allowedMimeTypesSchema, "[create_bucket/update_bucket] MIME types as a comma-separated or JSON array"),
            filename: optional(Type.String(), "[upload_base64/delete_file] File name/path"),
            base64_content: optional(Type.String(), "[upload_base64] Base64 encoded content"),
            mime_type: optional(Type.String(), "[upload_base64] MIME type (default: application/octet-stream)"),
        },
        async (args) => {
            const action = String(args.action);
            const bucketAction = executeBucketAction(action, http, args);
            const bucketActionResponse = bucketAction ? await bucketAction : null;
            if (bucketActionResponse) return bucketActionResponse;

            let text: string;
            switch (action) {
                case "status":
                    text = JSON.stringify((await http.get("/v1/storage/status")).data, null, 2);
                    break;
                case "list_files": {
                    const ref = requiredText(args, "ref");
                    const bucket = requiredText(args, "bucket");
                    const response = await http.get(`/v1/storage/${ref}/buckets/${bucket}/files`);
                    if (!response.ok) { text = `❌ Failed (${response.status})`; break; }
                    const files = response.data as any[];
                    if (!Array.isArray(files) || !files.length) { text = "No files."; break; }
                    text = `📁 Files (${files.length}):\n` + files.map((file: any) => `  - ${file.name} (${file.size ? (file.size / 1024).toFixed(1) + "KB" : "?"})`).join("\n");
                    break;
                }
                case "upload_base64": {
                    const ref = requiredText(args, "ref");
                    const bucket = requiredText(args, "bucket");
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
                    const ref = requiredText(args, "ref");
                    const bucket = requiredText(args, "bucket");
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
