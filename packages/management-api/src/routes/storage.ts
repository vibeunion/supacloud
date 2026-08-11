import { Elysia, t, status } from "elysia";
import { StorageService, migrationJobs } from '../services/storage.service';
import {
    MAX_STORAGE_MIME_TYPE_COUNT,
    MAX_STORAGE_MIME_TYPE_LENGTH,
    STORAGE_BUCKET_ID_PATTERN_SOURCE,
    STORAGE_BUCKET_REVISION_PATTERN_SOURCE,
    STORAGE_MIME_TYPE_PATTERN_SOURCE,
    STORAGE_PROJECT_REF_PATTERN_SOURCE,
    normalizedStorageFileSizeLimit,
    storageBucketInputError,
} from "../services/storage-bucket-contract";
import { StorageRLS } from "../services/storage-rls";
import { StorageVectorError, StorageVectorService } from "../services/storage-vector.service";
import { logger } from "../utils/logger";
import { config } from "../config";
import { requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";

const ErrorResponse = t.Object({ message: t.String() });
const SuccessResponse = t.Object({ success: t.Boolean(), message: t.String() });
const StorageProjectRef = t.String({ pattern: STORAGE_PROJECT_REF_PATTERN_SOURCE });
const StorageBucketId = t.String({ pattern: STORAGE_BUCKET_ID_PATTERN_SOURCE });
const StorageBucketRevision = t.String({ pattern: STORAGE_BUCKET_REVISION_PATTERN_SOURCE });
const StorageFileSizeLimit = t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const StorageMimeType = t.String({
    minLength: 1,
    maxLength: MAX_STORAGE_MIME_TYPE_LENGTH,
    pattern: STORAGE_MIME_TYPE_PATTERN_SOURCE,
});
const StorageAllowedMimeTypes = t.Array(StorageMimeType, { maxItems: MAX_STORAGE_MIME_TYPE_COUNT });
const StorageProjectParams = t.Object({ ref: StorageProjectRef });
const StorageBucketParams = t.Object({ ref: StorageProjectRef, id: StorageBucketId });
const StorageBucketCreateBody = t.Object({
    name: StorageBucketId,
    id: t.Optional(StorageBucketId),
    public: t.Optional(t.Boolean()),
    file_size_limit: t.Optional(StorageFileSizeLimit),
    allowed_mime_types: t.Optional(StorageAllowedMimeTypes),
});
const StorageBucketUpdateBody = t.Object({
    expected_revision: StorageBucketRevision,
    public: t.Optional(t.Boolean()),
    file_size_limit: t.Optional(StorageFileSizeLimit),
    allowed_mime_types: t.Optional(StorageAllowedMimeTypes),
}, { minProperties: 2 });
const StorageBucketDeleteQuery = t.Object({
    expected_revision: StorageBucketRevision,
    require_empty: t.Literal("true"),
});

type StorageBucketCreateInput = {
    name: string;
    id?: string;
    public?: boolean;
    file_size_limit?: number;
    allowed_mime_types?: string[];
};

type StorageOperationResult = { success: boolean; error?: string };

async function runProjectVectorOperation(ref: string, operation: string, body: Record<string, unknown>) {
    switch (operation) {
        case "CreateVectorBucket":
            return StorageVectorService.createBucket(ref, String(body.vectorBucketName || ""));
        case "DeleteVectorBucket":
            return StorageVectorService.deleteBucket(ref, String(body.vectorBucketName || ""));
        case "GetVectorBucket":
            return StorageVectorService.getBucket(ref, String(body.vectorBucketName || ""));
        case "ListVectorBuckets":
            return StorageVectorService.listBuckets(ref, body);
        case "CreateIndex":
            return StorageVectorService.createIndex(ref, body as Parameters<typeof StorageVectorService.createIndex>[1]);
        case "DeleteIndex":
            return StorageVectorService.deleteIndex(ref, String(body.vectorBucketName || ""), String(body.indexName || ""));
        case "GetIndex":
            return StorageVectorService.getIndex(ref, String(body.vectorBucketName || ""), String(body.indexName || ""));
        case "ListIndexes":
            return StorageVectorService.listIndexes(ref, body as Parameters<typeof StorageVectorService.listIndexes>[1]);
        case "PutVectors":
            return StorageVectorService.putVectors(ref, body as Parameters<typeof StorageVectorService.putVectors>[1]);
        case "DeleteVectors":
            return StorageVectorService.deleteVectors(ref, body as Parameters<typeof StorageVectorService.deleteVectors>[1]);
        case "GetVectors":
            return StorageVectorService.getVectors(ref, body as Parameters<typeof StorageVectorService.getVectors>[1]);
        case "ListVectors":
            return StorageVectorService.listVectors(ref, body as Parameters<typeof StorageVectorService.listVectors>[1]);
        case "QueryVectors":
            return StorageVectorService.queryVectors(ref, body as Parameters<typeof StorageVectorService.queryVectors>[1]);
        default:
            throw new StorageVectorError(`Unknown vector operation '${operation}'`, 404, "ResourceNotFoundException");
    }
}

// ── Imaginary Config ──────────────────────────────────────────────
const IMAGINARY_URL = config.imaginaryUrl;
const S3_ENDPOINT  = config.s3Endpoint;

/**
 * Build the internal S3 URL for imaginary to fetch the source image from.
 * imaginary will pull the image via HTTP from this URL.
 */
function isValidBucketName(bucket: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(bucket);
}

function normalizeObjectPath(path: string): string | null {
    const normalized = path.replace(/^\/+/, "");
    if (!normalized || normalized.includes("\\") || /[\x00-\x1f\x7f]/.test(normalized)) return null;
    if (normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null;
    return normalized;
}

function encodeObjectPath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}

function publicUrlProtocol(request: Request): "http" | "https" {
    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (forwardedProtocol === "http" || forwardedProtocol === "https") return forwardedProtocol;
    return new URL(request.url).protocol === "http:" ? "http" : "https";
}

function buildPublicObjectUrl(request: Request, projectRef: string, bucket: string, objectPath: string): string {
    const host = `${projectRef}.api.${config.baseDomain}`;
    return `${publicUrlProtocol(request)}://${host}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodeObjectPath(objectPath)}`;
}

async function ensureImageTransformAccess(request: Request, ref: string, bucket: string) {
    const logicalBucket = await StorageRLS.getLogicalBucket(ref, bucket, undefined, true).catch(() => null);
    if (logicalBucket?.public === true) return undefined;
    return await requireProjectOrAdminAuth(request, ref);
}

function buildSourceUrl(bucket: string, path: string): string {
    if (!isValidBucketName(bucket)) throw new Error("Invalid bucket name");
    const normalizedPath = normalizeObjectPath(path);
    if (!normalizedPath) throw new Error("Invalid object path");
    const base = S3_ENDPOINT.endsWith('/') ? S3_ENDPOINT.slice(0, -1) : S3_ENDPOINT;
    return `${base}/${encodeURIComponent(bucket)}/${normalizedPath.split("/").map(encodeURIComponent).join("/")}`;
}

function logStorageMetadataFailure(message: string, ref: string, bucketName: string, error: unknown): void {
    logger.error(message, {
        ref,
        bucketName,
        error: error instanceof Error ? error.message : String(error),
    });
}

async function createLogicalStorageBucket(ref: string, bucketName: string, input: StorageBucketCreateInput): Promise<StorageOperationResult> {
    try {
        const created = await StorageRLS.createLogicalBucketAsAdmin(ref, {
            id: bucketName,
            name: bucketName,
            public: input.public ?? false,
            fileSizeLimit: input.file_size_limit,
            allowedMimeTypes: input.allowed_mime_types,
        });
        return created ? { success: true } : { success: false, error: "Bucket already exists" };
    } catch (error: unknown) {
        logStorageMetadataFailure("Failed to persist Studio storage bucket metadata", ref, bucketName, error);
        return { success: false, error: "Failed to persist bucket metadata" };
    }
}

async function rollbackLogicalStorageBucket(ref: string, bucketName: string): Promise<void> {
    try {
        await StorageRLS.deleteLogicalBucketAsAdmin(ref, bucketName);
    } catch (error: unknown) {
        logStorageMetadataFailure("Failed to roll back Studio storage bucket metadata", ref, bucketName, error);
    }
}

async function createStorageBucket(ref: string, input: StorageBucketCreateInput) {
    const bucketName = input.name || input.id || "";
    const inputError = storageBucketInputError(ref, bucketName, input);
    if (inputError) return { bucketName, storageResult: { success: false, error: inputError } };
    const logicalResult = await createLogicalStorageBucket(ref, bucketName, input);
    if (!logicalResult.success) return { bucketName, storageResult: logicalResult };
    const storageResult = await StorageService.createBucket(ref, bucketName);
    if (!storageResult.success) await rollbackLogicalStorageBucket(ref, bucketName);
    return { bucketName, storageResult };
}

function mergeStorageBuckets(
    physicalBuckets: Array<Record<string, unknown>>,
    logicalBuckets: Array<Record<string, unknown>>,
): Record<string, unknown>[] {
    const bucketsById = new Map<string, Record<string, unknown>>();
    for (const bucket of physicalBuckets) bucketsById.set(String(bucket.id), bucket);
    for (const bucket of logicalBuckets) {
        const id = String(bucket.id);
        bucketsById.set(id, { ...bucketsById.get(id), ...bucket, id });
    }
    return Array.from(bucketsById.values()).map((bucket) => ({
        ...bucket,
        file_size_limit: normalizedStorageFileSizeLimit(bucket.file_size_limit),
        allowed_mime_types: bucket.allowed_mime_types ?? null,
        revision: typeof bucket.revision === "string" ? bucket.revision : null,
    }));
}

async function listStorageBuckets(ref: string): Promise<Record<string, unknown>[]> {
    const [physicalBuckets, logicalBuckets] = await Promise.all([
        StorageService.listBuckets(ref),
        StorageRLS.listLogicalBucketsAsAdmin(ref),
    ]);
    return mergeStorageBuckets(physicalBuckets, logicalBuckets);
}

async function listLegacyStorageBuckets(ref: string): Promise<Record<string, unknown>[]> {
    if (ref === "default") return await StorageService.listBuckets(ref);
    return await listStorageBuckets(ref);
}

async function deleteStorageBucket(ref: string, bucketName: string, expectedRevision: string) {
    return await StorageService.deleteEmptyBucketAtRevision(ref, bucketName, expectedRevision);
}

function storageMutationStatus(error: string | undefined): 400 | 404 | 409 | 500 {
    if (error?.startsWith("Invalid ")) return 400;
    if (error === "Bucket not found") return 404;
    return error === "Bucket already exists"
        || error === "Bucket is not empty"
        || error === "Bucket revision conflict"
        ? 409
        : 500;
}

// ── Storage Routes ────────────────────────────────────────────────
export const storageRoutes = new Elysia({ prefix: "/v1/storage" })
    .get('/status', async () => {
        return await StorageService.getStatus();
    }, { detail: { tags: ["storage"], summary: "Get storage service status" } })
    .get('/:ref/buckets', async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        return await listLegacyStorageBuckets(params.ref);
    }, { detail: { tags: ["storage"], summary: "List storage buckets for a project" } })
    .post('/:ref/buckets', async ({ params, body, set, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        const { bucketName, storageResult } = await createStorageBucket(params.ref, body);
        if (!storageResult.success) {
            set.status = storageMutationStatus(storageResult.error);
            return { message: storageResult.error || "Failed to create bucket", code: String(set.status) };
        }
        return { id: bucketName, name: bucketName, public: body.public || false };
    }, {
        body: StorageBucketCreateBody,
        detail: { tags: ["storage"], summary: "Create a storage bucket for a project" },
    })
    .get('/:ref/buckets/:name/files', async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        return await StorageService.listFiles(params.ref, params.name);
    }, { detail: { tags: ["storage"], summary: "List files in a storage bucket" } })
    .get('/:ref/buckets/:name/files/public-url', async ({ params, query, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

        const objectPath = normalizeObjectPath(query.path);
        if (!objectPath) return status(400, { message: "Invalid object path", code: "400" });

        const bucket = await StorageRLS.getLogicalBucket(params.ref, params.name, undefined, true);
        if (!bucket) return status(404, { message: "Bucket not found", code: "404" });
        if (bucket.public !== true) {
            return status(409, { message: "Bucket must be public before copying a public URL", code: "409" });
        }

        return { public_url: buildPublicObjectUrl(request, params.ref, params.name, objectPath) };
    }, {
        query: t.Object({ path: t.String() }),
        detail: { tags: ["storage"], summary: "Get a public URL for a file in a public bucket" },
    })
    .get('/:ref/buckets/:name/files/content', async ({ params, query, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

        const objectPath = normalizeObjectPath(query.path);
        if (!objectPath) return status(400, { message: "Invalid object path", code: "400" });
        const response = await StorageService.getDownloadResponse(params.ref, params.name, objectPath);
        if (!response) return status(404, { message: "File not found", code: "404" });
        return response;
    }, {
        query: t.Object({ path: t.String() }),
        detail: { tags: ["storage"], summary: "Download or preview a storage file" },
    })
    .delete('/:ref/buckets/:name/files/content', async ({ params, query, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

        const objectPath = normalizeObjectPath(query.path);
        if (!objectPath) return status(400, { message: "Invalid object path", code: "400" });
        const success = await StorageService.deleteFile(params.ref, params.name, objectPath);
        if (!success) return status(500, { message: "Delete failed", code: "500" });
        return { success: true };
    }, {
        query: t.Object({ path: t.String() }),
        detail: { tags: ["storage"], summary: "Delete a storage file" },
    })
    .post('/:ref/buckets/:name/upload', async ({ params, body, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
        const file = body.file;
        if (!file) return status(400, { message: 'No file provided', code: '400' });
        const targetPath = typeof body.path === 'string' && body.path.trim().length > 0
            ? body.path.replace(/^\/+/, '')
            : file.name;
        if (!targetPath) return status(400, { message: 'No file path provided', code: '400' });
        const fileData = typeof file.stream === 'function' ? file.stream() : file;
        const success = await StorageService.uploadFile(
            params.ref,
            params.name,
            targetPath,
            fileData,
            file.type || 'application/octet-stream',
        );
        if (!success) return status(500, { message: 'Failed to upload file', code: '500' });
        return { success: true, message: 'File uploaded successfully' };
    }, {
        body: t.Object({
            file: t.File(),
            path: t.Optional(t.String()),
        }),
        response: {
            200: SuccessResponse,
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
            500: ErrorResponse,
        },
        detail: { tags: ["storage"], summary: "Upload a file to a storage bucket" },
    })
    .delete('/:ref/buckets/:name/files/:filename', async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });
        const success = await StorageService.deleteFile(params.ref, params.name, params.filename);
        if (!success) return status(500, { message: 'Failed to delete file', code: '500' });
        return { success: true, message: 'File deleted successfully' };
    }, {
        response: {
            200: SuccessResponse,
            401: ErrorResponse,
            403: ErrorResponse,
            500: ErrorResponse,
        },
        detail: { tags: ["storage"], summary: "Delete a file from a storage bucket" },
    })
    .post('/migrate', async ({ body, request, set }) => {
        const authError = await requireAdminAuth(request);
        if (authError) {
            set.status = authError.status;
            return { message: authError.body.error, code: String(authError.status) };
        }
        if (!body.s3Url || !body.credentials) return status(400, { message: 'Missing migration parameters', code: '400' });
        return await StorageService.startMigration(body.s3Url, body.credentials);
    }, {
        body: t.Object({
            s3Url: t.String(),
            credentials: t.Object({
                access_key: t.String(),
                secret_key: t.String(),
                endpoint: t.String(),
            }),
        }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
        },
        detail: { tags: ["storage"], summary: "Start a storage migration job" },
    })
    .get('/migrate/:jobId', async ({ params, request, set }) => {
        const authError = await requireAdminAuth(request);
        if (authError) {
            set.status = authError.status;
            return { message: authError.body.error, code: String(authError.status) };
        }
        const jobId = params.jobId;
        const job = migrationJobs.get(jobId);
        
        if (!job) {
            set.status = 404;
            return { message: 'Migration job not found', code: '404' };
        }
        
        return {
            id: job.id,
            status: job.status,
            progress: job.progress,
            logs: job.logs,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt
        };
    }, {
        params: t.Object({
            jobId: t.String()
        }),
        response: {
            200: t.Object({
                id: t.String(),
                status: t.String(),
                progress: t.Number(),
                logs: t.Array(t.String()),
                createdAt: t.Any(),
                updatedAt: t.Any()
            }),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse
        },
        detail: { tags: ["storage"], summary: "Get storage migration job status" },
    })

    // ── Supabase-compatible Image Transform (via imaginary) ──────
    // Matches: GET /v1/storage/:ref/render/image/public/:bucket/*
    // This is the exact pattern that supabase-js SDK sends for .download(path, { transform })
    .get('/:ref/render/image/public/:bucket/*', async ({ params, query, request, set }) => {
        const bucket = params.bucket;
        const path = params['*'];
        if (!path) return status(400, { message: 'Missing file path', code: '400' });
        const authError = await ensureImageTransformAccess(request, params.ref, bucket);
        if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

        let sourceUrl: string;
        try {
            sourceUrl = buildSourceUrl(bucket, path);
        } catch {
            return status(400, { message: 'Invalid source path', code: '400' });
        }

        // ── Map Supabase transform params → imaginary params ──
        const imaginaryParams = new URLSearchParams();
        imaginaryParams.set('url', sourceUrl);

        // width / height (Supabase standard)
        if (query.width)  imaginaryParams.set('width',  String(query.width));
        if (query.height) imaginaryParams.set('height', String(query.height));

        // quality (Supabase standard, default 80)
        imaginaryParams.set('quality', String(query.quality || 80));

        // format / type (Supabase sends `format`, imaginary uses `type`)
        const format = query.format || 'webp';
        imaginaryParams.set('type', format);

        // resize mode (Supabase sends `resize`: cover / contain / fill)
        // imaginary supports: crop (cover), embed (contain), stretch (fill)
        const resizeMode = query.resize || 'cover';

        // Determine which imaginary operation to call
        let operation = 'resize';
        if (resizeMode === 'cover' || resizeMode === 'crop') {
            operation = 'crop';
            imaginaryParams.set('nocrop', 'false');
        } else if (resizeMode === 'contain' || resizeMode === 'embed') {
            operation = 'embed';
        } else if (resizeMode === 'fill') {
            operation = 'enlarge';
            imaginaryParams.set('force', 'true');
        }

        const imaginaryUrl = `${IMAGINARY_URL}/${operation}?${imaginaryParams.toString()}`;

        try {
            const res = await fetch(imaginaryUrl);
            if (!res.ok) {
                const errText = await res.text();
                logger.error(`Imaginary ${operation} failed:`, { status: res.status, error: errText });
                return status(502, { message: 'Image transform failed: ${errText}', code: '502' });
            }

            // Stream the processed image back to client with caching headers
            set.headers['Content-Type'] = res.headers.get('Content-Type') || `image/${format}`;
            set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
            set.headers['X-Image-Engine'] = 'imaginary/libvips';
            return new Response(res.body, { headers: set.headers as unknown as HeadersInit });
        } catch (err: unknown) {
            logger.error('Image transform proxy error:', { error: err instanceof Error ? err.message : String(err) });
            return status(502, { message: 'Image processing service unavailable', code: '502' });
        }
    }, { detail: { tags: ["storage"], summary: "Render a public image with transforms" } })

    // ── Enhanced imaginary Features (beyond Supabase standard) ───
    // These routes expose imaginary's unique superpowers that imgproxy Pro charges for.

    // Smart Crop: intelligent focus-point detection
    // GET /v1/storage/:ref/transform/smartcrop/:bucket/*?width=300&height=300
    .get('/:ref/transform/smartcrop/:bucket/*', async ({ params, query, request, set }) => {
        const path = params['*'];
        if (!path) return status(400, { message: 'Missing file path', code: '400' });
        const authError = await ensureImageTransformAccess(request, params.ref, params.bucket);
        if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

        let sourceUrl: string;
        try {
            sourceUrl = buildSourceUrl(params.bucket, path);
        } catch {
            return status(400, { message: 'Invalid source path', code: '400' });
        }
        const p = new URLSearchParams({
            url: sourceUrl,
            width:   String(query.width  || 300),
            height:  String(query.height || 300),
            quality: String(query.quality || 80),
            type:    query.format || 'webp',
        });

        try {
            const res = await fetch(`${IMAGINARY_URL}/smartcrop?${p.toString()}`);
            if (!res.ok) return status(502, { message: await res.text(), code: '502' });
            set.headers['Content-Type'] = res.headers.get('Content-Type') || 'image/webp';
            set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
            return new Response(res.body, { headers: set.headers as unknown as HeadersInit });
        } catch (err: unknown) {
            return status(502, { message: 'Smartcrop service unavailable', code: '502' });
        }
    }, { detail: { tags: ["storage"], summary: "Smart crop an image with focus detection" } })

    // Watermark: overlay text or image watermark
    // GET /v1/storage/:ref/transform/watermark/:bucket/*?text=ACME&font=sans&opacity=0.5
    .get('/:ref/transform/watermark/:bucket/*', async ({ params, query, request, set }) => {
        const path = params['*'];
        if (!path) return status(400, { message: 'Missing file path', code: '400' });
        const authError = await ensureImageTransformAccess(request, params.ref, params.bucket);
        if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

        let sourceUrl: string;
        try {
            sourceUrl = buildSourceUrl(params.bucket, path);
        } catch {
            return status(400, { message: 'Invalid source path', code: '400' });
        }
        const p = new URLSearchParams({
            url: sourceUrl,
            text:      query.text   || 'SupaCloud',
            font:      query.font   || 'sans bold 14',
            opacity:   String(query.opacity || 0.3),
            textwidth: String(query.textwidth || 200),
            quality:   String(query.quality || 85),
            type:      query.format || 'webp',
        });
        if (query.width)  p.set('width',  String(query.width));
        if (query.height) p.set('height', String(query.height));

        try {
            const res = await fetch(`${IMAGINARY_URL}/watermark?${p.toString()}`);
            if (!res.ok) return status(502, { message: await res.text(), code: '502' });
            set.headers['Content-Type'] = res.headers.get('Content-Type') || 'image/webp';
            set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
            return new Response(res.body, { headers: set.headers as unknown as HeadersInit });
        } catch (err: unknown) {
            return status(502, { message: 'Watermark service unavailable', code: '502' });
        }
    }, { detail: { tags: ["storage"], summary: "Apply watermark to an image" } })

    // Blur: apply gaussian blur (useful for placeholder images / LQIP)
    // GET /v1/storage/:ref/transform/blur/:bucket/*?sigma=10&width=20
    .get('/:ref/transform/blur/:bucket/*', async ({ params, query, request, set }) => {
        const path = params['*'];
        if (!path) return status(400, { message: 'Missing file path', code: '400' });
        const authError = await ensureImageTransformAccess(request, params.ref, params.bucket);
        if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

        let sourceUrl: string;
        try {
            sourceUrl = buildSourceUrl(params.bucket, path);
        } catch {
            return status(400, { message: 'Invalid source path', code: '400' });
        }
        const p = new URLSearchParams({
            url: sourceUrl,
            sigma:   String(query.sigma || 10),
            quality: String(query.quality || 60),
            type:    query.format || 'webp',
        });
        if (query.width)  p.set('width',  String(query.width));
        if (query.height) p.set('height', String(query.height));

        try {
            const res = await fetch(`${IMAGINARY_URL}/blur?${p.toString()}`);
            if (!res.ok) return status(502, { message: await res.text(), code: '502' });
            set.headers['Content-Type'] = res.headers.get('Content-Type') || 'image/webp';
            set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
            return new Response(res.body, { headers: set.headers as unknown as HeadersInit });
        } catch (err: unknown) {
            return status(502, { message: 'Blur service unavailable', code: '502' });
        }
    }, { detail: { tags: ["storage"], summary: "Apply gaussian blur to an image" } })

    // Image Info: extract metadata (dimensions, EXIF, color space) without downloading full image
    // GET /v1/storage/:ref/transform/info/:bucket/*
    .get('/:ref/transform/info/:bucket/*', async ({ params, request }) => {
        const path = params['*'];
        if (!path) return status(400, { message: 'Missing file path', code: '400' });
        const authError = await ensureImageTransformAccess(request, params.ref, params.bucket);
        if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

        let sourceUrl: string;
        try {
            sourceUrl = buildSourceUrl(params.bucket, path);
        } catch {
            return status(400, { message: 'Invalid source path', code: '400' });
        }
        const p = new URLSearchParams({ url: sourceUrl });

        try {
            const res = await fetch(`${IMAGINARY_URL}/info?${p.toString()}`);
            if (!res.ok) return status(502, { message: await res.text(), code: '502' });
            return res.json();
        } catch (err: unknown) {
            return status(502, { message: 'Image info service unavailable', code: '502' });
        }
    }, { detail: { tags: ["storage"], summary: "Get image metadata and dimensions" } })

    // Thumbnail: generate a small, fast thumbnail (great for file browsers / galleries)
    // GET /v1/storage/:ref/transform/thumbnail/:bucket/*?width=150
    .get('/:ref/transform/thumbnail/:bucket/*', async ({ params, query, request, set }) => {
        const path = params['*'];
        if (!path) return status(400, { message: 'Missing file path', code: '400' });
        const authError = await ensureImageTransformAccess(request, params.ref, params.bucket);
        if (authError) return status(authError.status as 401 | 403, { message: authError.body.error, code: String(authError.status) });

        let sourceUrl: string;
        try {
            sourceUrl = buildSourceUrl(params.bucket, path);
        } catch {
            return status(400, { message: 'Invalid source path', code: '400' });
        }
        const p = new URLSearchParams({
            url: sourceUrl,
            width:   String(query.width  || 150),
            quality: String(query.quality || 70),
            type:    query.format || 'webp',
        });

        try {
            const res = await fetch(`${IMAGINARY_URL}/thumbnail?${p.toString()}`);
            if (!res.ok) return status(502, { message: await res.text(), code: '502' });
            set.headers['Content-Type'] = res.headers.get('Content-Type') || 'image/webp';
            set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
            return new Response(res.body, { headers: set.headers as unknown as HeadersInit });
        } catch (err: unknown) {
            return status(502, { message: 'Thumbnail service unavailable', code: '502' });
        }
    }, { detail: { tags: ["storage"], summary: "Generate a thumbnail for an image" } })

    // Health check for imaginary service
    .get('/imaginary/health', async () => {
        try {
            const res = await fetch(`${IMAGINARY_URL}/health`);
            if (!res.ok) return { status: 'unhealthy', statusCode: res.status };
            return { status: 'healthy', engine: 'imaginary/libvips' };
        } catch (err: unknown) {
            logger.warn(`[Storage] Imaginary service health check failed: ${(err as Error).message}`);
            return { status: 'unreachable', message: 'Cannot connect to imaginary service' };
        }
    }, { detail: { tags: ["storage"], summary: "Check imaginary image service health" } });

export const projectStorageRoutes = new Elysia({ prefix: "/v1/projects/:ref/storage" })
    .get('/buckets', async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        return await listStorageBuckets(params.ref);
    }, {
        params: StorageProjectParams,
        detail: { tags: ["storage"], summary: "List project storage buckets" },
    })
    .post('/buckets', async ({ params, body, set, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        const { bucketName, storageResult } = await createStorageBucket(params.ref, body);
        if (!storageResult.success) {
            set.status = storageMutationStatus(storageResult.error);
            return { message: storageResult.error || "Failed to create bucket", code: String(set.status) };
        }
        return { id: bucketName, name: bucketName, public: body.public || false };
    }, {
        params: StorageProjectParams,
        body: StorageBucketCreateBody,
        detail: { tags: ["storage"], summary: "Create a storage bucket" },
    })
    .get('/buckets/:id', async ({ params, set, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        const buckets = await listStorageBuckets(params.ref);
        const bucket = (buckets as Array<Record<string, unknown>>).find((b: Record<string, unknown>) => b.id === params.id || b.name === params.id);
        if (!bucket) {
            set.status = 404;
            return { message: "Bucket not found", code: "404" };
        }
        return bucket;
    }, {
        params: StorageBucketParams,
        detail: { tags: ["storage"], summary: "Get a storage bucket by ID" },
    })
    .put('/buckets/:id', async ({ params, body, set, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        const result = await StorageService.updateBucket(params.ref, params.id, {
            public: body.public,
            file_size_limit: body.file_size_limit,
            allowed_mime_types: body.allowed_mime_types,
        }, body.expected_revision);

        if (!result.success) {
            set.status = result.error === "Bucket not found" ? 404 : storageMutationStatus(result.error);
            return { message: result.error || "Failed to update bucket", code: String(set.status) };
        }

        return {
            ...result.bucket,
            previous_revision: result.previousRevision,
            new_revision: result.newRevision,
        };
    }, {
        params: StorageBucketParams,
        body: StorageBucketUpdateBody,
        detail: { tags: ["storage"], summary: "Update a storage bucket" },
    })
    .post('/vector/:operation', async ({ params, body, request, set }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        try {
            const result = await runProjectVectorOperation(
                params.ref,
                params.operation,
                (body && typeof body === 'object' ? body : {}) as Record<string, unknown>,
            );
            if (result === undefined) {
                set.status = 200;
                return '';
            }
            return result;
        } catch (error: unknown) {
            if (error instanceof StorageVectorError) {
                return status(error.statusCode, {
                    statusCode: String(error.statusCode),
                    error: error.code,
                    message: error.message,
                });
            }
            logger.error('[Storage] Project vector operation failed', {
                ref: params.ref,
                operation: params.operation,
                error: error instanceof Error ? error.message : String(error),
            });
            return status(500, { statusCode: "500", error: "InternalError", message: "Vector storage operation failed" });
        }
    }, { detail: { tags: ["storage", "vector"], summary: "Manage project vector storage" } })
    .delete('/buckets/:id', async ({ params, query, set, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        const result = await deleteStorageBucket(params.ref, params.id, query.expected_revision);
        if (!result.success) {
            set.status = storageMutationStatus(result.error);
            return { message: result.error || "Failed to delete bucket", code: String(set.status) };
        }
        return {
            id: params.id,
            deleted: true,
            require_empty: true,
            previous_revision: result.previousRevision,
            new_revision: null,
        };
    }, {
        params: StorageBucketParams,
        query: StorageBucketDeleteQuery,
        detail: { tags: ["storage"], summary: "Delete a storage bucket" },
    });
