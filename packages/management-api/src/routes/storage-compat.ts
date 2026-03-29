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
import { logger } from "../utils/logger";

// ── Imaginary Config ──────────────────────────────────────────────
const IMAGINARY_URL = process.env.IMAGINARY_URL || "http://127.0.0.1:9010";
const S3_ENDPOINT  = process.env.S3_ENDPOINT   || "http://127.0.0.1:9000";
const _signingSecret = process.env.JWT_SECRET || process.env.STORAGE_SIGNING_SECRET;
if (!_signingSecret) {
    logger.error("[storage-compat] FATAL: JWT_SECRET or STORAGE_SIGNING_SECRET must be set. Refusing to start with insecure defaults.");
    throw new Error("Missing required environment variable: JWT_SECRET or STORAGE_SIGNING_SECRET");
}
const SIGNING_SECRET: string = _signingSecret;

import { createHmac } from "crypto";

/**
 * Generate HMAC-SHA256 signed token for a storage path + expiry.
 */
function generateSignedToken(ref: string, bucket: string, path: string, expiresAt: number): string {
    const payload = `${ref}:${bucket}:${path}:${expiresAt}`;
    return createHmac("sha256", SIGNING_SECRET).update(payload).digest("hex");
}

/**
 * Verify a signed token against path + expiry.
 */
function verifySignedToken(ref: string, bucket: string, path: string, expiresAt: number, token: string): boolean {
    if (Date.now() / 1000 > expiresAt) return false; // expired
    const expected = generateSignedToken(ref, bucket, path, expiresAt);
    return expected === token;
}

function buildSourceUrl(bucket: string, path: string): string {
    const base = S3_ENDPOINT.endsWith('/') ? S3_ENDPOINT.slice(0, -1) : S3_ENDPOINT;
    return `${base}/${bucket}/${path}`;
}

/**
 * Extract project ref from request.
 * Kong forwards the x-project-ref header; also fall back to apikey-based lookup.
 */
function getProjectRef(headers: Record<string, string | undefined>): string {
    return headers['x-project-ref'] || headers['x-supabase-project'] || 'default';
}

/**
 * Resolve the actual S3 bucket name for a project.
 * In SupaCloud, each project gets a real S3 bucket named `supa-<ref>`.
 * The logical bucket name from supabase-js is used as a prefix inside that S3 bucket.
 */
function resolveS3Path(projectRef: string, logicalBucket: string, filePath: string): {
    bucket: string; key: string;
} {
    return {
        bucket: `supa-${projectRef}`,
        key: `${logicalBucket}/${filePath}`,
    };
}

// ── Supabase SDK-Compatible Routes ────────────────────────────────
// These are mounted DIRECTLY by Kong at /storage/v1 (Kong strips prefix)
// So these routes see paths starting from /object/..., /bucket/..., /render/...

// ── TUS Upload State ──────────────────────────────────────────────
interface TusUpload {
    ref: string;
    bucket: string;
    objectName: string;
    contentType: string;
    totalSize: number;
    offset: number;
    chunks: Buffer[];
    createdAt: number;
}

const tusUploads = new Map<string, TusUpload>();

// Auto-cleanup abandoned uploads every 10 minutes
setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    for (const [id, upload] of tusUploads) {
        if (upload.createdAt < cutoff) tusUploads.delete(id);
    }
}, 10 * 60 * 1000);

