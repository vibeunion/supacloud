import { Elysia, t, status } from "elysia";
import { StorageService } from '../services/storage.service';
import { logger } from "../utils/logger";
import { config } from "../config";

const ErrorResponse = t.Object({ error: t.String() });
const SuccessResponse = t.Object({ success: t.Boolean(), message: t.String() });

// ── Imaginary Config ──────────────────────────────────────────────
const IMAGINARY_URL = config.imaginaryUrl;
const S3_ENDPOINT  = config.s3Endpoint;

/**
 * Build the internal S3 URL for imaginary to fetch the source image from.
 * imaginary will pull the image via HTTP from this URL.
 */
function buildSourceUrl(bucket: string, path: string): string {
    const base = S3_ENDPOINT.endsWith('/') ? S3_ENDPOINT.slice(0, -1) : S3_ENDPOINT;
    return `${base}/${bucket}/${path}`;
}

// ── Storage Routes ────────────────────────────────────────────────
export const storageRoutes = new Elysia({ prefix: "/v1/storage" })
    .get('/status', async () => {
        return await StorageService.getStatus();
    })
    .get('/:ref/buckets', async ({ params }) => {
        return await StorageService.listBuckets(params.ref);
    })
    .get('/:ref/buckets/:name/files', async ({ params }) => {
        return await StorageService.listFiles(params.ref, params.name);
    })
    .post('/:ref/buckets/:name/upload', async ({ params, body }) => {
        const file = body.file;
        if (!file) return status(400, { error: 'No file provided' });
        const fileData = Buffer.from(await file.arrayBuffer());
        const success = await StorageService.uploadFile(params.ref, params.name, file.name, fileData, file.type);
        if (!success) return status(500, { error: 'Failed to upload file' });
        return { success: true, message: 'File uploaded successfully' };
    }, {
        body: t.Object({ file: t.File() }),
        response: {
            200: SuccessResponse,
            400: ErrorResponse,
            500: ErrorResponse,
        },
    })
    .delete('/:ref/buckets/:name/files/:filename', async ({ params }) => {
        const success = await StorageService.deleteFile(params.ref, params.name, params.filename);
        if (!success) return status(500, { error: 'Failed to delete file' });
        return { success: true, message: 'File deleted successfully' };
    }, {
        response: {
            200: SuccessResponse,
            500: ErrorResponse,
        },
    })
    .post('/migrate', async ({ body }) => {
        if (!body.s3Url || !body.credentials) return status(400, { error: 'Missing migration parameters' });
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
        },
    })

    // ── Supabase-compatible Image Transform (via imaginary) ──────
    // Matches: GET /v1/storage/:ref/render/image/public/:bucket/*
    // This is the exact pattern that supabase-js SDK sends for .download(path, { transform })
    .get('/:ref/render/image/public/:bucket/*', async ({ params, query, set }) => {
        const bucket = params.bucket;
        const path = params['*'];
        if (!path) return status(400, { error: 'Missing file path' });

        const sourceUrl = buildSourceUrl(bucket, path);

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
                return status(502, { error: `Image transform failed: ${errText}` });
            }

            // Stream the processed image back to client with caching headers
            set.headers['Content-Type'] = res.headers.get('Content-Type') || `image/${format}`;
            set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
            set.headers['X-Image-Engine'] = 'imaginary/libvips';
            return new Response(res.body, { headers: set.headers as unknown as HeadersInit });
        } catch (err: unknown) {
            logger.error('Image transform proxy error:', { error: err instanceof Error ? err.message : String(err) });
            return status(502, { error: 'Image processing service unavailable' });
        }
    })

    // ── Enhanced imaginary Features (beyond Supabase standard) ───
    // These routes expose imaginary's unique superpowers that imgproxy Pro charges for.

    // Smart Crop: intelligent focus-point detection
    // GET /v1/storage/:ref/transform/smartcrop/:bucket/*?width=300&height=300
    .get('/:ref/transform/smartcrop/:bucket/*', async ({ params, query, set }) => {
        const path = params['*'];
        if (!path) return status(400, { error: 'Missing file path' });

        const sourceUrl = buildSourceUrl(params.bucket, path);
        const p = new URLSearchParams({
            url: sourceUrl,
            width:   String(query.width  || 300),
            height:  String(query.height || 300),
            quality: String(query.quality || 80),
            type:    query.format || 'webp',
        });

        try {
            const res = await fetch(`${IMAGINARY_URL}/smartcrop?${p.toString()}`);
            if (!res.ok) return status(502, { error: await res.text() });
            set.headers['Content-Type'] = res.headers.get('Content-Type') || 'image/webp';
            set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
            return new Response(res.body, { headers: set.headers as unknown as HeadersInit });
        } catch (err: unknown) {
            return status(502, { error: 'Smartcrop service unavailable' });
        }
    })

    // Watermark: overlay text or image watermark
    // GET /v1/storage/:ref/transform/watermark/:bucket/*?text=ACME&font=sans&opacity=0.5
    .get('/:ref/transform/watermark/:bucket/*', async ({ params, query, set }) => {
        const path = params['*'];
        if (!path) return status(400, { error: 'Missing file path' });

        const sourceUrl = buildSourceUrl(params.bucket, path);
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
            if (!res.ok) return status(502, { error: await res.text() });
            set.headers['Content-Type'] = res.headers.get('Content-Type') || 'image/webp';
            set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
            return new Response(res.body, { headers: set.headers as unknown as HeadersInit });
        } catch (err: unknown) {
            return status(502, { error: 'Watermark service unavailable' });
        }
    })

    // Blur: apply gaussian blur (useful for placeholder images / LQIP)
    // GET /v1/storage/:ref/transform/blur/:bucket/*?sigma=10&width=20
    .get('/:ref/transform/blur/:bucket/*', async ({ params, query, set }) => {
        const path = params['*'];
        if (!path) return status(400, { error: 'Missing file path' });

        const sourceUrl = buildSourceUrl(params.bucket, path);
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
            if (!res.ok) return status(502, { error: await res.text() });
            set.headers['Content-Type'] = res.headers.get('Content-Type') || 'image/webp';
            set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
            return new Response(res.body, { headers: set.headers as unknown as HeadersInit });
        } catch (err: unknown) {
            return status(502, { error: 'Blur service unavailable' });
        }
    })

    // Image Info: extract metadata (dimensions, EXIF, color space) without downloading full image
    // GET /v1/storage/:ref/transform/info/:bucket/*
    .get('/:ref/transform/info/:bucket/*', async ({ params }) => {
        const path = params['*'];
        if (!path) return status(400, { error: 'Missing file path' });

        const sourceUrl = buildSourceUrl(params.bucket, path);
        const p = new URLSearchParams({ url: sourceUrl });

        try {
            const res = await fetch(`${IMAGINARY_URL}/info?${p.toString()}`);
            if (!res.ok) return status(502, { error: await res.text() });
            return res.json();
        } catch (err: unknown) {
            return status(502, { error: 'Image info service unavailable' });
        }
    })

    // Thumbnail: generate a small, fast thumbnail (great for file browsers / galleries)
    // GET /v1/storage/:ref/transform/thumbnail/:bucket/*?width=150
    .get('/:ref/transform/thumbnail/:bucket/*', async ({ params, query, set }) => {
        const path = params['*'];
        if (!path) return status(400, { error: 'Missing file path' });

        const sourceUrl = buildSourceUrl(params.bucket, path);
        const p = new URLSearchParams({
            url: sourceUrl,
            width:   String(query.width  || 150),
            quality: String(query.quality || 70),
            type:    query.format || 'webp',
        });

        try {
            const res = await fetch(`${IMAGINARY_URL}/thumbnail?${p.toString()}`);
            if (!res.ok) return status(502, { error: await res.text() });
            set.headers['Content-Type'] = res.headers.get('Content-Type') || 'image/webp';
            set.headers['Cache-Control'] = 'public, max-age=31536000, immutable';
            return new Response(res.body, { headers: set.headers as unknown as HeadersInit });
        } catch (err: unknown) {
            return status(502, { error: 'Thumbnail service unavailable' });
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
            return { status: 'unreachable', error: 'Cannot connect to imaginary service' };
        }
    });
