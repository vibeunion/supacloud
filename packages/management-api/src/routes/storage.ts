import { Elysia, t, status } from "elysia";
import { StorageService, migrationJobs } from '../services/storage.service';
import { StorageRLS } from "../services/storage-rls";
import { logger } from "../utils/logger";
import { config } from "../config";
import { requireAdminAuth, requireProjectOrAdminAuth } from "../middleware/auth";

const ErrorResponse = t.Object({ message: t.String() });
const SuccessResponse = t.Object({ success: t.Boolean(), message: t.String() });

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

// ── Storage Routes ────────────────────────────────────────────────
export const storageRoutes = new Elysia({ prefix: "/v1/storage" })
    .get('/status', async () => {
        return await StorageService.getStatus();
    })
    .get('/:ref/buckets', async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        return await StorageService.listBuckets(params.ref);
    })
    .get('/:ref/buckets/:name/files', async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        return await StorageService.listFiles(params.ref, params.name);
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
        }
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
    })

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
    })

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
    })

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
    })

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
    })

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
    })

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
    });

export const projectStorageRoutes = new Elysia({ prefix: "/v1/projects/:ref/storage" })
    .get('/buckets', async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        return await StorageService.listBuckets(params.ref);
    })
    .post('/buckets', async ({ params, body, set, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        const bucketName = (body as Record<string, unknown>).name as string || (body as Record<string, unknown>).id as string;
        const result = await StorageService.createBucket(params.ref, bucketName);
        if (!result.success) {
            set.status = 500;
            return { message: result.error || "Failed to create bucket", code: "500" };
        }
        return { id: bucketName, name: bucketName, public: (body as Record<string, unknown>).public || false };
    }, {
        body: t.Object({
            name: t.String(),
            id: t.Optional(t.String()),
            public: t.Optional(t.Boolean()),
            file_size_limit: t.Optional(t.Number()),
            allowed_mime_types: t.Optional(t.Array(t.String())),
        }),
    })
    .get('/buckets/:id', async ({ params, set, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        const buckets = await StorageService.listBuckets(params.ref);
        const bucket = (buckets as Array<Record<string, unknown>>).find((b: Record<string, unknown>) => b.id === params.id || b.name === params.id);
        if (!bucket) {
            set.status = 404;
            return { message: "Bucket not found", code: "404" };
        }
        return bucket;
    })
    .put('/buckets/:id', async ({ params, body, set, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        const result = await StorageService.updateBucket(params.ref, params.id, {
            public: body.public,
            file_size_limit: body.file_size_limit,
            allowed_mime_types: body.allowed_mime_types,
        });

        if (!result.success) {
            set.status = result.error === "Bucket not found" ? 404 : result.error === "Invalid bucket id" ? 400 : 500;
            return { message: result.error || "Failed to update bucket", code: String(set.status) };
        }

        return result.bucket;
    }, {
        body: t.Object({
            public: t.Optional(t.Boolean()),
            file_size_limit: t.Optional(t.Number()),
            allowed_mime_types: t.Optional(t.Array(t.String())),
        }),
    })
    .delete('/buckets/:id', async ({ params, set, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
        const result = await StorageService.deleteBucket(params.ref, params.id);
        if (!result.success) {
            set.status = 500;
            return { message: result.error || "Failed to delete bucket", code: "500" };
        }
        return { id: params.id, deleted: true };
    });
