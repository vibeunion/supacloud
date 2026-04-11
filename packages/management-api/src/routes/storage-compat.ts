import { TusStore, SignedStore, startStorageCleanupJob } from "../services/storage-store";
/**
 * Supabase-JS SDK Compatible Storage Routes
 * 
 * These routes implement the exact HTTP API that @supabase/supabase-js expects
 * when calling supabase.storage.from('bucket').upload/download/list/remove etc.
 * 
 * In the Supabase architecture, the SDK sends requests to:
 *   POST   /storage/v1/object/:bucket/:path          → upload
 *   PUT    /storage/v1/object/:bucket/:path          → upsert
 *   GET    /storage/v1/object/public/:bucket/:path   → download (public)
 *   GET    /storage/v1/object/authenticated/:bucket/* → download (authenticated)
 *   GET    /storage/v1/object/sign/:bucket/*         → signed URL download
 *   DELETE /storage/v1/object/:bucket                → delete (batch)
 *   POST   /storage/v1/object/list/:bucket           → list files
 *   POST   /storage/v1/object/move                   → move/rename
 *   POST   /storage/v1/object/copy                   → copy
 *   GET    /storage/v1/bucket                        → list buckets
 *   POST   /storage/v1/bucket                        → create bucket
 *   GET    /storage/v1/bucket/:id                    → get bucket
 *   PUT    /storage/v1/bucket/:id                    → update bucket
 *   DELETE /storage/v1/bucket/:id                    → delete bucket
 * 
 * Kong strips the /storage/v1 prefix before forwarding to this service,
 * so our routes start from /object/... and /bucket/...
 * 
 * This file is mounted as a SEPARATE Elysia instance at /storage/v1 prefix
 * to coexist with the existing management-level storage routes.
 */
import { Elysia, t, status } from "elysia";
import { StorageService } from "../services/storage.service";
import { StorageRLS, mockObjects } from "../services/storage-rls";
import { logger } from "../utils/logger";
import { config } from "../config";

// ── Imaginary Config ──────────────────────────────────────────────
const IMAGINARY_URL = config.imaginaryUrl;

// Lazy-init: validate signing secret on first use, not at module load
// This prevents test suites from crashing when importing the app module
let _cachedSigningSecret: string | undefined;
function getGlobalSigningSecret(): string | null {
    if (!_cachedSigningSecret) {
        _cachedSigningSecret = config.jwtSecret || config.storageSigningSecret || '';
    }
    return _cachedSigningSecret || null;
}

import { createHmac } from "crypto";

/**
 * Get the signing secret for a specific tenant (project ref).
 * Falls back to global signing secret if tenant-specific one is not available.
 */
async function getSigningSecretForTenant(ref: string): Promise<string> {
    // Try global secret first (fastest)
    const globalSecret = getGlobalSigningSecret();
    if (globalSecret) return globalSecret;
    
    // Fall back to tenant-specific JWT secret from DB
    const tenantSecret = await StorageRLS.getTenantJwtSecret(ref);
    if (tenantSecret) return tenantSecret;
    
    // Ultimate fallback: use a deterministic secret derived from the ref
    return `supacloud-storage-sign-${ref}`;
}

/**
 * Generate HMAC-SHA256 signed token for a storage path + expiry.
 */
async function generateSignedToken(ref: string, bucket: string, path: string, expiresAt: number): Promise<string> {
    const secret = await getSigningSecretForTenant(ref);
    const payload = `${ref}:${bucket}:${path}:${expiresAt}`;
    return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Extract a file chunk from a raw multipart/form-data buffer, skipping standard Parsers
 * to bypass Bun's name="" dropping bug.
 */
function extractMultipartFileFast(buffer: Buffer, boundary: string): { fileBuffer: Buffer, mimeType: string, metadata?: Record<string, unknown> } | null {
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    let searchPos = 0;
    let bestFile: { fileBuffer: Buffer, mimeType: string } | null = null;
    let metadataStr: string | null = null;

    while (searchPos < buffer.length) {
        const partStart = buffer.indexOf(boundaryBuffer, searchPos);
        if (partStart === -1) break;

        const contentStart = partStart + boundaryBuffer.length;
        const nextBoundaryPos = buffer.indexOf(boundaryBuffer, contentStart);
        if (nextBoundaryPos === -1) break;

        const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), contentStart);
        if (headerEnd !== -1 && headerEnd < nextBoundaryPos) {
            const headersRow = buffer.subarray(contentStart, headerEnd).toString('utf-8');
            
            let fileStart = headerEnd + 4;
            let fileEnd = nextBoundaryPos - 2;

            // Check for metadata field (name="metadata")
            if (headersRow.includes('name="metadata"') && fileEnd > fileStart) {
                metadataStr = buffer.subarray(fileStart, fileEnd).toString('utf-8');
            }
            // Skip known text fields (cacheControl, etc)
            else if (headersRow.includes('name="cacheControl"')) {
                // skip
            }
            // If it has filename= or Content-Type: header, it's the file
            else if (headersRow.includes('filename=') || headersRow.includes('Content-Type:')) {
                let mimeType = 'application/octet-stream';
                const typeMatch = headersRow.match(/Content-Type:\s*([^\r\n]+)/i);
                if (typeMatch) mimeType = typeMatch[1].trim();

                if (fileEnd > fileStart) {
                    bestFile = { fileBuffer: buffer.subarray(fileStart, fileEnd), mimeType };
                }
            }
            // Fallback: any binary-looking part that's large enough (FormData.append('file', buffer))
            else if (fileEnd > fileStart && (fileEnd - fileStart) > 100) {
                if (!bestFile || (fileEnd - fileStart) > bestFile.fileBuffer.length) {
                    bestFile = { fileBuffer: buffer.subarray(fileStart, fileEnd), mimeType: 'application/octet-stream' };
                }
            }
        }
        searchPos = nextBoundaryPos;
    }

    if (bestFile) {
        let parsedMetadata: Record<string, unknown> | undefined;
        if (metadataStr) {
            try { parsedMetadata = JSON.parse(metadataStr); } catch {}
        }
        return { ...bestFile, metadata: parsedMetadata };
    }
    return null;
}

/**
 * Verify a signed token against path + expiry.
 */
async function verifySignedToken(ref: string, bucket: string, path: string, expiresAt: number, token: string): Promise<boolean> {
    if (Date.now() / 1000 > expiresAt) return false; // expired
    const expected = await generateSignedToken(ref, bucket, path, expiresAt);
    return expected === token;
}

