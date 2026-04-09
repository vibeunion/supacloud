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
import { StorageRLS } from "../services/storage-rls";
import { logger } from "../utils/logger";
import { config } from "../config";

// ── Imaginary Config ──────────────────────────────────────────────
const IMAGINARY_URL = config.imaginaryUrl;

// Lazy-init: validate signing secret on first use, not at module load
// This prevents test suites from crashing when importing the app module
let _cachedSigningSecret: string | undefined;
function getSigningSecret(): string {
    if (!_cachedSigningSecret) {
        _cachedSigningSecret = config.jwtSecret || config.storageSigningSecret;
        if (!_cachedSigningSecret) {
            throw new Error("Missing required environment variable: JWT_SECRET or STORAGE_SIGNING_SECRET");
        }
    }
    return _cachedSigningSecret;
}

import { createHmac } from "crypto";

/**
 * Generate HMAC-SHA256 signed token for a storage path + expiry.
 */
function generateSignedToken(ref: string, bucket: string, path: string, expiresAt: number): string {
    const payload = `${ref}:${bucket}:${path}:${expiresAt}`;
    return createHmac("sha256", getSigningSecret()).update(payload).digest("hex");
}

/**
 * Extract a file chunk from a raw multipart/form-data buffer, skipping standard Parsers
 * to bypass Bun's name="" dropping bug.
 */
function extractMultipartFileFast(buffer: Buffer, boundary: string): { fileBuffer: Buffer, mimeType: string } | null {
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    let searchPos = 0;

    while (searchPos < buffer.length) {
        const partStart = buffer.indexOf(boundaryBuffer, searchPos);
        if (partStart === -1) break;

        const contentStart = partStart + boundaryBuffer.length;
        const nextBoundaryPos = buffer.indexOf(boundaryBuffer, contentStart);
        if (nextBoundaryPos === -1) break;

        const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), contentStart);
        if (headerEnd !== -1 && headerEnd < nextBoundaryPos) {
            const headersRow = buffer.subarray(contentStart, headerEnd).toString('utf-8');
            if (headersRow.includes('filename=') || headersRow.includes('Content-Type:')) {
                let mimeType = 'application/octet-stream';
                const typeMatch = headersRow.match(/Content-Type:\s*([^\r\n]+)/i);
                if (typeMatch) mimeType = typeMatch[1].trim();

                let fileStart = headerEnd + 4;
                let fileEnd = nextBoundaryPos - 2; 

                if (fileEnd > fileStart) {
                    return {
                        fileBuffer: buffer.subarray(fileStart, fileEnd),
                        mimeType
                    };
                }
            }
        }
        searchPos = nextBoundaryPos;
    }
    return null;
}

/**
 * Verify a signed token against path + expiry.
 */
function verifySignedToken(ref: string, bucket: string, path: string, expiresAt: number, token: string): boolean {
    if (Date.now() / 1000 > expiresAt) return false; // expired
    const expected = generateSignedToken(ref, bucket, path, expiresAt);
    return expected === token;
}

/**
 * Extract project ref from request.
 * Kong forwards the x-project-ref header; also fall back to apikey-based lookup.
 */
