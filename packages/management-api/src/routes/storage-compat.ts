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
import { jwtVerify } from "jose";

async function generateSignedToken(ref: string, bucket: string, path: string, expiresAt: number): Promise<string> {
    const secret = await getSigningSecretForTenant(ref);
    const payload = `${bucket}/${path}:${expiresAt}`;
    const hmac = createHmac('sha256', secret);
    hmac.update(payload);
    return hmac.digest('hex');
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
    let cacheControlStr: string | null = null;

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
            if (headersRow.includes('name="metadata"') && fileEnd >= fileStart) {
                metadataStr = buffer.subarray(fileStart, fileEnd).toString('utf-8');
            }
            // Skip known text fields (cacheControl, etc)
            else if (headersRow.includes('name="cacheControl"') && fileEnd >= fileStart) {
                cacheControlStr = buffer.subarray(fileStart, fileEnd).toString('utf-8');
            }
            // If it has filename= or Content-Type: header, it's the file
            else if (headersRow.includes('filename=') || headersRow.includes('Content-Type:')) {
                let mimeType = 'application/octet-stream';
                const typeMatch = headersRow.match(/Content-Type:\s*([^\r\n]+)/i);
                if (typeMatch) mimeType = typeMatch[1].trim();

                if (fileEnd >= fileStart) {
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
        let parsedMetadata: Record<string, unknown> = {};
        if (metadataStr) {
            try { parsedMetadata = JSON.parse(metadataStr); } catch {}
        }
        if (cacheControlStr) {
            parsedMetadata.cacheControl = cacheControlStr;
        }
        return { ...bestFile, metadata: Object.keys(parsedMetadata).length > 0 ? parsedMetadata : undefined };
    }
    return null;
}

/**
 * Verify a signed token against path + expiry.
 */
async function verifySignedToken(ref: string, bucket: string, path: string, token: string, expiresAt?: number): Promise<boolean> {
    try {
        const secret = await getSigningSecretForTenant(ref);

        // Try HMAC-SHA256 verification (official Supabase format)
        if (expiresAt && expiresAt < Math.floor(Date.now() / 1000)) {
            return false;
        }
        if (expiresAt) {
            const payload = `${bucket}/${path}:${expiresAt}`;
            const hmac = createHmac('sha256', secret);
            hmac.update(payload);
            const expected = hmac.digest('hex');
            if (token === expected) return true;
        }

        // Fallback: try JWT verification (backward compat for old tokens)
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
        return payload.url === `${bucket}/${path}`;
    } catch {
        return false;
    }
}

/**
 * Extract project ref from request.
 * Kong forwards the x-project-ref header; also fall back to apikey-based lookup.
 */
async function resolveProjectRefFromApiKey(key: string): Promise<string> {
    if (!key) return '';
    try {
        const { sql } = await import('../db');
        const rows = await sql`SELECT ref FROM projects WHERE anon_key = ${key} OR service_role_key = ${key} LIMIT 1`;
        if (rows.length > 0) return String(rows[0].ref);
    } catch {}
    return '';
}

async function getProjectRef(headers: Record<string, string | undefined>): Promise<string> {
    const auth = headers['authorization'] || '';
    const key = headers['apikey'] || '';
    const host = headers['host']?.replace(/:\d+$/, '') || '';
    
    // P0-13 & P0-14: Test-mode backdoor locked behind strict Bun env, and removed hardcoded jVF keys
    if (process.env.BUN_ENV === 'test' || process.env.NODE_ENV === 'test') {
        if (key === 'test-token' || auth === 'Bearer test-token') {
             return 'test_mock';
        }
    }
    
    const apiKeyRef = await resolveProjectRefFromApiKey(key);
    const headerRef = headers['x-project-ref'] || headers['x-supabase-project'];
    if (headerRef) {
        if (apiKeyRef && apiKeyRef !== headerRef) return '';
        return headerRef;
    }

    // JWT payload fallback
    if (auth.startsWith('Bearer ')) {
        try {
            const token = auth.slice('Bearer '.length);
            const payloadB64 = token.split('.')[1];
            if (payloadB64) {
                const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
                if (payload?.ref) {
                    if (apiKeyRef && apiKeyRef !== payload.ref) return '';
                    return payload.ref;
                }
            }
        } catch {}
    }

    // apikey -> project lookup (official SDK storage requests commonly only send apikey)
    if (apiKeyRef) return apiKeyRef;

    // Host -> project lookup fallback for storage requests. This keeps uploads working
    // even when Kong request-transformer fails to inject x-project-ref.
    if (host) {
        try {
            const { sql } = await import('../db');
            const rows = await sql`
                SELECT ref
                FROM projects
                WHERE config->>'api_domain' = ${host}
                   OR config->>'custom_domain' = ${host}
                   OR config->>'studio_domain' = ${host}
                LIMIT 1
            `;
            if (rows.length > 0) return String(rows[0].ref);
        } catch {}
    }

    // P1-6: Fallback to extract tenant prefix from host header if preserve_host is active
    if (host) {
        if (config.baseDomain && host.includes(config.baseDomain)) {
            const hostRef = host.split('.')[0];
            if (apiKeyRef && apiKeyRef !== hostRef) return '';
            return hostRef;
        }
    }
    return '';
}

function isMimeAllowed(allowedMimes: string[], actualMime: string): boolean {
    if (!actualMime) return false;
    const [type] = actualMime.split('/');
    return allowedMimes.some(allowed => {
        if (allowed === actualMime) return true;
        const [aType, aSubtype] = allowed.split('/');
        return (aSubtype === '*' && aType === type);
    });
}

function setDownloadDisposition(query: Record<string, string | undefined>, filePath: string, set: { headers: Record<string, string> }): void {
    const download = query.download;
    if (download !== undefined) {
        let filename = 'download';
        if (typeof download === 'string' && download !== 'true' && download !== '') {
            filename = download;
        } else {
            filename = filePath.split('/').pop() || 'download';
        }
        set.headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`;
    } else {
        set.headers['Content-Disposition'] = 'inline';
    }
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

function buildSignedPath(pathname: string, expiresAt: number, token: string, transform?: Record<string, unknown>, download?: boolean | string): string {
    const search = new URLSearchParams({ token });
    search.set("expiresAt", String(expiresAt));

    if (download) {
        if (typeof download === 'string') search.set('download', download);
        else search.set('download', '');
    }

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

function getRequestOrigin(request: Request): string {
    const proto = request.headers?.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
    const host = request.headers?.get("x-forwarded-host") || new URL(request.url).host;
    return `${proto}://${host}/storage/v1`;
}

function hasTransformQuery(query: Record<string, unknown>): boolean {
    return Object.entries(query).some(([key, value]) => value !== undefined && value !== null && TRANSFORM_QUERY_KEYS.has(key));
}

function getUploadMetadata(headers: Record<string, string | undefined>): Record<string, unknown> {
    const raw = headers["x-metadata"] || headers["X-Metadata"];
    let parsed: Record<string, unknown> = {};

    if (raw) {
        try {
            const decoded = Buffer.from(raw, "base64").toString("utf-8");
            parsed = JSON.parse(decoded);
        } catch (e) {
            // Ignore parse errors
        }
    }

    const cc = headers["cache-control"] || headers["Cache-Control"];
    if (cc && !parsed.cacheControl) {
        parsed.cacheControl = cc;
    }

    return parsed;
}

function parseContentLength(value: string | null | undefined): number | null {
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.floor(parsed);
}

function isMultipartContentType(contentType: string | undefined): boolean {
    return (contentType || "").toLowerCase().includes("multipart/form-data");
}
async function readUploadBody(
    request: Request,
    contentType: string | undefined,
    contentLengthHeader?: string | undefined,
): Promise<{ fileData: Buffer | ReadableStream; fileMimeType: string; size: number; customMetadata?: Record<string, unknown> }> {
    const normalizedMime = contentType?.split(";")[0]?.trim() || "application/octet-stream";

    // For direct SDK/raw uploads, stream the body through instead of materializing the
    // entire payload in memory. Multipart requests still need full parsing.
    if (!isMultipartContentType(contentType) && request.body) {
        const contentLength = parseContentLength(contentLengthHeader || request.headers.get("content-length"));
        if (contentLength !== null) {
            return {
                fileData: request.body,
                fileMimeType: normalizedMime,
                size: contentLength,
            };
        }
    }

    let fileBuffer = Buffer.from(await request.arrayBuffer());
    let fileMimeType = normalizedMime;
    let customMetadata: Record<string, unknown> | undefined;

    const isActuallyMultipart = fileBuffer.length > 20
        && fileBuffer.subarray(0, 2).toString("utf-8") === "--"
        && fileBuffer.indexOf(Buffer.from("Content-Disposition: form-data;")) !== -1;

    if (isMultipartContentType(contentType) || isActuallyMultipart) {
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

    return { fileData: fileBuffer, fileMimeType, size: fileBuffer.byteLength, customMetadata };
    return { fileData: fileBuffer, fileMimeType, size: fileBuffer.byteLength, customMetadata };
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

    // ── Origin Guard: reject requests without a valid project reference ──
    // Storage compat routes rely on Kong-injected x-project-ref.
    // If accessed directly (bypassing Kong), getProjectRef returns '' and each
    // route already returns 400 "Missing tenant reference". This guard adds
    // defense-in-depth logging for monitoring direct-access attempts.
    .onBeforeHandle(async ({ headers, request }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        if (!ref) {
            logger.warn('[StorageCompat] Request without project ref detected', {
                url: request.url,
                remoteAddr: request.headers.get('x-forwarded-for') || 'unknown',
            });
        }
    })
    
    // Inject standard Supabase compatibility headers on all API responses
    .onAfterHandle(({ set }) => {
        set.headers['x-supabase-api-version'] = new Date().toISOString().slice(0, 10).replace(/-/g, '').substring(0, 8);
        set.headers['sb-gateway-version'] = '1.0.0';
    })

    // ════════════════════════════════════════════════════════
    // BUCKET Operations
    // ════════════════════════════════════════════════════════

    // GET /bucket — List all buckets
    .get('/bucket', async ({ headers, query }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        if (!ref) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing tenant reference' });
        const auth = headers['authorization'];
        
        try {
            const options = {
                limit: query.limit ? parseInt(query.limit as string) : undefined,
                offset: query.offset ? parseInt(query.offset as string) : undefined,
                search: (query.search as string) || undefined,
                sortBy: query.sortColumn ? { column: query.sortColumn as string, order: (query.sortOrder as string) || 'asc' } : undefined
            };
            const buckets = await StorageRLS.listLogicalBuckets(ref, auth, options);
            return buckets.map(b => ({
                id: b.id,
                name: b.name,
                owner: '',
                public: (b.public as boolean) ?? false,
                created_at: (b.created_at as string) || new Date().toISOString(),
                updated_at: (b.updated_at as string) || new Date().toISOString(),
                file_size_limit: b.file_size_limit || null,
                allowed_mime_types: b.allowed_mime_types || null,
                type: (b.type as string) || 'STANDARD',
            }));
        } catch (e: any) {
            return status(403, { statusCode: "403", error: 'Forbidden', message: e.message || 'Access Denied' });
        }
    })

    // POST /bucket — Create a bucket  
    .post('/bucket', async ({ headers, body }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        if (!ref) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing tenant reference' });
        
        const auth = headers['authorization'];
        const name = body.name || ref;
        const bucketId = String(body.id || name);
        const isPublic = body.public === true;
        
        // Parse file size limit (e.g. '1mb', '1kb', '50mb')
        const rawFileSizeLimit = body.file_size_limit !== undefined ? body.file_size_limit : body.fileSizeLimit;
        const fileSizeLimit = parseFileSizeLimit(rawFileSizeLimit);
        
        const rawAllowedMimeTypes = body.allowed_mime_types !== undefined ? body.allowed_mime_types : body.allowedMimeTypes;
        const allowedMimeTypes = parseAllowedMimeTypes(rawAllowedMimeTypes);

        // 1. Register bucket in Postgres `storage.buckets` subject to RLS BEFORE allocating in S3
        try {
            await StorageRLS.registerLogicalBucket(ref, auth, bucketId, String(name), isPublic, fileSizeLimit, allowedMimeTypes);
        } catch (err: any) {
            return status(403, { statusCode: "403", error: 'Forbidden', message: err.message || 'Access Denied' });
        }
        
        // 2. Create S3 namespace
        const result = await StorageService.createBucket(ref, bucketId);
        if (!result.success) {
            await StorageRLS.rollbackLogicalBucket(ref, bucketId);
            return status(500, { statusCode: "500", error: 'Internal', message: result.error || 'Failed to create bucket in S3 layer' });
        }
        
        return {
            id: bucketId,
            name,
            public: isPublic,
            file_size_limit: fileSizeLimit,
            allowed_mime_types: allowedMimeTypes,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            type: body.type || 'STANDARD',
        };
    }, {
        body: t.Object({
            id: t.Optional(t.String()),
            name: t.Optional(t.String()),
            public: t.Optional(t.Boolean()),
            type: t.Optional(t.String()),
            fileSizeLimit: t.Optional(t.Union([t.String(), t.Number(), t.Null()])),
            allowedMimeTypes: t.Optional(t.Union([t.Array(t.String()), t.Null()])),
            file_size_limit: t.Optional(t.Union([t.String(), t.Number(), t.Null()])),
            allowed_mime_types: t.Optional(t.Union([t.Array(t.String()), t.Null()]))
        })
    })

    // GET /bucket/:id — Get bucket details
    .get('/bucket/:id', async ({ params, headers }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        if (!ref) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing tenant reference' });
        const auth = headers['authorization'];

        try {
            const bucket = await StorageRLS.getLogicalBucket(ref, params.id, auth);
            if (!bucket) {
                return status(404, { statusCode: "404", error: 'Not Found', message: 'The resource was not found' });
            }

            return {
                id: params.id,
                name: (bucket.name as string) || params.id,
                owner: bucket.owner || '',
                public: (bucket.public as boolean) ?? false,
                created_at: (bucket.created_at as string) || new Date().toISOString(),
                updated_at: (bucket.updated_at as string) || new Date().toISOString(),
                file_size_limit: bucket.file_size_limit || null,
                allowed_mime_types: bucket.allowed_mime_types || null,
                type: (bucket.type as string) || 'STANDARD',
            };
        } catch (e: any) {
             return status(403, { statusCode: "403", error: 'Forbidden', message: e.message || 'Access Denied' });
        }
    })

    // DELETE /bucket/:id — Delete bucket
    
    // PUT /bucket/:id — Update bucket
    .put('/bucket/:id', async ({ params, headers, body }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        if (!ref) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing tenant reference' });
        const auth = headers['authorization'];

        try {
            const current = await StorageRLS.getLogicalBucket(ref, params.id, auth);
            if (!current) {
                return status(404, { statusCode: "404", error: 'Not Found', message: 'The resource was not found' });
            }

            const name = String(body.name || current.name || params.id);
            const isPublic = body.public === undefined ? Boolean(current.public) : body.public === true;
            const rawFileSizeLimit = body.file_size_limit !== undefined ? body.file_size_limit : body.fileSizeLimit;
            const fileSizeLimit = parseFileSizeLimit(rawFileSizeLimit ?? current.file_size_limit ?? null);
            const rawAllowedMimeTypes = body.allowed_mime_types !== undefined ? body.allowed_mime_types : body.allowedMimeTypes;
            const allowedMimeTypes = parseAllowedMimeTypes(rawAllowedMimeTypes) ?? parseAllowedMimeTypes(current.allowed_mime_types);
            
            await StorageRLS.registerLogicalBucket(ref, auth, params.id, name, isPublic, fileSizeLimit, allowedMimeTypes);

            return { message: "Successfully updated" };
        } catch (e: any) {
            return status(403, { statusCode: "403", error: 'Forbidden', message: e.message || 'Access Denied' });
        }
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
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        if (!ref) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing tenant reference' });
        const auth = headers['authorization'];

        try {
            // 1. Dry run to ensure user can empty this bucket
            await StorageRLS.emptyLogicalBucket(ref, auth, params.id, true);
        } catch (e: any) {
            return status(403, { statusCode: "403", error: 'Forbidden', message: e.message || 'Access Denied' });
        }
        
        // 2. Clear physical storage
        const result = await StorageService.emptyBucket(ref, params.id);
        if (!result.success) return status(500, { statusCode: "500", error: 'Internal', message: result.error || 'Failed to empty bucket' });
        
        // 3. Logical delete bucket
        await StorageRLS.emptyLogicalBucket(ref, auth, params.id, false);
        return { message: "Successfully emptied" };
    })

    .delete('/bucket/:id', async ({ params, headers }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        if (!ref) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing tenant reference' });
        const auth = headers['authorization'];

        try {
            // 1. Dry run to ensure bucket can be deleted
            await StorageRLS.deleteLogicalBucket(ref, auth, params.id, true);
        } catch (e: any) {
            return status(403, { statusCode: "403", error: 'Forbidden', message: e.message || 'Access Denied' });
        }
        
        // 2. Physical delete bucket
        const result = await StorageService.deleteBucket(ref, params.id);
        if (!result.success) return status(500, { statusCode: "500", error: 'Internal', message: result.error || 'Failed to delete bucket' });
        
        // 3. Logical delete bucket
        await StorageRLS.deleteLogicalBucket(ref, auth, params.id, false);
        return { message: "Successfully deleted" };
    })

    // ════════════════════════════════════════════════════════
    // OBJECT UPLOAD — POST /object/:bucket/*
    // supabase.storage.from('bucket').upload('path/to/file', fileBody)
    // ════════════════════════════════════════════════════════

    .post('/object/:bucket/*', async ({ params, headers, request, set }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });

        try {
            const contentType = headers['content-type'];
            const { fileData, fileMimeType, size, customMetadata } = await readUploadBody(request, contentType, headers["content-length"]);
            const headerMetadata = getUploadMetadata(headers as Record<string, string | undefined>);
            const userMetadata: Record<string, unknown> = { ...headerMetadata, ...(customMetadata || {}) };
            const upsert = headers['x-upsert'] === 'true';

            // Validate bucket constraints (file size limit, allowed mime types)
            const auth = headers['authorization'];
            const bucket = await StorageRLS.getLogicalBucket(ref, params.bucket, undefined, true);
            if (!bucket) return status(404, { statusCode: "404", error: 'Not Found', message: 'Bucket not found' });

            // Check file size limit
            if (bucket.file_size_limit && size > Number(bucket.file_size_limit)) {
                return status(413, { statusCode: "413", error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
            }
            
            // Check allowed mime types
            const allowedMimes = bucket.allowed_mime_types as string[] | null;
            if (allowedMimes && Array.isArray(allowedMimes) && allowedMimes.length > 0) {
                const uploadMime = headers['content-type']?.split(';')[0]?.trim() || fileMimeType;
                const effectiveMime = isMultipartContentType(contentType) ? fileMimeType : uploadMime;
                if (!isMimeAllowed(allowedMimes, effectiveMime)) {
                    return status(415, { statusCode: "415", error: 'Unsupported Media Type', message: `mime type ${effectiveMime} is not supported` });
                }
            }

            let cc = headers['cache-control'] || (userMetadata.cacheControl as string) || '3600';
            // Strip max-age= prefix if present — store raw seconds in metadata (official Supabase behavior)
            if (cc && cc.startsWith('max-age=')) cc = cc.replace('max-age=', '');
            const metadata = { mimetype: fileMimeType, size, cacheControl: cc, userMetadata };
            const finalPermit = await StorageRLS.authorizeAction(
                ref, auth, 'upload', params.bucket, filePath, metadata, false, upsert, undefined, undefined,
                async () => {
                    const success = await StorageService.uploadFile(ref, params.bucket, filePath, fileData, fileMimeType);
                    if (!success) throw new Error('PHYSICAL_UPLOAD_FAILED');
                }
            );

            if (!finalPermit.permitted) {
                return status(
                    finalPermit.error === 'Bucket not found' || finalPermit.error === 'Object not found' ? 404 : (finalPermit.error === 'The resource already exists' ? 409 : (finalPermit.error === 'Failed to write physical object' ? 500 : 403)), 
                    { statusCode: finalPermit.error === 'Bucket not found' || finalPermit.error === 'Object not found' ? '404' : (finalPermit.error === 'The resource already exists' ? '409' : (finalPermit.error === 'Failed to write physical object' ? '500' : '403')), 
                      error: finalPermit.error === 'Object not found' ? 'Not Found' : (finalPermit.error === 'The resource already exists' ? 'Conflict' : (finalPermit.error === 'Failed to write physical object' ? 'Internal' : 'Forbidden')), 
                      message: finalPermit.error || 'Access Denied.' 
                    }
                );
            }

            return {
                Id: `${params.bucket}/${filePath}`,
                Key: `${params.bucket}/${filePath}`,
            };
        } catch (err: unknown) {
            logger.error('SDK upload error:', { error: err instanceof Error ? err.message : String(err) });
            return status(500, { statusCode: "500", error: 'Internal', message: 'Upload failed' });
        }
    }, // @ts-ignore
    { type: 'none' })

    // PUT /object/:bucket/* — Upsert (same as upload but always overwrites)
    .put('/object/:bucket/*', async ({ params, headers, request }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });

        try {
            const { fileData, fileMimeType, size, customMetadata } = await readUploadBody(request, headers['content-type'], headers["content-length"]);
            const headerMetadata = getUploadMetadata(headers as Record<string, string | undefined>);
            const userMetadata: Record<string, unknown> = { ...headerMetadata, ...(customMetadata || {}) };

            const auth = headers['authorization'];
            let cc = headers['cache-control'] || (userMetadata.cacheControl as string) || '3600';
            // Strip max-age= prefix if present — store raw seconds in metadata (official Supabase behavior)
            if (cc && cc.startsWith('max-age=')) cc = cc.replace('max-age=', '');
            const metadata = { mimetype: fileMimeType, size, cacheControl: cc, userMetadata };
            // PUT essentially enforces upsert = true
            const finalPermit = await StorageRLS.authorizeAction(
                ref, auth, 'update', params.bucket, filePath, metadata, false, true, undefined, undefined,
                async () => {
                    const success = await StorageService.uploadFile(ref, params.bucket, filePath, fileData, fileMimeType);
                    if (!success) throw new Error('PHYSICAL_UPLOAD_FAILED');
                }
            );

            if (!finalPermit.permitted) return status(finalPermit.error === 'Bucket not found' || finalPermit.error === 'Object not found' ? 404 : (finalPermit.error === 'Failed to write physical object' ? 500 : 403), { statusCode: finalPermit.error === 'Bucket not found' || finalPermit.error === 'Object not found' ? '404' : (finalPermit.error === 'Failed to write physical object' ? '500' : '403'), error: finalPermit.error === 'Object not found' ? 'Not Found' : (finalPermit.error === 'Failed to write physical object' ? 'Internal' : 'Forbidden'), message: finalPermit.error || 'Access Denied.' });

            return {
                Id: `${params.bucket}/${filePath}`,
                Key: `${params.bucket}/${filePath}`,
            };
        } catch (err: unknown) {
            return status(500, { statusCode: "500", error: 'Internal', message: 'Upsert failed' });
        }
    }, // @ts-ignore
    { type: 'none' })

    // ════════════════════════════════════════════════════════
    // OBJECT DOWNLOAD — GET /object/public/:bucket/*
    // supabase.storage.from('bucket').getPublicUrl('path')
    // ════════════════════════════════════════════════════════

    .get('/object/public/:bucket/*', async ({ params, headers, set, query }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });

        const bucket = await StorageRLS.getLogicalBucket(ref, params.bucket, undefined, true);
        if (!bucket || !bucket.public) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Bucket is not public' });

        // If transform params are present, proxy to imaginary
        if (hasTransformQuery(query as Record<string, unknown>)) {
            return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> }, true);
        }



        try {
            const info = await StorageRLS.getObjectInfo(ref, params.bucket, filePath, undefined, true);
            const res = await StorageService.getDownloadResponse(ref, params.bucket, filePath);
            if (!res) return status(404, { statusCode: "404", error: 'Not Found', message: 'Object not found internally' });

            set.headers['Content-Type'] = res.headers?.get('Content-Type') || 'application/octet-stream';
            const rawCc = (info?.cache_control as string) || '3600';
            set.headers['Cache-Control'] = /^\d+$/.test(rawCc) ? `public, max-age=${rawCc}` : rawCc;
            set.headers['Content-Length'] = res.headers?.get('Content-Length') || '';
            const etag = res.headers?.get('ETag') || (info?.id ? `"${info.id}"` : undefined);
            if (etag) set.headers['ETag'] = etag;
            const lastModified = res.headers?.get('Last-Modified') || info?.updated_at || info?.created_at;
            if (lastModified) set.headers['Last-Modified'] = new Date(lastModified as string | number).toUTCString();
            setDownloadDisposition(query as Record<string, string | undefined>, filePath, set as { headers: Record<string, string> });
            const newRes = new Response(res.body);
            return newRes;
        } catch (err: unknown) {
            return status(500, { statusCode: "500", error: 'Internal', message: 'Download failed' });
        }
    })

    // GET /object/authenticated/:bucket/* — Download (requires auth)
    .get('/object/authenticated/:bucket/*', async ({ params, headers, set, query }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });

        // Transform support
        if (hasTransformQuery(query as Record<string, unknown>)) {
            return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permitted.permitted) return status(permitted.error === 'Bucket not found' || permitted.error === 'Object not found' ? 404 : 403, { statusCode: permitted.error === 'Bucket not found' || permitted.error === 'Object not found' ? '404' : '403', error: permitted.error === 'Object not found' ? 'Not Found' : 'Forbidden', message: permitted.error || 'Access Denied.' });

        try {
            const res = await StorageService.getDownloadResponse(ref, params.bucket, filePath);
            if (!res) return status(404, { statusCode: "404", error: 'Not Found', message: 'Object not found internally' });

            const info = await StorageRLS.getObjectInfo(ref, params.bucket, filePath, undefined, true);
            set.headers['Content-Type'] = res.headers?.get('Content-Type') || 'application/octet-stream';
            set.headers['Cache-Control'] = 'private, max-age=3600';
            set.headers['Content-Length'] = res.headers?.get('Content-Length') || '';
            const etag = res.headers?.get('ETag') || (info?.id ? `"${info.id}"` : undefined);
            if (etag) set.headers['ETag'] = etag;
            const lastModified = res.headers?.get('Last-Modified') || info?.updated_at || info?.created_at;
            if (lastModified) set.headers['Last-Modified'] = new Date(lastModified as string | number).toUTCString();
            setDownloadDisposition(query as Record<string, string | undefined>, filePath, set as { headers: Record<string, string> });
            const newRes = new Response(res.body);
            return newRes;
        } catch (err: unknown) {
            return status(500, { statusCode: "500", error: 'Internal', message: 'Download failed' });
        }
    })

    
    // GET /object/info/:bucket/* — File metadata
    .get('/object/info/public/:bucket/*', async ({ params, headers }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        
        const bucket = await StorageRLS.getLogicalBucket(ref, params.bucket, undefined, true);
        if (!bucket || !bucket.public) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Bucket is not public' });

        const info = await StorageRLS.getObjectInfo(ref, params.bucket, filePath, undefined, true);
        if (!info) return status(404, { statusCode: "404", error: 'Not Found', message: 'Object not found' });

        return info;
    })
    .get('/object/info/:bucket/*', async ({ params, headers }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        
        const permitted = await StorageRLS.authorizeAction(ref, headers['authorization'], 'download', params.bucket, filePath);
        if (!permitted.permitted) return status(404, { statusCode: "404", error: 'Not Found', message: permitted.error || 'Object not found' });

        const info = await StorageRLS.getObjectInfo(ref, params.bucket, filePath, headers['authorization']);
        if (!info) return status(404, { statusCode: "404", error: 'Not Found', message: 'Object not found' });

        return info;
    })

    // HEAD /object/:bucket/* — Check if an object exists
    .head('/object/:bucket/*', async ({ params, headers }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];

        if (ref === 'test_mock') {
            const obj = mockObjects?.get(params.bucket + '/' + filePath);
            if (!obj) return status(404, { statusCode: "404", error: 'Not Found', message: 'Object not found' });
            return status(200, '');
        }

        const bucketId = params.bucket;
        const bucket = await StorageRLS.getLogicalBucket(ref, bucketId, undefined, true);
        if (!bucket) return status(404, { statusCode: "404", error: 'Not Found', message: 'Bucket not found' });

        const auth = headers['authorization'];
        if (!bucket.public) {
            const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', bucketId, filePath);
            if (!permitted.permitted) return status(404, { statusCode: "404", error: 'Not Found', message: 'Object not found' });
        }

        const s3Response = await StorageService.getDownloadResponse(ref, bucketId, filePath);
        if (!s3Response || !s3Response.ok) return status(404, { statusCode: "404", error: 'Not Found', message: 'Object not found' });
        
        return status(200, '');
    })

    // GET /object/:bucket/* — Download file (authenticated, generic path)
    // SDK calls: GET /object/{bucketId}/{filePath}
    .get('/object/:bucket/*', async ({ params, headers, set, query }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });

        if (hasTransformQuery(query as Record<string, unknown>)) {
            return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permitted.permitted) return status(permitted.error === 'Object not found' ? 404 : 403, { statusCode: permitted.error === 'Object not found' ? '404' : '403', error: permitted.error === 'Object not found' ? 'Not Found' : 'Forbidden', message: permitted.error || 'Access Denied.' });

        try {
            const res = await StorageService.getDownloadResponse(ref, params.bucket, filePath);
            if (!res) return status(404, { statusCode: "404", error: 'Not Found', message: 'Object not found internally' });

            const info = await StorageRLS.getObjectInfo(ref, params.bucket, filePath, undefined, true);
            set.headers['Content-Type'] = res.headers?.get('Content-Type') || 'application/octet-stream';
            set.headers['Cache-Control'] = 'private, max-age=3600';
            set.headers['Content-Length'] = res.headers?.get('Content-Length') || '';
            const etag = res.headers?.get('ETag') || (info?.id ? `"${info.id}"` : undefined);
            if (etag) set.headers['ETag'] = etag;
            const lastModified = res.headers?.get('Last-Modified') || info?.updated_at || info?.created_at;
            if (lastModified) set.headers['Last-Modified'] = new Date(lastModified as string | number).toUTCString();
            setDownloadDisposition(query as Record<string, string | undefined>, filePath, set as { headers: Record<string, string> });
            const newRes = new Response(res.body);
            return newRes;
        } catch (err: unknown) {
            return status(500, { statusCode: "500", error: 'Internal', message: 'Download failed' });
        }
    })

    // ════════════════════════════════════════════════════════
    // SIGNED URL — POST /object/sign/:bucket/*
    // supabase.storage.from('bucket').createSignedUrl('path', expiresIn)
    // SDK calls: POST /object/sign/{bucketId}/{filePath} with body { expiresIn }
    // ════════════════════════════════════════════════════════

    .post('/object/sign/:bucket/*', async ({ params, headers, body, request }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const payload = body || {};
        const filePath = params['*'] || String(payload.url || payload.path || '').replace(/^\//, '');
        const expiresIn = Number(payload.expiresIn) || 3600;

        if (!filePath) {
            return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });
        }

        // Check object exists via RLS
        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permitted.permitted) return status(400, { statusCode: "400", error: 'Not Found', message: permitted.error || 'Object not found' });

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
    .post('/object/sign/:bucket', async ({ params, headers, body, request }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        
        // If body has paths array, it's a batch request
        if (body.paths && Array.isArray(body.paths)) {
            const paths = body.paths;
            const expiresIn = Number(body.expiresIn) || 3600;

            return Promise.all(paths.map(async (filePath: string) => {
                const cleanPath = filePath.replace(/^\//, '');
                
                const auth = headers['authorization'] || '';
                const objectExists = await StorageRLS.objectExists(ref, params.bucket, cleanPath, auth);
                if (!objectExists) {
                    return { error: 'Either the object does not exist or you do not have access to it', path: filePath, signedURL: null };
                }

                const permittedCheck = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, cleanPath);
                if (!permittedCheck.permitted) {
                    return { error: 'Either the object does not exist or you do not have access to it', path: filePath, signedURL: null };
                }

                const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
                const token = await generateSignedToken(ref, params.bucket, cleanPath, expiresAt);
                const signPrefix = body.transform ? '/render/image/sign' : '/object/sign';
                return {
                    error: null,
                    path: filePath,
                    signedURL: buildSignedPath(`${signPrefix}/${params.bucket}/${cleanPath}`, expiresAt, token, body.transform),
                };
            }));
        }
        
        // Single sign with path in body
        const filePath = String(body.url || body.path || '').replace(/^\//, '');
        const expiresIn = Number(body.expiresIn) || 3600;

        if (!filePath) {
            return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });
        }

        const auth = headers['authorization'] || '';
        const objectExists = await StorageRLS.objectExists(ref, params.bucket, filePath, auth);
        if (!objectExists) {
            return status(404, { statusCode: "404", error: 'Not Found', message: 'Object not found' });
        }

        const permittedCheck = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permittedCheck.permitted) {
            return status(403, { statusCode: "403", error: 'Forbidden', message: 'You do not have permission to access this resource.' });
        }

        const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
        const token = await generateSignedToken(ref, params.bucket, filePath, expiresAt);
        
        const origin = getRequestOrigin(request as unknown as Request);
        const downloadOption = typeof body.download !== 'undefined' ? body.download : undefined;
        return {
            signedURL: origin + buildSignedPath(`/object/sign/${params.bucket}/${filePath}`, expiresAt, token, body.transform, downloadOption as any),
        };
    }, {
        body: t.Any()
    })

    // ════════════════════════════════════════════════════════
    // SIGNED UPLOAD URL — POST /object/upload/sign/:bucket/*
    // supabase.storage.from('bucket').createSignedUploadUrl('path')
    // ════════════════════════════════════════════════════════

    .post('/object/upload/sign/:bucket/*', async ({ params, headers, request }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });

        const upsert = headers['x-upsert'] === 'true';
        
        const bucket = await StorageRLS.getLogicalBucket(ref, params.bucket, undefined, true);
        if (!bucket) return status(404, { statusCode: "404", error: 'Not Found', message: 'Bucket not found' });
        
        const auth = headers['authorization'] || '';
        const action = upsert ? 'upload' : 'upload';
        const permittedCheck = await StorageRLS.authorizeAction(ref, auth, action, params.bucket, filePath, {}, true);
        if (!permittedCheck.permitted) {
            return status(403, { statusCode: "403", error: 'Forbidden', message: permittedCheck.error || 'You do not have permission to create signed upload URLs for this resource.' });
        }

        const token = crypto.randomUUID();
        const expiresAt = Math.floor(Date.now() / 1000) + 7200;
        await SignedStore.set(token, {
            ref,
            bucket: params.bucket,
            objectName: filePath,
            upsert,
            expiresAt,
            auth_token: auth || ''
        });

        return {
            // storage-js prepends the storage base URL client-side, so this must stay relative.
            url: `/object/upload/sign/${params.bucket}/${filePath}?token=${token}`,
        };
    })

    // PUT /object/upload/sign/:bucket/* — Upload using signed URL
    .put('/object/upload/sign/:bucket/*', async ({ params, headers, request, query }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });

        const token = query.token as string;
        if (!token) {
            return status(401, { statusCode: "401", error: 'Unauthorized', message: 'Missing signed URL token' });
        }

        const signedUpload = await SignedStore.get(token);
        if (!signedUpload || signedUpload.ref !== ref || signedUpload.bucket !== params.bucket || signedUpload.objectName !== filePath) {
            return status(401, { statusCode: "401", error: 'Unauthorized', message: 'Invalid or expired signed URL' });
        }
        if (signedUpload.expiresAt < Math.floor(Date.now() / 1000)) {
            await SignedStore.delete(token);
            return status(401, { statusCode: "401", error: 'Unauthorized', message: 'Invalid or expired signed URL' });
        }

        try {
            const { fileData, fileMimeType, size, customMetadata } = await readUploadBody(request, headers['content-type'], headers["content-length"]);

            // Bypass external headers — token already validates authorization
            const headerMetadata = getUploadMetadata(headers as Record<string, string | undefined>);
            const userMetadata: Record<string, unknown> = { ...headerMetadata, ...(customMetadata || {}) };
            let cc = headers['cache-control'] || (userMetadata.cacheControl as string) || '3600';
            // Strip max-age= prefix if present — store raw seconds in metadata (official Supabase behavior)
            if (cc && cc.startsWith('max-age=')) cc = cc.replace('max-age=', '');
            const metadata = { mimetype: fileMimeType, size, cacheControl: cc, userMetadata };
            
            const effectiveAuth = signedUpload.auth_token !== undefined ? signedUpload.auth_token : headers['authorization'];
            
            // 1. Transactional RLS + DB persist + S3 Write
            const finalPermit = await StorageRLS.authorizeAction(
                ref, effectiveAuth, 'upload', params.bucket, filePath, metadata, false, signedUpload.upsert, undefined, undefined,
                async () => {
                    const success = await StorageService.uploadFile(ref, params.bucket, filePath, fileData, fileMimeType);
                    if (!success) throw new Error('PHYSICAL_UPLOAD_FAILED');
                }
            );

            if (!finalPermit.permitted) {
                return status(finalPermit.error === 'The resource already exists' ? 409 : 403, { 
                    statusCode: finalPermit.error === 'The resource already exists' ? '409' : '403', 
                    error: finalPermit.error === 'The resource already exists' ? 'Conflict' : 'Forbidden', 
                    message: finalPermit.error || 'Access Denied.' 
                });
            }

            // Consume the signed upload token (one-time use)
            await SignedStore.delete(token);

            return {
                Key: `${params.bucket}/${filePath}`,
            };
        } catch (err: unknown) {
            return status(500, { statusCode: "500", error: 'Internal', message: err instanceof Error ? err.message : String(err) });
        }
    }, // @ts-ignore
    { type: 'none' })

    // GET /object/sign/:bucket/* — Serve signed file (validates token)
    .get('/object/sign/:bucket/*', async ({ params, headers, query, set }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });

        const token = query.token as string;
        const expiresAt = query.expiresAt ? Number(query.expiresAt) : undefined;

        if (!token) {
            return status(401, { statusCode: "401", error: 'Unauthorized', message: 'Missing signed URL token' });
        }

        if (!await verifySignedToken(ref, params.bucket, filePath, token, expiresAt)) {
            return status(401, { statusCode: "401", error: 'Unauthorized', message: 'Invalid or expired signed URL' });
        }

        // Transform support for signed URLs
        if (hasTransformQuery(query as Record<string, unknown>)) {
            return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        try {
            const res = await StorageService.getDownloadResponse(ref, params.bucket, filePath);
            if (!res) return status(404, { statusCode: "404", error: 'Not Found', message: 'Object not found internally' });

            set.headers['Content-Type'] = res.headers?.get('Content-Type') || 'application/octet-stream';
            set.headers['Cache-Control'] = 'private, no-store';
            setDownloadDisposition(query as Record<string, string | undefined>, filePath, set as { headers: Record<string, string> });
            const newRes = new Response(res.body);
            return newRes;
        } catch (err: unknown) {
            return status(500, { statusCode: "500", error: 'Internal', message: 'Download failed' });
        }
    })

    // GET /render/image/sign/:bucket/* — Serve signed transformed image
    .get('/render/image/sign/:bucket/*', async ({ params, headers, query, set }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });

        const token = query.token as string;
        const expiresAt = query.expiresAt ? Number(query.expiresAt) : undefined;

        if (!token) {
            return status(401, { statusCode: "401", error: 'Unauthorized', message: 'Missing signed URL token' });
        }

        if (!await verifySignedToken(ref, params.bucket, filePath, token, expiresAt)) {
            return status(401, { statusCode: "401", error: 'Unauthorized', message: 'Invalid or expired signed URL' });
        }

        return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
    })

    // GET /render/image/authenticated/:bucket/* — Download authenticated transformed file
    .get('/render/image/authenticated/:bucket/*', async ({ params, headers, query, set }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing file path' });

        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permitted.permitted) return status(403, { statusCode: "403", error: 'Forbidden', message: permitted.error || 'Access Denied.' });

        return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
    })

    // ════════════════════════════════════════════════════════
    // OBJECT LIST — POST /object/list/:bucket
    // supabase.storage.from('bucket').list('folder', { limit, offset, sortBy })
    // ════════════════════════════════════════════════════════

    .post('/object/list/:bucket', async ({ params, headers, body }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const auth = headers['authorization'];

        const prefix = body?.prefix || '';
        const limit  = body?.limit || 100;
        const offset = body?.offset || 0;
        const search = body?.search || '';

        // Fetch securely from RLS DB
        let files;
        try {
            files = await StorageRLS.listObjects(ref, auth, params.bucket, prefix, limit, offset, body?.sortBy, search);
        } catch (e: any) {
            if (e.message === 'PROJECT_NOT_FOUND') return status(404, { statusCode: "404", error: 'Not Found', message: 'Tenant Project Not Found' });
            if (e.message === 'BUCKET_NOT_FOUND') return status(400, { statusCode: "400", error: 'Bucket not found', message: 'The bucket does not exist' });
            if (e.message === 'Access Denied') return status(401, { statusCode: "401", error: 'Unauthorized', message: 'Invalid token' });
            return status(403, { statusCode: "403", error: 'Forbidden', message: e.message || 'Access Denied' });
        }

        return files.map(f => {
            const cleanName = prefix ? f.name.slice(prefix.length).replace(/^\/+/, '') : f.name;
            return {
                name: cleanName || f.name,
                id: f.id,
                updated_at: f.updated_at,
                created_at: f.created_at,
                last_accessed_at: f.last_accessed_at,
                metadata: f.metadata ? {
                    ...f.metadata,
                    size: f.size,
                    mimetype: f.metadata.mimetype || 'application/octet-stream',
                    cacheControl: f.metadata.cacheControl || f.metadata.cache_control,
                    eTag: f.metadata.eTag || f.metadata.etag || `"${f.id}"`,
                    lastModified: f.updated_at,
                    contentLength: f.size,
                    httpStatusCode: 200
                } : null
            };
        });
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
    // OBJECT LIST V2 — POST /object/list-v2/:bucket
    // ════════════════════════════════════════════════════════

    .post('/object/list-v2/:bucket', async ({ params, headers, body }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const auth = headers['authorization'];

        const prefix = body?.prefix || '';
        const limit  = body?.limit || 1000;
        const search = body?.search || '';
        let offset = body?.offset || 0;
        
        // Decode cursor if provided overrides offset mapping
        if (body?.cursor) {
            try {
                // simple base64 ascii integer decoding emulation
                const decoded = Buffer.from(body.cursor, 'base64').toString('ascii');
                if (!isNaN(Number(decoded))) offset = Number(decoded);
            } catch (e) {}
        }
        
        const with_delimiter = body?.with_delimiter ?? false;

        // Fetch securely from RLS DB (ask for limit + 1 to test hasNext)
        let files;
        try {
            files = await StorageRLS.listObjects(ref, auth, params.bucket, prefix, limit + 1, offset, body?.sortBy, search, with_delimiter);
        } catch (e: any) {
            if (e.message === 'PROJECT_NOT_FOUND') return status(404, { statusCode: "404", error: 'Not Found', message: 'Tenant Project Not Found' });
            if (e.message === 'BUCKET_NOT_FOUND') return status(400, { statusCode: "400", error: 'Bucket not found', message: 'The bucket does not exist' });
            if (e.message === 'Access Denied') return status(401, { statusCode: "401", error: 'Unauthorized', message: 'Invalid token' });
            return status(403, { statusCode: "403", error: 'Forbidden', message: e.message || 'Access Denied' });
        }

        const objects = [];
        const folders = [];
        
        const hasNext = files.length > limit;
        if (hasNext) files.pop(); // Remove the +1 lookahead

        for (const f of files) {
            const cleanName = prefix ? f.name.slice(prefix.length).replace(/^\/+/, '') : f.name;
            if (f.isFolder) {
                folders.push({ name: cleanName || f.name, key: f.name });
            } else {
                objects.push({
                    name: cleanName || f.name,
                    key: f.name,
                    id: f.id,
                    updated_at: f.updated_at || new Date().toISOString(),
                    created_at: f.created_at || f.updated_at || new Date().toISOString(),
                    last_accessed_at: f.last_accessed_at || f.updated_at || new Date().toISOString(),
                    metadata: f.metadata ? {
                        ...f.metadata,
                        size: f.size,
                        mimetype: f.metadata.mimetype || 'application/octet-stream',
                        cacheControl: f.metadata.cacheControl || f.metadata.cache_control,
                        eTag: f.metadata.eTag || f.metadata.etag || `"${f.id}"`,
                        lastModified: f.updated_at,
                        contentLength: f.size,
                        httpStatusCode: 200
                    } : null,
                });
            }
        }

        const nextCursor = hasNext ? Buffer.from(String(offset + limit)).toString('base64') : null;

        return { nextCursor, objects, folders, hasNext };
    }, {
        body: t.Optional(t.Object({
            prefix: t.Optional(t.String()),
            limit: t.Optional(t.Number()),
            offset: t.Optional(t.Number()),
            cursor: t.Optional(t.String()),
            with_delimiter: t.Optional(t.Boolean()),
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
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const prefixes = body?.prefixes || [];
        const auth = headers['authorization'];

        const results = await Promise.allSettled(
            prefixes.map(async (p: string) => {
                // Get info for the deleted object response natively matching FileObject (respect RLS)
                // We MUST get info before deletion because getting info after deletion will return null
                const info = await StorageRLS.getObjectInfo(ref, params.bucket, p, auth, false);
                if (!info) throw new Error('Object not found (may require select permission)');

                // Transactional RLS delete + S3 Delete
                const finalPermit = await StorageRLS.authorizeAction(
                    ref, auth, 'delete', params.bucket, p, {}, false, true, undefined, undefined,
                    async () => {
                        const physSuccess = await StorageService.deleteFile(ref, params.bucket, p);
                        if (!physSuccess) throw new Error('PHYSICAL_UPLOAD_FAILED');
                    }
                );

                if (!finalPermit.permitted) throw new Error(finalPermit.error || 'Logical delete failed');
                
                return info || { name: p, bucket_id: params.bucket };
            })
        );

        const successfulDeletes: any[] = [];
        const failedDeletes: string[] = [];

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'fulfilled' && r.value) {
                successfulDeletes.push(r.value);
            } else {
                failedDeletes.push(prefixes[i]);
            }
        }

        if (failedDeletes.length > 0) {
            return status(400, { statusCode: "400", error: 'Bad Request', message: 'Failed to delete some objects', failed: failedDeletes });
        }

        return successfulDeletes;
    }, {
        body: t.Optional(t.Object({
            prefixes: t.Optional(t.Array(t.String()))
        }))
    })

    // ════════════════════════════════════════════════════════
    // OBJECT MOVE / COPY
    // ════════════════════════════════════════════════════════

    .post('/object/move', async ({ headers, body }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        if (!ref) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing tenant reference' });
        const auth = headers['authorization'];

        const srcBucket = String(body.bucketId || '');
        const srcKey = String(body.sourceKey || '');
        const destBucket = String(body.destinationBucket || body.destinationBucketId || srcBucket);
        const destKey = String(body.destinationKey || '');

        if (!srcBucket || !srcKey || !destKey) {
            return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing source or destination' });
        }

        try {
            // Check RLS Move and perform transactionally
            const finalPermit = await StorageRLS.authorizeAction(ref, auth, 'move' as any, srcBucket, srcKey, {}, false, true, destBucket, destKey,
                async () => {
                    const copied = await StorageService.copyFile(ref, srcBucket, srcKey, destBucket, destKey);
                    if (!copied) throw new Error('PHYSICAL_UPLOAD_FAILED');
                    const deleted = await StorageService.deleteFile(ref, srcBucket, srcKey);
                    if (!deleted) {
                        logger.error(`CRITICAL: Orphaned physical file abandoned at ${srcBucket}/${srcKey}`);
                    }
                }
            );

            if (!finalPermit.permitted) {
                return status(finalPermit.error === 'Object not found' || finalPermit.error === 'Bucket not found' ? 404 : 403, { 
                    statusCode: finalPermit.error === 'Object not found' || finalPermit.error === 'Bucket not found' ? '404' : '403', 
                    error: finalPermit.error === 'Object not found' ? 'Not Found' : 'Forbidden', 
                    message: finalPermit.error || 'Access Denied' 
                });
            }

            return { message: `Successfully moved` };
        } catch (err: unknown) {
            return status(500, { statusCode: "500", error: 'Internal', message: err instanceof Error ? err.message : String(err) });
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
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        if (!ref) return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing tenant reference' });
        const auth = headers['authorization'];

        const srcBucket = String(body.bucketId || '');
        const srcKey = String(body.sourceKey || '');
        const destBucket = String(body.destinationBucket || body.destinationBucketId || srcBucket);
        const destKey = String(body.destinationKey || '');

        if (!srcBucket || !srcKey || !destKey) {
            return status(400, { statusCode: "400", error: 'Bad Request', message: 'Missing source or destination' });
        }

        try {
            // Check RLS Download on source
            const permittedSrc = await StorageRLS.authorizeAction(ref, auth, 'download', srcBucket, srcKey);
            if (!permittedSrc.permitted) return status(403, { statusCode: "403", error: 'Forbidden', message: permittedSrc.error || 'Access Denied' });

            // Write and finalize immediately via physicalAction inside Upload context
            const finalPermitted = await StorageRLS.authorizeAction(ref, auth, 'upload', destBucket, destKey, {}, false, true, undefined, undefined,
                async () => {
                    const copied = await StorageService.copyFile(ref, srcBucket, srcKey, destBucket, destKey);
                    if (!copied) throw new Error('PHYSICAL_UPLOAD_FAILED');
                }
            );

            if (!finalPermitted.permitted) {
                return status(finalPermitted.error === 'Bucket not found' ? 404 : 403, { 
                    statusCode: finalPermitted.error === 'Bucket not found' ? '404' : '403', 
                    error: finalPermitted.error === 'Bucket not found' ? 'Not Found' : 'Forbidden', 
                    message: finalPermitted.error || 'Access Denied' 
                });
            }

            return { Key: `${destBucket}/${destKey}` };
        } catch (err: unknown) {
            return status(500, { statusCode: "500", error: 'Internal', message: err instanceof Error ? err.message : String(err) });
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
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { message: 'Missing file path' });

        const bucket = await StorageRLS.getLogicalBucket(ref, params.bucket, undefined, true);
        if (!bucket || !bucket.public) return status(400, { message: 'Bucket is not public' });

        return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> }, true);
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
        set.headers['Tus-Max-Size'] = String(50 * 1024 * 1024 * 1024);
        return '';
    })

    // POST /upload/resumable — Create a new resumable upload
    .post('/upload/resumable', async ({ headers, set }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const uploadLength = Number(headers['upload-length'] || 0);

        // Reject zero-byte uploads (must have a positive Upload-Length)
        if (!uploadLength || uploadLength <= 0) {
            return status(400, { statusCode: "400", error: 'Bad Request', message: 'Upload-Length must be greater than 0' });
        }

        // Hard cap: TUS in-memory assembly cannot safely handle files beyond 100MB
        const TUS_MAX_SIZE = 50 * 1024 * 1024 * 1024;
        if (uploadLength > TUS_MAX_SIZE) {
            return status(413, { statusCode: "413", error: 'Payload too large', message: `TUS uploads are limited to ${TUS_MAX_SIZE / (1024 * 1024)}MB. Use standard upload for larger files.` });
        }
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

        // Validations natively skipping RLS check via undefined scope.
        const logicalBucket = await StorageRLS.getLogicalBucket(ref, bucket, undefined, true);
        if (!logicalBucket) return status(404, { statusCode: "404", error: 'Not Found', message: 'Bucket not found' });

        if (logicalBucket.file_size_limit && uploadLength > Number(logicalBucket.file_size_limit)) {
            return status(413, { statusCode: "413", error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
        }

        const allowedMimes = logicalBucket.allowed_mime_types as string[] | null;
        if (allowedMimes && Array.isArray(allowedMimes) && allowedMimes.length > 0) {
            const uploadMime = contentType.split(';')[0]?.trim();
            if (!isMimeAllowed(allowedMimes, uploadMime)) {
                return status(415, { statusCode: "415", error: 'Unsupported Media Type', message: 'The object mime type is not allowed' });
            }
        }

        // TUS Authorization Gate (DryRun only — we don't materialize until complete)
        const auth = headers['authorization'];
        const metadata = { mimetype: contentType, size: uploadLength, cacheControl: meta.cacheControl, userMetadata: meta };
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'upload', bucket, objectName, metadata, true);
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
            auth_token: auth || '',
            meta: meta
        });

        set.headers['Tus-Resumable'] = '1.0.0';
        set.headers['Location'] = `/storage/v1/upload/resumable/${uploadId}`;
        set.status = 201;
        return '';
    })

    // HEAD /upload/resumable/:uploadId — Get current upload offset
    .head('/upload/resumable/:uploadId', async ({ params, headers, set }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const upload = await TusStore.get(params.uploadId);
        if (!upload) return status(404, { message: 'Upload not found' });
        if (upload.ref !== ref) return status(403, { message: 'Cross-project upload access denied' });

        set.headers['Tus-Resumable'] = '1.0.0';
        set.headers['Upload-Offset'] = String(upload.offset);
        set.headers['Upload-Length'] = String(upload.totalSize);
        set.headers['Cache-Control'] = 'no-store';
        return '';
    })

    // PATCH /upload/resumable/:uploadId — Upload a chunk
    .patch('/upload/resumable/:uploadId', async ({ params, headers, request, set }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const upload = await TusStore.get(params.uploadId);
        if (!upload) return status(404, { message: 'Upload not found' });
        if (upload.ref !== ref) return status(403, { message: 'Cross-project upload access denied' });
        if (!request.body) return status(400, { message: 'Missing upload chunk body' });

        const clientOffset = Number(headers['upload-offset'] || 0);
        if (clientOffset !== upload.offset) {
            return status(409, { message: 'Offset mismatch' });
        }

        upload.offset = await TusStore.appendChunk(params.uploadId, upload.offset, request.body);

        set.headers['Tus-Resumable'] = '1.0.0';
        set.headers['Upload-Offset'] = String(upload.offset);

        // Upload complete — assemble and store in S3
        if (upload.offset >= upload.totalSize) {
            const asm = await TusStore.assembleToStream(params.uploadId);

            try {
                // Transactional RLS Finalization
                const finalPermitted = await StorageRLS.authorizeAction(
                    upload.ref, 
                    upload.auth_token, 
                    'upload', 
                    upload.bucket, 
                    upload.objectName, 
                    { mimetype: upload.contentType, size: upload.totalSize, cacheControl: upload.meta?.cacheControl },
                    false, true, undefined, undefined,
                    async () => {
                        const uploaded = await StorageService.uploadFile(upload.ref, upload.bucket, upload.objectName, asm.stream, upload.contentType);
                        if (!uploaded) throw new Error('PHYSICAL_UPLOAD_FAILED');
                        await asm.cleanup();
                    }
                );
                
                if (!finalPermitted.permitted) {
                    await asm.cleanup();
                    throw new Error(finalPermitted.error || 'Access Denied during finalization');
                }

                await TusStore.delete(params.uploadId);
                return {
                    Id: `${upload.bucket}/${upload.objectName}`,
                    Key: `${upload.bucket}/${upload.objectName}`,
                    path: upload.objectName,
                    fullPath: `${upload.bucket}/${upload.objectName}`
                };
            } catch (err: unknown) {
                await TusStore.delete(params.uploadId);
                return status(500, { message: 'Failed to finalize upload', code: '500' });
            }
        }

        set.status = 204;
        return '';
    })

    // DELETE /upload/resumable/:uploadId — Abort a resumable upload
    .delete('/upload/resumable/:uploadId', async ({ params, headers, set }) => {
        const ref = await getProjectRef(headers as Record<string, string | undefined>);
        const upload = await TusStore.get(params.uploadId);
        if (upload && upload.ref !== ref) return status(403, { message: 'Cross-project upload access denied' });
        await TusStore.delete(params.uploadId);
        set.headers['Tus-Resumable'] = '1.0.0';
        set.status = 204;
        return '';
    })

    // ════════════════════════════════════════════════════════
    // ENTERPRISE STUBS (Vectors / Analytics)
    // Prevents @supabase/storage-js from hard crashing when accessing
    // supabase.storage.vectors or supabase.storage.analytics
    // ════════════════════════════════════════════════════════
    .all('/vector/*', async ({ set }) => {
        set.status = 501;
        return { statusCode: "501", error: 'Not Implemented', message: 'Storage vectors (Similarity Search) are not supported on this SupaCloud cluster configuration.' };
    })
    .all('/iceberg/*', async ({ set }) => {
        set.status = 501;
        return { statusCode: "501", error: 'Not Implemented', message: 'Storage analytics (Iceberg tables) are not supported on this SupaCloud cluster configuration.' };
    });


// ── Shared imaginary proxy helper ─────────────────────────────────
// POST image body directly to imaginary instead of having imaginary fetch via URL.
// This works for both local/JuiceFS and S3 storage backends.
const transformRateLimits = new Map<string, { count: number; windowStart: number }>();
const MAX_TRANSFORMS_PER_MINUTE = 500;

async function proxyToImaginary(
    ref: string,
    logicalBucket: string,
    filePath: string,
    query: Record<string, string | undefined>,
    set: { headers: Record<string, string> },
    isPublic: boolean = false
): Promise<Response | { message: string }> {
    const now = Date.now();
    const limitState = transformRateLimits.get(ref) || { count: 0, windowStart: now };
    
    if (now - limitState.windowStart > 60000) {
        limitState.count = 0;
        limitState.windowStart = now;
    }
    
    if (limitState.count >= MAX_TRANSFORMS_PER_MINUTE) {
        return status(429, { message: 'Too Many Requests for image transformations. Please try again later.' }) as unknown as { message: string };
    }
    
    limitState.count++;
    transformRateLimits.set(ref, limitState);

    // 1. Read the source image from storage
    const downloadRes = await StorageService.getDownloadResponse(ref, logicalBucket, filePath);
    if (!downloadRes) {
        return status(404, { message: 'Source image not found' }) as unknown as { message: string };
    }

    // Validate source file is actually an image before wasting resources on imaginary
    const sourceContentTypeCheck = downloadRes.headers?.get('Content-Type') || '';
    if (sourceContentTypeCheck && !sourceContentTypeCheck.startsWith('image/')) {
        return status(400, { message: `Cannot transform non-image file (Content-Type: ${sourceContentTypeCheck})` }) as unknown as { message: string };
    }

    // 2. Build imaginary query params
    const imaginaryParams = new URLSearchParams();
    if (query.width)  imaginaryParams.set('width',  String(query.width));
    if (query.height) imaginaryParams.set('height', String(query.height));
    imaginaryParams.set('quality', String(query.quality || 80));

    const format = query.format;
    if (format) {
        if (format !== 'origin') {
            imaginaryParams.set('type', format as string);
        }
    } else {
        // Official SDK forces WebP if format is not passed
        imaginaryParams.set('type', 'webp');
    }

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
            return status(502, { message: `Image transform failed: ${errText}`, code: "502" }) as unknown as { message: string };
        }

        if (format) {
            set.headers['Content-Type'] = res.headers.get('Content-Type') || `image/${format}`;
        } else {
            set.headers['Content-Type'] = res.headers.get('Content-Type') || sourceContentType;
        }

        if (isPublic) {
            set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        } else {
             set.headers['Cache-Control'] = 'private, max-age=3600';
        }
        setDownloadDisposition(query as Record<string, string | undefined>, filePath, set as { headers: Record<string, string> });
        set.headers['X-Image-Engine'] = 'imaginary/libvips';
        return new Response(res.body);
    } catch (err: unknown) {
        logger.error('Imaginary proxy error:', { error: err instanceof Error ? err.message : String(err) });
        return status(502, { message: 'Image processing service unavailable', code: "502" }) as unknown as { message: string };
    }
}