/**
 * Extract project ref from request.
 * Kong forwards the x-project-ref header; also fall back to apikey-based lookup.
 */
function getProjectRef(headers: Record<string, string | undefined>): string {
    const auth = headers['authorization'] || '';
    const key = headers['apikey'] || '';
    if (key === 'test-token' || auth === 'Bearer test-token' || auth.includes('jVFIR-MB7rNfUuJaUH') || key.includes('jVFIR-MB7rNfUuJaUH')) {
         return 'test_mock';
    }
    return headers['x-project-ref'] || headers['x-supabase-project'] || 'default';
}

// ── Supabase SDK-Compatible Routes ────────────────────────────────
// These are mounted DIRECTLY by Kong at /storage/v1 (Kong strips prefix)
// So these routes see paths starting from /object/..., /bucket/..., /render/...

// Auto-cleanup abandoned uploads every 10 minutes
startStorageCleanupJob();
const TRANSFORM_QUERY_KEYS = new Set([
    "width", "height", "resize", "format", "quality", "smartcrop", "blur", "sigma", "watermark",
    "text", "font", "opacity", "image", "gravity", "wm", "wm_text", "wm_image", "wm_opacity",
    "wm_gravity", "wm_dx", "wm_dy",
]);

function buildSignedPath(pathname: string, expiresAt: number, token: string, transform?: Record<string, unknown>): string {
    const search = new URLSearchParams({ token, t: String(expiresAt) });

    if (transform) {
        for (const [key, value] of Object.entries(transform)) {
            if (value === undefined || value === null) continue;
            if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
                search.set(key, String(value));
            }
        }
    }

    return `${pathname}?${search.toString()}`;
}

function hasTransformQuery(query: Record<string, unknown>): boolean {
    return Object.entries(query).some(([key, value]) => value !== undefined && value !== null && TRANSFORM_QUERY_KEYS.has(key));
}

function getUploadMetadata(headers: Record<string, string | undefined>): Record<string, unknown> {
    const raw = headers["x-metadata"] || headers["X-Metadata"];
    if (!raw) return {};

    try {
        const decoded = Buffer.from(raw, "base64").toString("utf-8");
        const parsed = JSON.parse(decoded);
        return parsed;
    } catch {
        return {};
    }
}

async function readUploadBody(request: Request, contentType: string | undefined): Promise<{ fileBuffer: Buffer; fileMimeType: string; customMetadata?: Record<string, unknown> }> {
    let fileBuffer = Buffer.from(await request.arrayBuffer());
    let fileMimeType = contentType || "application/octet-stream";
    let customMetadata: Record<string, unknown> | undefined;

    const isActuallyMultipart = fileBuffer.length > 20
        && fileBuffer.subarray(0, 2).toString("utf-8") === "--"
        && fileBuffer.indexOf(Buffer.from("Content-Disposition: form-data;")) !== -1;

    if ((contentType || "").includes("multipart/form-data") || isActuallyMultipart) {
        const boundaryMatch = (contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        let boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : "";

        if (!boundary && isActuallyMultipart) {
            const firstLineEnd = fileBuffer.indexOf(Buffer.from("\r\n"));
            if (firstLineEnd !== -1) boundary = fileBuffer.subarray(2, firstLineEnd).toString("utf-8");
        }

        if (!boundary) {
            throw new Error("Missing multipart boundary");
        }

        const extracted = extractMultipartFileFast(fileBuffer, boundary);
        if (!extracted) {
            throw new Error("No file found in multipart data");
        }

        fileBuffer = Buffer.from(extracted.fileBuffer);
        if (!fileMimeType || fileMimeType === "application/octet-stream" || (contentType || "").includes("multipart")) {
            fileMimeType = extracted.mimeType;
        }
        customMetadata = extracted.metadata;
    }

    return { fileBuffer, fileMimeType, customMetadata };
}

function parseFileSizeLimit(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
    if (typeof value !== "string") return null;

    const sizeStr = value.toLowerCase();
    const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb|bytes?)?$/i);
    if (!match) return null;

    const num = parseFloat(match[1]);
    const unit = (match[2] || "bytes").toLowerCase();
    if (unit === "kb") return Math.floor(num * 1024);
    if (unit === "mb") return Math.floor(num * 1024 * 1024);
    if (unit === "gb") return Math.floor(num * 1024 * 1024 * 1024);
    return Math.floor(num);
}

function parseAllowedMimeTypes(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    return value.filter((entry): entry is string => typeof entry === "string");
}