function getProjectRef(headers: Record<string, string | undefined>): string {
    return headers['x-project-ref'] || headers['x-supabase-project'] || 'default';
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
        
        // 1. Create S3 namespace
        const result = await StorageService.createBucket(ref);
        if (!result.success) return status(500, { statusCode: '500', error: 'Internal', message: result.error || 'Failed to create bucket in S3 layer' });
        
        // 2. Register bucket in Postgres `storage.buckets` so RLS foreign keys pass
        try {
            await StorageRLS.registerLogicalBucket(ref, bucketId, String(name), isPublic);
        } catch (err: unknown) {
            logger.warn(`[StorageCompat] Failed to register logical bucket ${bucketId} in DB for ${ref}`, { error: err instanceof Error ? err.message : String(err) });
            // Optionally we still return success since S3 space was allocated
        }
        
        return { name };
    }, {
        body: t.Object({
            id: t.Optional(t.String()),
            name: t.Optional(t.String()),
            public: t.Optional(t.Boolean())
        })
    })

    // GET /bucket/:id — Get bucket details
    .get('/bucket/:id', async ({ params, headers }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const bucket = await StorageRLS.getLogicalBucket(ref, params.id);
        return {
            id: params.id,
            name: (bucket?.name as string) || params.id,
            owner: '',
            public: (bucket?.public as boolean) ?? false,
            created_at: (bucket?.created_at as string) || new Date().toISOString(),
            updated_at: (bucket?.updated_at as string) || new Date().toISOString(),
            file_size_limit: bucket?.file_size_limit || null,
            allowed_mime_types: bucket?.allowed_mime_types || null,
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

        const contentType = headers['content-type'] || 'application/octet-stream';

        try {
            let fileBuffer: Buffer;
            let fileMimeType = contentType;

            if (contentType.includes('multipart/form-data')) {
                const rawBuffer = Buffer.from(await request.arrayBuffer());
                const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
                const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : '';

                if (boundary) {
                    const extracted = extractMultipartFileFast(rawBuffer, boundary);
                    if (extracted) {
                        fileBuffer = extracted.fileBuffer;
                        fileMimeType = extracted.mimeType;
                    } else {
                        return status(400, { statusCode: '400', error: 'Bad Request', message: 'No file found in multipart data' });
                    }
                } else {
                    return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing multipart boundary' });
                }
            } else {
                fileBuffer = Buffer.from(await request.arrayBuffer());
            }
            
            const auth = headers['authorization'];
            const metadata = { mimetype: fileMimeType, size: fileBuffer.byteLength };
            const permitted = await StorageRLS.authorizeAction(ref, auth, 'upload', params.bucket, filePath, metadata);
            if (!permitted) return status(403, { statusCode: '403', error: 'Forbidden', message: 'Row Level Security violation or bucket missing. Access Denied.' });

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
    }, { type: 'none' })

    // PUT /object/:bucket/* — Upsert (same as upload but always overwrites)
    .put('/object/:bucket/*', async ({ params, headers, request }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = params['*'];
        if (!filePath) return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });

        const contentType = headers['content-type'] || 'application/octet-stream';

        try {
            let fileBuffer: Buffer;
            let fileMimeType = contentType;

            if (contentType.includes('multipart/form-data')) {
                const rawBuffer = Buffer.from(await request.arrayBuffer());
                const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
                const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : '';

                if (boundary) {
                    const extracted = extractMultipartFileFast(rawBuffer, boundary);
                    if (extracted) {
                        fileBuffer = extracted.fileBuffer;
                        fileMimeType = extracted.mimeType;
                    } else {
                        return status(400, { statusCode: '400', error: 'Bad Request', message: 'No file found in multipart data' });
                    }
                } else {
                    return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing multipart boundary' });
                }
            } else {
                fileBuffer = Buffer.from(await request.arrayBuffer());
            }
            
            const auth = headers['authorization'];
            const metadata = { mimetype: fileMimeType, size: fileBuffer.byteLength };
            const permitted = await StorageRLS.authorizeAction(ref, auth, 'upload', params.bucket, filePath, metadata); // Upsert requires same RLS as upload.
            if (!permitted) return status(403, { statusCode: '403', error: 'Forbidden', message: 'Row Level Security violation or bucket missing. Access Denied.' });

            const success = await StorageService.uploadFile(ref, params.bucket, filePath, fileBuffer, fileMimeType);
            if (!success) return status(500, { statusCode: '500', error: 'Internal', message: 'Upsert failed' });
            return { Key: `${params.bucket}/${filePath}` };
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: 'Upsert failed' });
        }
    }, { type: 'none' })

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
            return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        // Otherwise, run RLS and get stream
        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permitted) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found or access denied by RLS' });

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
        if (query.width || query.height || query.resize || query.format || query.quality) {
            return proxyToImaginary(ref, params.bucket, filePath, query, set as { headers: Record<string, string> });
        }

        const auth = headers['authorization'];
        const permitted = await StorageRLS.authorizeAction(ref, auth, 'download', params.bucket, filePath);
        if (!permitted) return status(404, { statusCode: '404', error: 'Not Found', message: 'Object not found or access denied by RLS' });

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
    // SIGNED URL — POST /object/sign/:bucket
    // supabase.storage.from('bucket').createSignedUrl('path', expiresIn)
    // ════════════════════════════════════════════════════════

    .post('/object/sign/:bucket', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const filePath = String(body.url || body.path || '').replace(/^\//, '');
        const expiresIn = Number(body.expiresIn) || 3600;

        if (!filePath) {
            return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing file path' });
        }

        const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
        const token = generateSignedToken(ref, params.bucket, filePath, expiresAt);

        return {
            signedURL: `/storage/v1/object/sign/${params.bucket}/${filePath}?token=${token}&t=${expiresAt}`,
        };
    }, {
        body: t.Object({
            url: t.Optional(t.String()),
            path: t.Optional(t.String()),
            expiresIn: t.Optional(t.Number())
        })
    })

    // POST /object/sign/:bucket — Batch signed URLs
    // supabase.storage.from('bucket').createSignedUrls(['path1', 'path2'], expiresIn)
    .post('/object/sign/:bucket/sign-multi', async ({ params, headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const paths = body.paths || [];
        const expiresIn = Number(body.expiresIn) || 3600;

        return paths.map(filePath => {
            const cleanPath = filePath.replace(/^\//, '');
            const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
            const token = generateSignedToken(ref, params.bucket, cleanPath, expiresAt);
            return {
                error: null,
                path: filePath,
                signedURL: `/storage/v1/object/sign/${params.bucket}/${cleanPath}?token=${token}&t=${expiresAt}`,
            };
        });
    }, {
        body: t.Object({
            paths: t.Array(t.String()),
            expiresIn: t.Optional(t.Number())
        })
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

        // Transform support for signed URLs
        if (query.width || query.height || query.resize || query.format || query.quality) {
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

        // Fetch securely from RLS DB Instead of physical volume
        const files = await StorageRLS.listObjects(ref, auth, params.bucket, prefix, limit, offset);

        return files.map(f => {
            const relativeName = f.name.replace(prefix, ''); // Strip prefix path for SDK
            return {
                name: relativeName || f.name,
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
                if (!permitted) throw new Error('Forbidden');
                
                return await StorageService.deleteFile(ref, params.bucket, p);
            })
        );

        return results.map((r: PromiseSettledResult<unknown>, i: number) => ({
            name: prefixes[i],
            ...(r.status === 'fulfilled' ? {} : { error: 'Delete failed' }),
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
        const destBucket = String(body.destinationBucketId || srcBucket);
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

            return { message: `Moved ${srcBucket}/${srcKey} to ${destBucket}/${destKey}` };
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: err instanceof Error ? err.message : String(err) });
        }
    }, {
        body: t.Object({
            bucketId: t.String(),
            sourceKey: t.String(),
            destinationBucketId: t.Optional(t.String()),
            destinationKey: t.String()
        })
    })

    .post('/object/copy', async ({ headers, body }) => {
        const ref = getProjectRef(headers as Record<string, string | undefined>);
        const srcBucket = String(body.bucketId || '');
        const srcKey = String(body.sourceKey || '');
        const destKey = String(body.destinationKey || '');

        if (!srcBucket || !srcKey || !destKey) {
            return status(400, { statusCode: '400', error: 'Bad Request', message: 'Missing source or destination' });
        }

        try {
            const srcRes = await StorageService.getDownloadResponse(ref, srcBucket, srcKey);
            if (!srcRes) return status(404, { statusCode: '404', error: 'Not Found', message: 'Source object not found' });
            const srcData = Buffer.from(await srcRes.arrayBuffer());
            const contentType = srcRes.headers?.get('Content-Type') || 'application/octet-stream';

            const uploaded = await StorageService.uploadFile(ref, srcBucket, destKey, srcData, contentType);
            if (!uploaded) return status(500, { statusCode: '500', error: 'Internal', message: 'Copy failed' });

            return { Key: `${srcBucket}/${destKey}` };
        } catch (err: unknown) {
            return status(500, { statusCode: '500', error: 'Internal', message: err instanceof Error ? err.message : String(err) });
        }
    }, {
        body: t.Object({
            bucketId: t.String(),
            sourceKey: t.String(),
            destinationKey: t.String()
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
        set.headers['Location'] = `/storage/v1/upload/resumable/${uploadId}`;
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

            try {
                await StorageService.uploadFile(upload.ref, upload.bucket, upload.objectName, fullBody, upload.contentType);
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
    if (resizeMode === 'cover' || resizeMode === 'crop') {
        operation = 'crop';
    } else if (resizeMode === 'contain' || resizeMode === 'embed') {
        operation = 'embed';
    } else if (resizeMode === 'fill') {
        operation = 'enlarge';
        imaginaryParams.set('force', 'true');
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