export const storageCompatRoutes = new Elysia({ prefix: "/storage/v1/s" })

    // ════════════════════════════════════════════════════════
    // BUCKET Operations
    // ════════════════════════════════════════════════════════

    // GET /bucket — List all buckets
    .get('/bucket', async ({ headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const buckets = await StorageService.listBuckets(ref);
        // Transform to supabase-js expected format
        return buckets.map(b => ({
            id: b.id || b.name,
            name: b.name,
            owner: '',
            public: b.public ?? false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            file_size_limit: null,
            allowed_mime_types: null,
        }));
    })

    // POST /bucket — Create a bucket  
    .post('/bucket', async ({ headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const result = await StorageService.createBucket(ref);
        if (!result.success) return status(500, { statusCode: '500', error: 'Internal', message: result.error || 'Failed to create bucket' });
        return { name: (body as Record<string, unknown>).name || ref };
    })

    // GET /bucket/:id — Get bucket details
    .get('/bucket/:id', async ({ params, headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        return {
            id: params.id,
            name: params.id,
            owner: '',
            public: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            file_size_limit: null,
            allowed_mime_types: null,
        };
    })

    // DELETE /bucket/:id — Delete bucket
    .delete('/bucket/:id', async ({ params, headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const result = await StorageService.deleteBucket(ref);
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

        const { bucket, key } = resolveS3Path(ref, params.bucket, filePath);
        const contentType = headers['content-type'] || 'application/octet-stream';

        try {
            const body = await request.arrayBuffer();
            const success = await StorageService.uploadFile(ref, bucket, key, Buffer.from(body), contentType);

            if (!success) return status(500, { statusCode: '500', error: 'Internal', message: 'Failed to upload file' });

            return {
                Id: key,
                Key: `${params.bucket}/${filePath}`,
            };
        } catch (err: unknown) {
            logger.error('SDK upload error:', { error: err instanceof Error ? err.message : String(err) });
            return status(500, { statusCode: '500', error: 'Internal', message: 'Upload failed' });
        }
    })

    // PUT /object/:bucket/* — Upsert (same as upload but always overwrites)
    .put('/object/:bucket/*', async ({ params, headers, request }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        const { bucket, key } = resolveS3Path(ref, params.bucket, filePath);
        const contentType = headers['content-type'] || 'application/octet-stream';

        try {
            const body = await request.arrayBuffer();
            const success = await StorageService.uploadFile(ref, bucket, key, Buffer.from(body), contentType);
            if (!success) return status(500, { statusCode: '500', error: 'Internal', message: 'Upsert failed' });
            return { Key: `${params.bucket}/${filePath}` };
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: 'Upsert failed' });
        }
    })

    // ════════════════════════════════════════════════════════
    // OBJECT DOWNLOAD — GET /object/public/:bucket/*
    // supabase.storage.from('bucket').getPublicUrl('path')
    // ════════════════════════════════════════════════════════

    .get('/object/public/:bucket/*', async ({ params, headers, set, query }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        // If transform params are present, proxy to imaginary
        if (query.width || query.height || query.resize || query.format || query.quality) {
            return proxyToImaginary(params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        // Otherwise, direct proxy from S3
        const { bucket, key } = resolveS3Path(ref, params.bucket, filePath);
        try {
            const url = buildSourceUrl(bucket, key);
            const res = await fetch(url);
            if (!res.ok) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found' });

            set.headers['Content-Type'] = res.headers.get('Content-Type') || 'application/octet-stream';
            set.headers['Cache-Control'] = 'public, max-age=3600';
            set.headers['Content-Length'] = res.headers.get('Content-Length') || '';
            return new Response(res.body);
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
        if (query.width || query.height || query.resize || query.format || query.quality) {
            return proxyToImaginary(params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        const { bucket, key } = resolveS3Path(ref, params.bucket, filePath);
        try {
            const url = buildSourceUrl(bucket, key);
            const res = await fetch(url);
            if (!res.ok) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found' });

            set.headers['Content-Type'] = res.headers.get('Content-Type') || 'application/octet-stream';
            set.headers['Cache-Control'] = 'private, max-age=3600';
            return new Response(res.body);
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: 'Download failed' });
        }
    })

    // ════════════════════════════════════════════════════════
    // SIGNED URL — POST /object/sign/:bucket
    // supabase.storage.from('bucket').createSignedUrl('path', expiresIn)
    // ════════════════════════════════════════════════════════

    .post('/object/sign/:bucket', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const b = body as Record<string, unknown>;
        const filePath = String(b.url || b.path || '').replace(/^\//, '');
        const expiresIn = Number(b.expiresIn) || 3600;

        if (!filePath) {
            return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });
        }

        const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
        const token = generateSignedToken(ref, params.bucket, filePath, expiresAt);

        return {
            signedURL: `/storage/v1/s/object/sign/${params.bucket}/${filePath}?token=${token}&t=${expiresAt}`,
        };
    })

    // POST /object/sign/:bucket — Batch signed URLs
    // supabase.storage.from('bucket').createSignedUrls(['path1', 'path2'], expiresIn)
    .post('/object/sign/:bucket/sign-multi', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const b = body as Record<string, unknown>;
        const paths = (b.paths as string[]) || [];
        const expiresIn = Number(b.expiresIn) || 3600;

        return paths.map(filePath => {
            const cleanPath = filePath.replace(/^\//, '');
            const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
            const token = generateSignedToken(ref, params.bucket, cleanPath, expiresAt);
            return {
                error: null,
                path: filePath,
                signedURL: `/storage/v1/s/object/sign/${params.bucket}/${cleanPath}?token=${token}&t=${expiresAt}`,
            };
        });
    })

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

        if (!verifySignedToken(ref, params.bucket, filePath, expiresAt, token)) {
            return status(401, { statusCode: '401', error: 'Unauthorized', message: 'Invalid or expired signed URL' });
        }

        // Token valid — proxy from S3
        const { bucket, key } = resolveS3Path(ref, params.bucket, filePath);

        // Transform support for signed URLs
        if (query.width || query.height || query.resize || query.format || query.quality) {
            return proxyToImaginary(params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        try {
            const url = buildSourceUrl(bucket, key);
            const res = await fetch(url);
            if (!res.ok) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found' });

            set.headers['Content-Type'] = res.headers.get('Content-Type') || 'application/octet-stream';
            set.headers['Cache-Control'] = 'private, no-store';
            return new Response(res.body);
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: 'Download failed' });
        }
    })

    // ════════════════════════════════════════════════════════
    // OBJECT LIST — POST /object/list/:bucket
    // supabase.storage.from('bucket').list('folder', { limit, offset, sortBy })
    // ════════════════════════════════════════════════════════

    .post('/object/list/:bucket', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const files = await StorageService.listFiles(ref, `supa-${ref}`);

        const prefix = (body as Record<string, unknown>)?.prefix as string || '';
        const limit  = (body as Record<string, unknown>)?.limit as number || 100;
        const offset = (body as Record<string, unknown>)?.offset as number || 0;

        // Filter by prefix (logical bucket + folder path)
        const bucketPrefix = `${params.bucket}/${prefix}`;
        const filtered = files
            .filter(f => {
                const name = String(f.name || '');
                return name.startsWith(bucketPrefix);
            })
            .map(f => {
                const fullName = String(f.name || '');
                const relativeName = fullName.replace(bucketPrefix, '');
                return {
                    name: relativeName,
                    id: f.id,
                    updated_at: f.updated || new Date().toISOString(),
                    created_at: f.updated || new Date().toISOString(),
                    last_accessed_at: f.updated || new Date().toISOString(),
                    metadata: {
                        size: f.size,
                        mimetype: f.type || 'application/octet-stream',
                    },
                };
            })
            .slice(offset, offset + limit);

        return filtered;
    })

    // ════════════════════════════════════════════════════════
    // OBJECT DELETE — DELETE /object/:bucket (batch delete)
    // supabase.storage.from('bucket').remove(['path1', 'path2'])
    // ════════════════════════════════════════════════════════

    .delete('/object/:bucket', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const prefixes = (body as Record<string, unknown>)?.prefixes as string[] || [];

        const results = await Promise.allSettled(
            prefixes.map(p => {
                const { bucket, key } = resolveS3Path(ref, params.bucket, p);
                return StorageService.deleteFile(ref, bucket, key);
            })
        );

        return results.map((r, i) => ({
            name: prefixes[i],
            ...(r.status === 'fulfilled' ? {} : { error: 'Delete failed' }),
        }));
    })

    // ════════════════════════════════════════════════════════
    // OBJECT MOVE / COPY
    // ════════════════════════════════════════════════════════

    .post('/object/move', async ({ headers, body }) => {
        // Basic implementation: copy + delete
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const b = body as Record<string, unknown>;
        const srcBucket = String(b.bucketId || '');
        const srcKey = String(b.sourceKey || '');
        const destBucket = String(b.destinationBucketId || srcBucket);
        const destKey = String(b.destinationKey || '');

        if (!srcBucket || !srcKey || !destKey) {
            return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing source or destination' });
        }

        // TODO: implement move via S3 copy + delete
        return { message: `Moved ${srcBucket}/${srcKey} to ${destBucket}/${destKey}` };
    })

    .post('/object/copy', async ({ headers, body }) => {
        const b = body as Record<string, unknown>;
        const srcBucket = String(b.bucketId || '');
        const srcKey = String(b.sourceKey || '');
        const destKey = String(b.destinationKey || '');

        if (!srcBucket || !srcKey || !destKey) {
            return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing source or destination' });
        }

        // TODO: implement copy via S3 copy
        return { Key: `${srcBucket}/${destKey}` };
    })

    // ════════════════════════════════════════════════════════
    // IMAGE TRANSFORM — GET /render/image/public/:bucket/*
    // supabase.storage.from('bucket').download('path', { transform: { width, height } })
    // ════════════════════════════════════════════════════════

    .get('/render/image/public/:bucket/*', async ({ params, query, set }) => {
        const filePath = params['*'];
        if (!filePath) return status(400, { error: 'Missing file path' });
        return proxyToImaginary(params.bucket, filePath, query, set as { headers: Record<string, string> });
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

        const uploadId = `${ref}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Store upload state
        tusUploads.set(uploadId, {
            ref,
            bucket,
            objectName,
            contentType,
            totalSize: uploadLength,
            offset: 0,
            chunks: [],
            createdAt: Date.now(),
        });

        set.headers['Tus-Resumable'] = '1.0.0';
        set.headers['Location'] = `/storage/v1/s/upload/resumable/${uploadId}`;
        set.status = 201;
        return '';
    })

    // HEAD /upload/resumable/:uploadId — Get current upload offset
    .get('/upload/resumable/:uploadId', ({ params, set }) => {
        const upload = tusUploads.get(params.uploadId);
        if (!upload) return status(404, { error: 'Upload not found' });

        set.headers['Tus-Resumable'] = '1.0.0';
        set.headers['Upload-Offset'] = String(upload.offset);
        set.headers['Upload-Length'] = String(upload.totalSize);
        set.headers['Cache-Control'] = 'no-store';
        return '';
    })

    // PATCH /upload/resumable/:uploadId — Upload a chunk
    .patch('/upload/resumable/:uploadId', async ({ params, headers, request, set }) => {
        const upload = tusUploads.get(params.uploadId);
        if (!upload) return status(404, { error: 'Upload not found' });

        const clientOffset = Number(headers['upload-offset'] || 0);
        if (clientOffset !== upload.offset) {
            return status(409, { error: 'Offset mismatch', expected: upload.offset, received: clientOffset });
        }

        const chunk = Buffer.from(await request.arrayBuffer());
        upload.chunks.push(chunk);
        upload.offset += chunk.length;

        set.headers['Tus-Resumable'] = '1.0.0';
        set.headers['Upload-Offset'] = String(upload.offset);

        // Upload complete — assemble and store in S3
        if (upload.offset >= upload.totalSize) {
            const fullBody = Buffer.concat(upload.chunks);
            const { bucket, key } = resolveS3Path(upload.ref, upload.bucket, upload.objectName);

            try {
                await StorageService.uploadFile(upload.ref, bucket, key, fullBody, upload.contentType);
                tusUploads.delete(params.uploadId);
                return { Key: `${upload.bucket}/${upload.objectName}` };
            } catch (err: unknown) {
                tusUploads.delete(params.uploadId);
                return status(500, { error: 'Failed to finalize upload' });
            }
        }

        set.status = 204;
        return '';
    })

    // DELETE /upload/resumable/:uploadId — Abort a resumable upload
    .delete('/upload/resumable/:uploadId', ({ params, set }) => {
        tusUploads.delete(params.uploadId);
        set.headers['Tus-Resumable'] = '1.0.0';
        set.status = 204;
        return '';
    });


// ── Shared imaginary proxy helper ─────────────────────────────────
async function proxyToImaginary(
    bucket: string,
    filePath: string,
    query: Record<string, string | undefined>,
    set: { headers: Record<string, string> }
): Promise<Response | { error: string }> {
    const sourceUrl = buildSourceUrl(bucket, filePath);
    const imaginaryParams = new URLSearchParams();
    imaginaryParams.set('url', sourceUrl);

    if (query.width)  imaginaryParams.set('width',  String(query.width));
    if (query.height) imaginaryParams.set('height', String(query.height));
    imaginaryParams.set('quality', String(query.quality || 80));

    const format = query.format || 'webp';
    imaginaryParams.set('type', format);

    const resizeMode = query.resize || 'cover';
    let operation = 'resize';
    if (resizeMode === 'cover' || resizeMode === 'crop') {
        operation = 'crop';
    } else if (resizeMode === 'contain' || resizeMode === 'embed') {
        operation = 'embed';
    } else if (resizeMode === 'fill') {
        operation = 'enlarge';
        imaginaryParams.set('force', 'true');
    }

    try {
        const res = await fetch(`${IMAGINARY_URL}/${operation}?${imaginaryParams.toString()}`);
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