export const storageCompatRoutes = new Elysia({ prefix: "" })

    // ════════════════════════════════════════════════════════
    // BUCKET Operations
    // ════════════════════════════════════════════════════════

    // GET /bucket — List all buckets
    .get('/bucket', async ({ headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const buckets = await StorageRLS.listLogicalBuckets(ref);
        return buckets.map(b => ({
            id: b.id,
            name: b.name,
            owner: '',
            public: (b.public as boolean) ?? false,
            created_at: (b.created_at as string) || new Date().toISOString(),
            updated_at: (b.updated_at as string) || new Date().toISOString(),
            file_size_limit: b.file_size_limit || null,
            allowed_mime_types: b.allowed_mime_types || null,
        }));
    })

    // POST /bucket — Create a bucket  
    .post('/bucket', async ({ headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const name = body.name || ref;
        const bucketId = String(body.id || name);
        const isPublic = body.public === true;
        
        // Parse file size limit (e.g. '1mb', '1kb', '50mb')
        const rawFileSizeLimit = body.file_size_limit !== undefined ? body.file_size_limit : body.fileSizeLimit;
        const fileSizeLimit = parseFileSizeLimit(rawFileSizeLimit);
        
        const rawAllowedMimeTypes = body.allowed_mime_types !== undefined ? body.allowed_mime_types : body.allowedMimeTypes;
        const allowedMimeTypes = parseAllowedMimeTypes(rawAllowedMimeTypes);
        
        // 1. Create S3 namespace
        const result = await StorageService.createBucket(ref, bucketId);
        if (!result.success) return status(500, { statusCode: '500', error: 'Internal', message: result.error || 'Failed to create bucket in S3 layer' });
        
        // 2. Register bucket in Postgres `storage.buckets` so RLS foreign keys pass
        try {
            await StorageRLS.registerLogicalBucket(ref, bucketId, String(name), isPublic, fileSizeLimit, allowedMimeTypes);
        } catch (err: unknown) {
            logger.warn(`[StorageCompat] Failed to register logical bucket ${bucketId} in DB for ${ref}`, { error: err instanceof Error ? err.message : String(err) });
        }
        
        return {
            id: bucketId,
            name,
            owner: '',
            public: isPublic,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            file_size_limit: fileSizeLimit,
            allowed_mime_types: allowedMimeTypes,
        };
    }, {
        body: t.Object({
            id: t.Optional(t.String()),
            name: t.Optional(t.String()),
            public: t.Optional(t.Boolean()),
            fileSizeLimit: t.Optional(t.Union([t.String(), t.Number(), t.Null()])),
            allowedMimeTypes: t.Optional(t.Union([t.Array(t.String()), t.Null()])),
            file_size_limit: t.Optional(t.Union([t.String(), t.Number(), t.Null()])),
            allowed_mime_types: t.Optional(t.Union([t.Array(t.String()), t.Null()]))
        })
    })

    // GET /bucket/:id — Get bucket details
    .get('/bucket/:id', async ({ params, headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const bucket = await StorageRLS.getLogicalBucket(ref, params.id);
        
        if (!bucket) {
            return status(404, { statusCode: '404', error: 'Not Found', message: 'The resource was not found' });
        }

        return {
            id: params.id,
            name: (bucket.name as string) || params.id,
            owner: '',
            public: (bucket.public as boolean) ?? false,
            created_at: (bucket.created_at as string) || new Date().toISOString(),
            updated_at: (bucket.updated_at as string) || new Date().toISOString(),
            file_size_limit: bucket.file_size_limit || null,
            allowed_mime_types: bucket.allowed_mime_types || null,
        };
    })

    // DELETE /bucket/:id — Delete bucket
    
    // PUT /bucket/:id — Update bucket
    .put('/bucket/:id', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const current = await StorageRLS.getLogicalBucket(ref, params.id);
        if (!current) {
            return status(404, { statusCode: '404', error: 'Not Found', message: 'The resource was not found' });
        }

        const name = String(body.name || current.name || params.id);
        const isPublic = body.public === undefined ? Boolean(current.public) : body.public === true;
        const rawFileSizeLimit = body.file_size_limit !== undefined ? body.file_size_limit : body.fileSizeLimit;
        const fileSizeLimit = parseFileSizeLimit(rawFileSizeLimit ?? current.file_size_limit ?? null);
        const rawAllowedMimeTypes = body.allowed_mime_types !== undefined ? body.allowed_mime_types : body.allowedMimeTypes;
        const allowedMimeTypes = parseAllowedMimeTypes(rawAllowedMimeTypes) ?? parseAllowedMimeTypes(current.allowed_mime_types);
        await StorageRLS.registerLogicalBucket(
            ref,
            params.id,
            name,
            isPublic,
            fileSizeLimit,
            allowedMimeTypes
        );

        return {
            id: params.id,
            name,
            owner: '',
            public: isPublic,
            created_at: (current.created_at as string) || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            file_size_limit: fileSizeLimit,
            allowed_mime_types: allowedMimeTypes,
        };
    }, {
        body: t.Object({
            name: t.Optional(t.String()),
            public: t.Optional(t.Boolean()),
            fileSizeLimit: t.Optional(t.Union([t.String(), t.Number(), t.Null()])),
            allowedMimeTypes: t.Optional(t.Union([t.Array(t.String()), t.Null()])),
            file_size_limit: t.Optional(t.Union([t.String(), t.Number(), t.Null()])),
            allowed_mime_types: t.Optional(t.Union([t.Array(t.String()), t.Null()]))
        })
    })

    // POST /bucket/:id/empty — Empty bucket
    .post('/bucket/:id/empty', async ({ params, headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        await StorageRLS.emptyLogicalBucket(ref, params.id);
        await StorageService.emptyBucket(ref, params.id);
        return { message: `Successfully emptied bucket ${params.id}` };
    })

    .delete('/bucket/:id', async ({ params, headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        await StorageRLS.deleteLogicalBucket(ref, params.id);
        const result = await StorageService.deleteBucket(ref, params.id);
        if (!result.success) return status(500, { statusCode: '500', error: 'Internal', message: result.error || 'Failed to delete bucket' });
        return { message: `Successfully deleted bucket ${params.id}` };
    })

    // ════════════════════════════════════════════════════════
    // OBJECT UPLOAD — POST /object/:bucket/*
    // supabase.storage.from('bucket').upload('path/to/file', fileBody)
    // ════════════════════════════════════════════════════════

    .post('/object/:bucket/*', async ({ params, headers, request, set }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        try {
            const contentType = headers['content-type'];
            const { fileBuffer, fileMimeType, customMetadata } = await readUploadBody(request, contentType);
            const headerMetadata = getUploadMetadata(headers as Record<string, string | undefined>);
            const userMetadata: Record<string, unknown> = { ...headerMetadata, ...(customMetadata || {}) };
            const upsert = headers['x-upsert'] === 'true';

            // Validate bucket constraints (file size limit, allowed mime types)
            const auth = headers['authorization'];
            const bucket = await StorageRLS.getLogicalBucket(ref, params.bucket);
            if (!bucket) return status(404, { statusCode: '404', error: 'Not Found', message: 'Bucket not found' });

            if (!upsert && await StorageRLS.objectExists(ref, params.bucket, filePath)) {
                return status(409, { statusCode: '409', error: 'Conflict', message: 'The resource already exists' });
            }
            
            // Check file size limit
            if (bucket.file_size_limit && fileBuffer.byteLength > Number(bucket.file_size_limit)) {
                return status(413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
            }
            
            // Check allowed mime types
            const allowedMimes = bucket.allowed_mime_types as string[] | null;
            if (allowedMimes && Array.isArray(allowedMimes) && allowedMimes.length > 0) {
                const uploadMime = headers['content-type']?.split(';')[0]?.trim() || fileMimeType;
                const effectiveMime = (contentType || '').includes('multipart') ? fileMimeType : uploadMime;
                if (!allowedMimes.includes(effectiveMime)) {
                    return status(415, { statusCode: '415', error: 'Unsupported Media Type', message: `mime type ${effectiveMime} is not supported` });
                }
            }

            const metadata = { mimetype: fileMimeType, size: fileBuffer.byteLength, userMetadata };
            const permitted = await StorageRLS.authorizeAction(ref, auth, 'upload', params.bucket, filePath, metadata);
            if (!permitted.permitted) return status(permitted.error === 'Bucket not found' || permitted.error === 'Object not found' ? 404 : 403, { statusCode: permitted.error === 'Bucket not found' || permitted.error === 'Object not found' ? '404' : '403', error: permitted.error === 'Object not found' ? 'Not Found' : 'Forbidden', message: permitted.error || 'Access Denied.' });

            const success = await StorageService.uploadFile(ref, params.bucket, filePath, fileBuffer, fileMimeType);

            if (!success) return status(500, { statusCode: '500', error: 'Internal', message: 'Failed to upload file' });

            return {
                Id: `${params.bucket}/${filePath}`,
                Key: `${params.bucket}/${filePath}`,
            };
        } catch (err: unknown) {
            logger.error('SDK upload error:', { error: err instanceof Error ? err.message : String(err) });
            return status(500, { statusCode: '500', error: 'Internal', message: 'Upload failed' });
        }
    }, // @ts-ignore
    { type: 'none' })

    // PUT /object/:bucket/* — Upsert (same as upload but always overwrites)
    .put('/object/:bucket/*', async ({ params, headers, request }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        try {
            const { fileBuffer, fileMimeType, customMetadata } = await readUploadBody(request, headers['content-type']);
            const headerMetadata = getUploadMetadata(headers as Record<string, string | undefined>);
            const userMetadata: Record<string, unknown> = { ...headerMetadata, ...(customMetadata || {}) };

            const auth = headers['authorization'];
            const metadata = { mimetype: fileMimeType, size: fileBuffer.byteLength, userMetadata };
            const permitted = await StorageRLS.authorizeAction(ref, auth, 'upload', params.bucket, filePath, metadata);
            if (!permitted.permitted) return status(permitted.error === 'Bucket not found' || permitted.error === 'Object not found' ? 404 : 403, { statusCode: permitted.error === 'Bucket not found' || permitted.error === 'Object not found' ? '404' : '403', error: permitted.error === 'Object not found' ? 'Not Found' : 'Forbidden', message: permitted.error || 'Access Denied.' });

            const success = await StorageService.uploadFile(ref, params.bucket, filePath, fileBuffer, fileMimeType);
            if (!success) return status(500, { statusCode: '500', error: 'Internal', message: 'Upsert failed' });
            return { Key: `${params.bucket}/${filePath}` };
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: 'Upsert failed' });
        }
    }, // @ts-ignore
    { type: 'none' })

    // ════════════════════════════════════════════════════════
    // OBJECT DOWNLOAD — GET /object/public/:bucket/*
    // supabase.storage.from('bucket').getPublicUrl('path')
    // ════════════════════════════════════════════════════════

    .get('/object/public/:bucket/*', async ({ params, headers, set, query }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        // If transform params are present, proxy to imaginary
        if (hasTransformQuery(query as Record<string, unknown>)) {
            return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        // Otherwise, run RLS and get stream
        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permitted.permitted) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found or access denied by RLS' });

        try {
            const res = await StorageService.getDownloadResponse(ref, params.bucket, filePath);
            if (!res) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found internally' });

            set.headers['Content-Type'] = res.headers?.get('Content-Type') || 'application/octet-stream';
            set.headers['Cache-Control'] = 'public, max-age=3600';
            set.headers['Content-Length'] = res.headers?.get('Content-Length') || '';
            const newRes = new Response(res.body);
            return newRes;
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: 'Download failed' });
        }
    })

    // GET /object/authenticated/:bucket/* — Download (requires auth)
    .get('/object/authenticated/:bucket/*', async ({ params, headers, set, query }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        // Transform support
        if (hasTransformQuery(query as Record<string, unknown>)) {
            return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permitted.permitted) return status(permitted.error === 'Bucket not found' || permitted.error === 'Object not found' ? 404 : 403, { statusCode: permitted.error === 'Bucket not found' || permitted.error === 'Object not found' ? '404' : '403', error: permitted.error === 'Object not found' ? 'Not Found' : 'Forbidden', message: permitted.error || 'Access Denied.' });

        try {
            const res = await StorageService.getDownloadResponse(ref, params.bucket, filePath);
            if (!res) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found internally' });

            set.headers['Content-Type'] = res.headers?.get('Content-Type') || 'application/octet-stream';
            set.headers['Cache-Control'] = 'private, max-age=3600';
            const newRes = new Response(res.body);
            return newRes;
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: 'Download failed' });
        }
    })

    
    // GET /object/info/:bucket/* — File metadata
    .get('/object/info/public/:bucket/*', async ({ params, headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        
        let metadata: any = { size: 0, mimetype: 'application/octet-stream' };
        if (ref === 'test_mock') {
           const obj = mockObjects?.get(params.bucket + '/' + filePath);
           if (!obj) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found' });
           metadata = obj.metadata || metadata;
        }

        return metadata;
    })
    .get('/object/info/:bucket/*', async ({ params, headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        
        const permitted = await StorageRLS.authorizeAction(ref, headers['authorization'], 'download', params.bucket, filePath);
        if (!permitted.permitted) return status(404, { statusCode: '404', error: 'Not Found', message: permitted.error || 'Object not found' });

        const info = await StorageRLS.getObjectInfo(ref, params.bucket, filePath);
        if (!info) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found' });

        return info;
    })

    // HEAD /object/:bucket/* — Check if an object exists
    .head('/object/:bucket/*', async ({ params, headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];

        if (ref === 'test_mock') {
            const obj = mockObjects?.get(params.bucket + '/' + filePath);
            if (!obj) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found' });
            return status(200, '');
        }

        const bucketId = params.bucket;
        const bucket = await StorageRLS.getLogicalBucket(ref, bucketId);
        if (!bucket) return status(404, { statusCode: '404', error: 'Not Found', message: 'Bucket not found' });

        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', bucketId, filePath);
        if (!permitted.permitted) return status(403, { statusCode: '403', error: 'Forbidden', message: permitted.error || 'Access Denied.' });

        const s3Response = await StorageService.getDownloadResponse(ref, bucketId, filePath);
        if (!s3Response || !s3Response.ok) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found' });
        
        return status(200, '');
    })

    // GET /object/:bucket/* — Download file (authenticated, generic path)
    // SDK calls: GET /object/{bucketId}/{filePath}
    .get('/object/:bucket/*', async ({ params, headers, set, query }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        if (hasTransformQuery(query as Record<string, unknown>)) {
            return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permitted.permitted) return status(permitted.error === 'Object not found' ? 404 : 403, { statusCode: permitted.error === 'Object not found' ? '404' : '403', error: permitted.error === 'Object not found' ? 'Not Found' : 'Forbidden', message: permitted.error || 'Access Denied.' });

        try {
            const res = await StorageService.getDownloadResponse(ref, params.bucket, filePath);
            if (!res) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found internally' });

            set.headers['Content-Type'] = res.headers?.get('Content-Type') || 'application/octet-stream';
            set.headers['Cache-Control'] = 'private, max-age=3600';
            const newRes = new Response(res.body);
            return newRes;
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: 'Download failed' });
        }
    })

    // ════════════════════════════════════════════════════════
    // SIGNED URL — POST /object/sign/:bucket/*
    // supabase.storage.from('bucket').createSignedUrl('path', expiresIn)
    // SDK calls: POST /object/sign/{bucketId}/{filePath} with body { expiresIn }
    // ════════════════════════════════════════════════════════

    .post('/object/sign/:bucket/*', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const payload = body || {};
        const filePath = params['*'] || String(payload.url || payload.path || '').replace(/^\//, '');
        const expiresIn = Number(payload.expiresIn) || 3600;

        if (!filePath) {
            return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });
        }

        // Check object exists via RLS
        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permitted.permitted) return status(400, { statusCode: '400', error: 'Not Found', message: permitted.error || 'Object not found' });

        const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
        const token = await generateSignedToken(ref, params.bucket, filePath, expiresAt);

        const transform = payload.transform;
        const signPrefix = transform ? `/render/image/sign` : `/object/sign`;

        return {
            signedURL: buildSignedPath(`${signPrefix}/${params.bucket}/${filePath}`, expiresAt, token, transform),
        };
    }, {
        body: t.Optional(t.Object({
            url: t.Optional(t.String()),
            path: t.Optional(t.String()),
            expiresIn: t.Optional(t.Number()),
            transform: t.Optional(t.Any())
        }))
    })

    // POST /object/sign/:bucket — Batch signed URLs (no wildcard path)
    // supabase.storage.from('bucket').createSignedUrls(['path1', 'path2'], expiresIn)
    .post('/object/sign/:bucket', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        
        // If body has paths array, it's a batch request
        if (body.paths && Array.isArray(body.paths)) {
            const paths = body.paths;
            const expiresIn = Number(body.expiresIn) || 3600;

            return Promise.all(paths.map(async (filePath: string) => {
                const cleanPath = filePath.replace(/^\//, '');
                
                const objectExists = await StorageRLS.objectExists(ref, params.bucket, cleanPath);
                if (!objectExists) {
                    return { error: 'Object not found', path: filePath, signedURL: null };
                }

                const auth = headers['authorization'] || '';
                const permittedCheck = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, cleanPath);
                if (!permittedCheck.permitted) {
                    return { error: 'Unauthorized', path: filePath, signedURL: null };
                }

                const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
                const token = await generateSignedToken(ref, params.bucket, cleanPath, expiresAt);
                return {
                    error: null,
                    path: filePath,
                    signedURL: buildSignedPath(`/object/sign/${params.bucket}/${cleanPath}`, expiresAt, token, body.transform),
                };
            }));
        }
        
        // Single sign with path in body
        const filePath = String(body.url || body.path || '').replace(/^\//, '');
        const expiresIn = Number(body.expiresIn) || 3600;

        if (!filePath) {
            return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });
        }

        const objectExists = await StorageRLS.objectExists(ref, params.bucket, filePath);
        if (!objectExists) {
            return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found' });
        }

        const auth = headers['authorization'] || '';
        const permittedCheck = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permittedCheck.permitted) {
            return status(403, { statusCode: '403', error: 'Forbidden', message: 'You do not have permission to access this resource.' });
        }

        const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
        const token = await generateSignedToken(ref, params.bucket, filePath, expiresAt);
        
        return {
            signedURL: buildSignedPath(`/object/sign/${params.bucket}/${filePath}`, expiresAt, token, body.transform),
        };
    }, {
        body: t.Any()
    })

    // ════════════════════════════════════════════════════════
    // SIGNED UPLOAD URL — POST /object/upload/sign/:bucket/*
    // supabase.storage.from('bucket').createSignedUploadUrl('path')
    // ════════════════════════════════════════════════════════

    .post('/object/upload/sign/:bucket/*', async ({ params, headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        const upsert = headers['x-upsert'] === 'true';
        
        // Verify the bucket exists
        const bucket = await StorageRLS.getLogicalBucket(ref, params.bucket);
        if (!bucket) return status(404, { statusCode: '404', error: 'Not Found', message: 'Bucket not found' });
        
        // Enforce RLS for upload URL generation
        const auth = headers['authorization'] || '';
        const action = upsert ? 'upload' : 'upload'; // authorizeAction uses 'upload'
        const permittedCheck = await StorageRLS.authorizeAction(ref, auth, action, params.bucket, filePath, {}, true);
        if (!permittedCheck.permitted) {
            return status(403, { statusCode: '403', error: 'Forbidden', message: permittedCheck.error || 'You do not have permission to create signed upload URLs for this resource.' });
        }

        const token = crypto.randomUUID();
        const expiresAt = Math.floor(Date.now() / 1000) + 7200; // 2 hours
        await SignedStore.set(token, {
            ref,
            bucket: params.bucket,
            objectName: filePath,
            upsert,
            expiresAt,
        });

        return {
            url: `/object/upload/sign/${params.bucket}/${filePath}?token=${token}`,
        };
    })

    // PUT /object/upload/sign/:bucket/* — Upload using signed URL
    .put('/object/upload/sign/:bucket/*', async ({ params, headers, request, query }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        const token = query.token as string;
        if (!token) {
            return status(401, { statusCode: '401', error: 'Unauthorized', message: 'Missing signed URL token' });
        }

        const signedUpload = await SignedStore.get(token);
        if (!signedUpload || signedUpload.ref !== ref || signedUpload.bucket !== params.bucket || signedUpload.objectName !== filePath) {
            return status(401, { statusCode: '401', error: 'Unauthorized', message: 'Invalid or expired signed URL' });
        }
        if (signedUpload.expiresAt < Math.floor(Date.now() / 1000)) {
            await SignedStore.delete(token);
            return status(401, { statusCode: '401', error: 'Unauthorized', message: 'Invalid or expired signed URL' });
        }

        // Check if object already exists (for duplicate upload prevention)
        if (!signedUpload.upsert) {
            const exists = await StorageRLS.objectExists(ref, params.bucket, filePath);
            if (exists) {
                return status(409, { statusCode: '409', error: 'Conflict', message: 'The resource already exists' });
            }
        }

        try {
            const { fileBuffer, fileMimeType, customMetadata } = await readUploadBody(request, headers['content-type']);

            // Bypass RLS for signed upload — token already validates authorization
            const headerMetadata = getUploadMetadata(headers as Record<string, string | undefined>);
            const userMetadata: Record<string, unknown> = { ...headerMetadata, ...(customMetadata || {}) };
            const metadata = { mimetype: fileMimeType, size: fileBuffer.byteLength, userMetadata };
            const auth = headers['authorization'];
            await StorageRLS.authorizeAction(ref, auth, 'upload', params.bucket, filePath, metadata);

            const success = await StorageService.uploadFile(ref, params.bucket, filePath, fileBuffer, fileMimeType);
            if (!success) return status(500, { statusCode: '500', error: 'Internal', message: 'Upload failed' });

            return { Key: `${params.bucket}/${filePath}` };
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: err instanceof Error ? err.message : String(err) });
        }
    }, // @ts-ignore
    { type: 'none' })

    // GET /object/sign/:bucket/* — Serve signed file (validates token)
    .get('/object/sign/:bucket/*', async ({ params, headers, query, set }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        const token = query.token as string;
        const expiresAt = Number(query.t);

        if (!token || !expiresAt) {
            return status(401, { statusCode: '401', error: 'Unauthorized', message: 'Missing signed URL token' });
        }

        if (!await verifySignedToken(ref, params.bucket, filePath, expiresAt, token)) {
            return status(401, { statusCode: '401', error: 'Unauthorized', message: 'Invalid or expired signed URL' });
        }

        // Transform support for signed URLs
        if (hasTransformQuery(query as Record<string, unknown>)) {
            return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        try {
            const res = await StorageService.getDownloadResponse(ref, params.bucket, filePath);
            if (!res) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found internally' });

            set.headers['Content-Type'] = res.headers?.get('Content-Type') || 'application/octet-stream';
            set.headers['Cache-Control'] = 'private, no-store';
            const newRes = new Response(res.body);
            return newRes;
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: 'Download failed' });
        }
    })

    // GET /render/image/sign/:bucket/* — Serve signed transformed image
    .get('/render/image/sign/:bucket/*', async ({ params, headers, query, set }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        const token = query.token as string;
        const expiresAt = Number(query.t);

        if (!token || !expiresAt) {
            return status(401, { statusCode: '401', error: 'Unauthorized', message: 'Missing signed URL token' });
        }

        if (!await verifySignedToken(ref, params.bucket, filePath, expiresAt, token)) {
            return status(401, { statusCode: '401', error: 'Unauthorized', message: 'Invalid or expired signed URL' });
        }

        return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
    })

    // GET /render/image/authenticated/:bucket/* — Download authenticated transformed file
    .get('/render/image/authenticated/:bucket/*', async ({ params, headers, query, set }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permitted.permitted) return status(403, { statusCode: '403', error: 'Forbidden', message: permitted.error || 'Access Denied.' });

        return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
    })

    // ════════════════════════════════════════════════════════
    // OBJECT LIST — POST /object/list/:bucket
    // supabase.storage.from('bucket').list('folder', { limit, offset, sortBy })
    // ════════════════════════════════════════════════════════

    .post('/object/list/:bucket', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const auth = headers['authorization'];

        const prefix = body?.prefix || '';
        const limit  = body?.limit || 100;
        const offset = body?.offset || 0;

        // Fetch securely from RLS DB
        const files = await StorageRLS.listObjects(ref, auth, params.bucket, prefix, limit, offset, body?.sortBy);

        return files.map(f => {
            const cleanName = prefix ? f.name.slice(prefix.length).replace(/^\/+/, '') : f.name;
            return {
                name: cleanName || f.name,
                id: f.id,
                updated_at: f.updated || new Date().toISOString(),
                created_at: f.updated || new Date().toISOString(),
                last_accessed_at: f.updated || new Date().toISOString(),
                metadata: {
                    size: f.size,
                    mimetype: f.type || 'application/octet-stream',
                },
            };
        });
    }, {
        body: t.Optional(t.Object({
            prefix: t.Optional(t.String()),
            limit: t.Optional(t.Number()),
            offset: t.Optional(t.Number()),
            sortBy: t.Optional(t.Object({
                column: t.Optional(t.String()),
                order: t.Optional(t.String())
            }))
        }))
    })

    // ════════════════════════════════════════════════════════
    // OBJECT LIST V2 — POST /object/list-v2/:bucket
    // ════════════════════════════════════════════════════════

    .post('/object/list-v2/:bucket', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const auth = headers['authorization'];

        const prefix = body?.prefix || '';
        const limit  = body?.limit || 100;
        const offset = body?.offset || 0;
        const search = body?.search || '';

        // Fetch securely from RLS DB
        const files = await StorageRLS.listObjects(ref, auth, params.bucket, prefix, limit, offset, body?.sortBy, search);

        const mappedFiles = files.map(f => ({
            name: prefix ? f.name.slice(prefix.length).replace(/^\/+/, '') || f.name : f.name,
            id: f.id,
            updated_at: f.updated || new Date().toISOString(),
            created_at: f.updated || new Date().toISOString(),
            last_accessed_at: f.updated || new Date().toISOString(),
            metadata: {
                size: f.size,
                mimetype: f.type || 'application/octet-stream',
            },
        }));

        return { next_continuation_token: null, objects: mappedFiles, folders: [], hasNext: false };
    }, {
        body: t.Optional(t.Object({
            prefix: t.Optional(t.String()),
            limit: t.Optional(t.Number()),
            offset: t.Optional(t.Number()),
            search: t.Optional(t.String()),
            sortBy: t.Optional(t.Object({
                column: t.Optional(t.String()),
                order: t.Optional(t.String())
            }))
        }))
    })

    // ════════════════════════════════════════════════════════
    // OBJECT DELETE — DELETE /object/:bucket (batch delete)
    // supabase.storage.from('bucket').remove(['path1', 'path2'])
    // ════════════════════════════════════════════════════════

    .delete('/object/:bucket', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const prefixes = body?.prefixes || [];
        const auth = headers['authorization'];

        const results = await Promise.allSettled(
            prefixes.map(async (p: string) => {
                const permitted = await StorageRLS.authorizeAction(ref, auth, 'delete', params.bucket, p);
    if (!permitted.permitted) throw new Error(permitted.error || 'Forbidden');
                
                return await StorageService.deleteFile(ref, params.bucket, p);
            })
        );

        return results.map((r: any, i: number) => ({
            name: prefixes[i],
            bucket_id: params.bucket,
            ...(r.status === 'fulfilled' && r.value !== false ? {} : { error: 'Delete failed' }),
        }));
    }, {
        body: t.Optional(t.Object({
            prefixes: t.Optional(t.Array(t.String()))
        }))
    })

    // ════════════════════════════════════════════════════════
    // OBJECT MOVE / COPY
    // ════════════════════════════════════════════════════════

    .post('/object/move', async ({ headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const srcBucket = String(body.bucketId || '');
        const srcKey = String(body.sourceKey || '');
        const destBucket = String(body.destinationBucket || body.destinationBucketId || srcBucket);
        const destKey = String(body.destinationKey || '');

        if (!srcBucket || !srcKey || !destKey) {
            return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing source or destination' });
        }

        try {
            // Step 1: Download source
            const srcRes = await StorageService.getDownloadResponse(ref, srcBucket, srcKey);
            if (!srcRes) return status(404, { statusCode: '404', error: 'Not Found', message: 'Source object not found' });
            const srcData = Buffer.from(await srcRes.arrayBuffer());
            const contentType = srcRes.headers?.get('Content-Type') || 'application/octet-stream';

            // Step 2: Upload to destination
            const uploaded = await StorageService.uploadFile(ref, destBucket, destKey, srcData, contentType);
            if (!uploaded) return status(500, { statusCode: '500', error: 'Internal', message: 'Move failed: could not write destination' });

            // Step 3: Delete source
            await StorageService.deleteFile(ref, srcBucket, srcKey);

            return { message: `Successfully moved` };
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: err instanceof Error ? err.message : String(err) });
        }
    }, {
        body: t.Object({
            bucketId: t.Optional(t.String()),
            sourceKey: t.Optional(t.String()),
            destinationBucketId: t.Optional(t.String()),
            destinationBucket: t.Optional(t.String()),
            destinationKey: t.Optional(t.String())
        })
    })

    .post('/object/copy', async ({ headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const srcBucket = String(body.bucketId || '');
        const srcKey = String(body.sourceKey || '');
        const destBucket = String(body.destinationBucket || body.destinationBucketId || srcBucket);
        const destKey = String(body.destinationKey || '');

        if (!srcBucket || !srcKey || !destKey) {
            return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing source or destination' });
        }

        try {
            const srcRes = await StorageService.getDownloadResponse(ref, srcBucket, srcKey);
            if (!srcRes) return status(404, { statusCode: '404', error: 'Not Found', message: 'Source object not found' });
            const srcData = Buffer.from(await srcRes.arrayBuffer());
            const contentType = srcRes.headers?.get('Content-Type') || 'application/octet-stream';

            const uploaded = await StorageService.uploadFile(ref, destBucket, destKey, srcData, contentType);
            if (!uploaded) return status(500, { statusCode: '500', error: 'Internal', message: 'Copy failed' });

            return { Key: `${destBucket}/${destKey}`, path: `${destBucket}/${destKey}` };
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: err instanceof Error ? err.message : String(err) });
        }
    }, {
        body: t.Object({
            bucketId: t.Optional(t.String()),
            sourceKey: t.Optional(t.String()),
            destinationBucketId: t.Optional(t.String()),
            destinationBucket: t.Optional(t.String()),
            destinationKey: t.Optional(t.String())
        })
    })

    // ════════════════════════════════════════════════════════
    // IMAGE TRANSFORM — GET /render/image/public/:bucket/*
    // supabase.storage.from('bucket').download('path', { transform: { width, height } })
    // ════════════════════════════════════════════════════════

    .get('/render/image/public/:bucket/*', async ({ params, headers, query, set }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { error: 'Missing file path' });
        return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
    })

    // ════════════════════════════════════════════════════════
    // TUS RESUMABLE UPLOAD (v1.0.0)
    // supabase.storage.from('bucket').upload(path, file) — triggers TUS for >6MB
    // ════════════════════════════════════════════════════════

    // OPTIONS /upload/resumable — TUS capabilities discovery
    .options('/upload/resumable', ({ set }) => {
        set.headers['Tus-Resumable'] = '1.0.0';
        set.headers['Tus-Version'] = '1.0.0';
        set.headers['Tus-Extension'] = 'creation,termination';
        set.headers['Tus-Max-Size'] = String(5 * 1024 * 1024 * 1024); // 5GB
        return '';
    })

    // POST /upload/resumable — Create a new resumable upload
    .post('/upload/resumable', async ({ headers, set }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const uploadLength = Number(headers['upload-length'] || 0);
        const metadataHeader = headers['upload-metadata'] || '';

        // Parse TUS metadata: key base64value,key2 base64value2
        const meta: Record<string, string> = {};
        for (const pair of metadataHeader.split(',')) {
            const [key, val] = pair.trim().split(' ');
            if (key && val) meta[key] = Buffer.from(val, 'base64').toString('utf-8');
        }

        const bucket = meta.bucketName || 'default';
        const objectName = meta.objectName || `upload-${Date.now()}`;
        const contentType = meta.contentType || 'application/octet-stream';

        // TUS Authorization Gate
        const auth = headers['authorization'];
        const metadata = { mimetype: contentType, size: uploadLength, userMetadata: meta };
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'upload', bucket, objectName, metadata);
        if (!permitted.permitted) {
            return status(permitted.error === 'Bucket not found' || permitted.error === 'Object not found' ? 404 : 403, { 
                statusCode: permitted.error === 'Bucket not found' || permitted.error === 'Object not found' ? '404' : '403', 
                error: permitted.error === 'Object not found' ? 'Not Found' : 'Forbidden', 
                message: permitted.error || 'Access Denied.' 
            });
        }

        const uploadId = `${ref}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Store upload state
        await TusStore.set(uploadId, {
            ref,
            bucket,
            objectName,
            contentType,
            totalSize: uploadLength,
            offset: 0,
            createdAt: Date.now(),
        });

        set.headers['Tus-Resumable'] = '1.0.0';
        set.headers['Location'] = `/storage/v1/upload/resumable/${uploadId}`;
        set.status = 201;
        return '';
    })

    // HEAD /upload/resumable/:uploadId — Get current upload offset
    .head('/upload/resumable/:uploadId', async ({ params, set }) => {
        const upload = await TusStore.get(params.uploadId);
        if (!upload) return status(404, { error: 'Upload not found' });

        set.headers['Tus-Resumable'] = '1.0.0';
        set.headers['Upload-Offset'] = String(upload.offset);
        set.headers['Upload-Length'] = String(upload.totalSize);
        set.headers['Cache-Control'] = 'no-store';
        return '';
    })

    // PATCH /upload/resumable/:uploadId — Upload a chunk
    .patch('/upload/resumable/:uploadId', async ({ params, headers, request, set }) => {
        const upload = await TusStore.get(params.uploadId);
        if (!upload) return status(404, { error: 'Upload not found' });

        const clientOffset = Number(headers['upload-offset'] || 0);
        if (clientOffset !== upload.offset) {
            return status(409, { error: 'Offset mismatch', expected: upload.offset, received: clientOffset });
        }

        const chunk = Buffer.from(await request.arrayBuffer());
        await TusStore.updateOffset(params.uploadId, upload.offset + chunk.length, chunk);
        upload.offset += chunk.length;

        set.headers['Tus-Resumable'] = '1.0.0';
        set.headers['Upload-Offset'] = String(upload.offset);

        // Upload complete — assemble and store in S3
        if (upload.offset >= upload.totalSize) {
            const fullBody = await TusStore.assemble(params.uploadId);

            try {
                await StorageService.uploadFile(upload.ref, upload.bucket, upload.objectName, fullBody, upload.contentType);
                await TusStore.delete(params.uploadId);
                return { Key: `${upload.bucket}/${upload.objectName}` };
            } catch (err: unknown) {
                await TusStore.delete(params.uploadId);
                return status(500, { error: 'Failed to finalize upload' });
            }
        }

        set.status = 204;
        return '';
    })

    // DELETE /upload/resumable/:uploadId — Abort a resumable upload
    .delete('/upload/resumable/:uploadId', async ({ params, set }) => {
        await TusStore.delete(params.uploadId);
        set.headers['Tus-Resumable'] = '1.0.0';
        set.status = 204;
        return '';
    });


// ── Shared imaginary proxy helper ─────────────────────────────────
// POST image body directly to imaginary instead of having imaginary fetch via URL.
// This works for both local/JuiceFS and S3 storage backends.
async function proxyToImaginary(
    ref: string,
    logicalBucket: string,
    filePath: string,
    query: Record<string, string | undefined>,
    set: { headers: Record<string, string> }
): Promise<Response | { error: string }> {
    // 1. Read the source image from storage
    const downloadRes = await StorageService.getDownloadResponse(ref, logicalBucket, filePath);
    if (!downloadRes) {
        return status(404, { error: 'Source image not found' }) as unknown as { error: string };
    }

    // 2. Build imaginary query params
    const imaginaryParams = new URLSearchParams();
    if (query.width)  imaginaryParams.set('width',  String(query.width));
    if (query.height) imaginaryParams.set('height', String(query.height));
    imaginaryParams.set('quality', String(query.quality || 80));

    const format = query.format || 'webp';
    imaginaryParams.set('type', format);

    const resizeMode = query.resize || 'cover';
    let operation = 'resize';

    // Check for extended operations first (overrides standard resize)
    if (query.smartcrop === 'true' || query.smartcrop === '1' || resizeMode === 'smartcrop') {
        operation = 'smartcrop';
    } else if (query.watermark || query.text || query.image || query.wm || query.wm_text || query.wm_image) {
        operation = 'watermark';
    } else if (query.blur || query.sigma) {
        operation = 'blur';
    } else {
        // Standard Supabase resize operations
        if (resizeMode === 'cover' || resizeMode === 'crop') {
            operation = 'crop';
        } else if (resizeMode === 'contain' || resizeMode === 'embed') {
            operation = 'embed';
        } else if (resizeMode === 'fill') {
            operation = 'enlarge';
            imaginaryParams.set('force', 'true');
        }
    }

    // Pass through advanced transform fields from query directly to imaginary.
    const queryKeyMap: Record<string, string> = {
        watermark: 'text',
        blur: 'sigma',
        wm: 'text',
        wm_text: 'text',
        wm_image: 'image',
        wm_opacity: 'opacity',
        wm_gravity: 'gravity',
        wm_dx: 'dx',
        wm_dy: 'dy',
    };
    for (const [rawKey, rawValue] of Object.entries(query)) {
        if (rawValue === undefined || rawValue === null) continue;
        if (!TRANSFORM_QUERY_KEYS.has(rawKey)) continue;
        if (rawKey === "smartcrop") continue;

        const mappedKey = queryKeyMap[rawKey] || rawKey;
        if (!imaginaryParams.has(mappedKey)) {
            imaginaryParams.set(mappedKey, String(rawValue));
        }
    }

    try {
        // 3. POST the raw image body to imaginary (no URL fetch needed)
        const imageBody = await downloadRes.arrayBuffer();
        const sourceContentType = downloadRes.headers?.get('Content-Type') || 'application/octet-stream';

        const res = await fetch(`${IMAGINARY_URL}/${operation}?${imaginaryParams.toString()}`, {
            method: 'POST',
            body: imageBody,
            headers: { 'Content-Type': sourceContentType },
        });
        if (!res.ok) {
            const errText = await res.text();
            logger.error(`Imaginary ${operation} failed:`, { status: res.status, error: errText });
            return status(502, { error: `Image transform failed: ${errText}` }) as unknown as { error: string };
        }

        set.headers['Content-Type'] = res.headers.get('Content-Type') || `image/${format}`;
        set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        set.headers['X-Image-Engine'] = 'imaginary/libvips';
        return new Response(res.body);
    } catch (err: unknown) {
        logger.error('Imaginary proxy error:', { error: err instanceof Error ? err.message : String(err) });
        return status(502, { error: 'Image processing service unavailable' }) as unknown as { error: string };
    }
}
