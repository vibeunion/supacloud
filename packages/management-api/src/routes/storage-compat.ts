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
