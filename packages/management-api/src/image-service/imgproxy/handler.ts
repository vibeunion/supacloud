import { createHash } from "node:crypto";
import { ImageEngineError, processImage } from "../engine";
import { cacheEtag, cacheMatches, createImageCacheKey, ImageResultCache } from "../cache";
import type { ProcessedImage, TargetFormat, TransformOptions } from "../types";
import { getImgproxyConfig, type ImgproxyConfig } from "./config";
import { ImgproxyError } from "./errors";
import { buildInfoJson } from "./info";
import {
    createInfoRequest,
    parseInfoOptions,
    parseProcessingOptions,
    type ImgproxyRequest,
} from "./options";
import { verifySignature } from "./signature";
import { fetchFallbackImage, fetchWatermark, resolveSource } from "./source";
import { parseImgproxyPath } from "./url";

export async function handleImgproxyRequest(request: Request, url: URL): Promise<Response> {
    let config: ImgproxyConfig;
    try {
        config = getImgproxyConfig();
    } catch (error) {
        console.error("[image-service] imgproxy configuration error:", error);
        return new Response("Invalid imgproxy configuration", { status: 500 });
    }

    const headers = corsHeaders(config);
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers });
    }

    if (config.secret) {
        const authorization = request.headers.get("authorization");
        if (authorization !== `Bearer ${config.secret}`) {
            return errorResponse(new ImgproxyError("Unauthorized", 401), headers);
        }
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        return errorResponse(new ImgproxyError("Method not allowed", 405), headers);
    }

    let parsed: ReturnType<typeof parseImgproxyPath>;
    try {
        parsed = parseImgproxyPath(url.pathname);
    } catch (error) {
        return errorResponse(error, headers);
    }

    if (!verifySignature(parsed.signature, parsed.signedPath, config)) {
        return errorResponse(new ImgproxyError("Invalid signature", 403), headers);
    }

    let activeRequest: ImgproxyRequest | undefined;
    try {
        const imgproxyRequest = parsed.info
            ? createInfoRequest(parsed.source, config)
            : parseProcessingOptions(parsed.options, parsed.source, config);
        activeRequest = imgproxyRequest;
        if (parsed.info) {
            imgproxyRequest.infoOptions = parseInfoOptions(parsed.options, config);
        }

        if (imgproxyRequest.expires !== undefined
            && imgproxyRequest.expires > 0
            && Math.floor(Date.now() / 1000) > imgproxyRequest.expires) {
            throw new ImgproxyError("Expired URL", 404);
        }

        const source = await resolveSource(parsed.source, imgproxyRequest, config);
        if (imgproxyRequest.raw) {
            return rawResponse(source, imgproxyRequest, config, headers);
        }
        if (!source.bytes) {
            throw new ImgproxyError("Source image has no bytes", 422);
        }
        const cache = new ImageResultCache({
            directory: config.resultCacheDir,
            ttlSeconds: config.resultCacheTtlSeconds,
            maxBytes: config.resultCacheMaxBytes,
            maxEntries: config.resultCacheMaxEntries,
        });
        const sourceDigest = createHash("sha256").update(source.bytes).digest("hex");
        const cacheKey = createImageCacheKey([
            "image-service-v1",
            parsed.info ? "info" : "image",
            parsed.signedPath,
            source.url,
            sourceDigest,
            request.headers.get("accept") ?? "",
        ]);
        const cached = await cache.get(cacheKey);
        if (cached) {
            return cachedResponse(
                cached.bytes,
                cached.contentType,
                cached.etag,
                request,
                imgproxyRequest,
                config,
                headers,
            );
        }

        if (parsed.info) {
            const json = buildInfoJson(
                source.bytes,
                source.size,
                imgproxyRequest.infoOptions,
                imgproxyRequest.maxSrcResolution > 0
                    ? Math.round(imgproxyRequest.maxSrcResolution * 1_000_000)
                    : 0,
            );
            const infoHeaders = new Headers(headers);
            infoHeaders.set("Content-Type", "application/json; charset=utf-8");
            infoHeaders.set("Cache-Control", config.cacheControl);
            const bytes = new TextEncoder().encode(json);
            const etag = cacheEtag(bytes);
            await cache.set(cacheKey, { bytes, contentType: "application/json; charset=utf-8", etag });
            if (cacheMatches(request, etag)) {
                infoHeaders.set("ETag", etag);
                return new Response(null, { status: 304, headers: infoHeaders });
            }
            infoHeaders.set("ETag", etag);
            return new Response(bytes, { status: 200, headers: infoHeaders });
        }

        if (shouldSkipProcessing(imgproxyRequest, source)) {
            return await imageResponse(
                source.bytes,
                source.contentType ?? "application/octet-stream",
                imgproxyRequest,
                config,
                headers,
                source.size,
                cache,
                cacheKey,
                request,
            );
        }

        let watermarkImage: Uint8Array | undefined;
        if (imgproxyRequest.watermarkUrl) {
            watermarkImage = await fetchWatermark(imgproxyRequest.watermarkUrl, config);
            imgproxyRequest.transform.watermarkImage = watermarkImage;
        }

        const result = await processWithFormat(
            imgproxyRequest,
            source.bytes,
            watermarkImage,
            request.headers.get("accept"),
            source.contentType,
        );
        const responseHeaders = new Headers(headers);
        responseHeaders.set("Content-Type", result.result.contentType);
        responseHeaders.set("Cache-Control", config.cacheControl);
        if (result.varyAccept) responseHeaders.set("Vary", "Accept");
        setContentDisposition(responseHeaders, imgproxyRequest, result.result.contentType);
        const etag = cacheEtag(result.result.bytes);
        await cache.set(cacheKey, {
            bytes: result.result.bytes,
            contentType: result.result.contentType,
            etag,
        });
        responseHeaders.set("Content-Length", String(result.result.bytes.byteLength));
        responseHeaders.set("ETag", etag);
        if (cacheMatches(request, etag)) {
            return new Response(null, { status: 304, headers: responseHeaders });
        }
        if (request.method === "HEAD") {
            return new Response(null, { status: 200, headers: responseHeaders });
        }
        return new Response(blobFromBytes(result.result.bytes), { status: 200, headers: responseHeaders });
    } catch (error) {
        if (error instanceof ImgproxyError && (error.status === 403 || error.status === 401)) {
            return errorResponse(error, headers);
        }
        return fallbackOrError(error, headers, config, activeRequest);
    }
}

async function processWithFormat(
    request: ImgproxyRequest,
    bytes: Uint8Array,
    watermarkImage?: Uint8Array,
    accept?: string | null,
    sourceContentType?: string,
): Promise<{ result: ProcessedImage; varyAccept: boolean }> {
    const accepted = acceptedFormats(accept ?? null);
    if (request.bestFormat) {
        const candidates: TargetFormat[] = accepted.length > 0
            ? accepted
            : ["avif", "webp", "jpeg"];
        let best: { result: ProcessedImage; format: TargetFormat } | undefined;
        for (const format of candidates.slice(0, 3)) {
            try {
                const result = processImage(
                    bytes,
                    { ...request.transform, format, bestFormat: false },
                    watermarkImage,
                );
                if (!best || result.bytes.byteLength < best.result.bytes.byteLength) {
                    best = { result, format };
                }
            } catch {
                // A format can be unavailable for a particular source; keep the best candidate.
            }
        }
        if (best) return { result: best.result, varyAccept: true };
    }

    const transform = { ...request.transform, bestFormat: false };
    if (!transform.format) {
        const sourceFormat = normalizeExtension(request.extension)
            ?? formatFromContentType(sourceContentType);
        if (sourceFormat) {
            transform.format = sourceFormat;
        } else if (sourceContentType?.includes("image/svg+xml")) {
            transform.format = "jpeg";
        }
    }
    if (!transform.format) {
        if (accepted.length > 0) {
            transform.format = accepted[0];
            return {
                result: processImage(bytes, transform, watermarkImage),
                varyAccept: true,
            };
        }
    }
    return {
        result: processImage(bytes, transform, watermarkImage),
        varyAccept: false,
    };
}

function acceptedFormats(accept: string | null): TargetFormat[] {
    if (!accept) return [];
    const formats: TargetFormat[] = [];
    if (accept.includes("image/avif")) formats.push("avif");
    if (accept.includes("image/webp")) formats.push("webp");
    if (accept.includes("image/jpeg") || accept.includes("image/jpg")) formats.push("jpeg");
    if (accept.includes("image/png")) formats.push("png");
    return formats;
}

function shouldSkipProcessing(request: ImgproxyRequest, source: { contentType?: string }): boolean {
    if (request.skipProcessing.length === 0) return false;
    if (hasTransformOptions(request.transform)) return false;
    const sourceFormat = normalizeExtension(request.extension)
        ?? formatFromContentType(source.contentType);
    if (!sourceFormat || !request.skipProcessing.includes(sourceFormat)) return false;
    return request.transform.format === undefined || request.transform.format === sourceFormat;
}

function formatFromContentType(contentType?: string): TargetFormat | undefined {
    if (!contentType) return undefined;
    const value = contentType.split(";")[0].trim().toLowerCase();
    const map: Record<string, TargetFormat> = {
        "image/jpeg": "jpeg",
        "image/jpg": "jpeg",
        "image/png": "png",
        "image/webp": "webp",
        "image/avif": "avif",
        "image/gif": "gif",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
        "image/x-icon": "ico",
    };
    return map[value];
}

function normalizeExtension(extension?: string): TargetFormat | undefined {
    if (!extension) return undefined;
    const value = extension.toLowerCase();
    if (value === "jpg") return "jpeg";
    if (value === "tif") return "tiff";
    if (["jpeg", "png", "webp", "avif", "gif", "bmp", "tiff", "ico"].includes(value)) {
        return value as TargetFormat;
    }
    return undefined;
}

function hasTransformOptions(options: TransformOptions): boolean {
    return options.width !== undefined
        || options.height !== undefined
        || options.fitIn
        || options.stretch
        || options.smart
        || options.resizeType !== "fit"
        || Boolean(options.enlarge)
        || Boolean(options.extend)
        || Boolean(options.extendAspectRatio)
        || Boolean(options.gravity)
        || Boolean(options.crop)
        || Boolean(options.trim)
        || Boolean(options.padding)
        || Boolean(options.background)
        || options.blurSigma !== undefined
        || options.sharpenSigma !== undefined
        || options.contrast !== undefined
        || options.brightness !== undefined
        || options.saturation !== undefined
        || options.gamma !== undefined
        || options.pixelateSize !== undefined
        || Boolean(options.monochrome)
        || Boolean(options.duotone)
        || Boolean(options.colorize)
        || Boolean(options.gradient)
        || Boolean(options.blurAreas?.length)
        || Boolean(options.progressiveBlur)
        || options.rotateDeg !== undefined
        || options.flipHorizontal
        || options.flipVertical
        || options.grayscale
        || options.invert
        || Boolean(options.watermarkText)
        || Boolean(options.watermarkImage)
        || options.zoom !== undefined
        || options.dpr !== undefined
        || options.minWidth !== undefined
        || options.minHeight !== undefined
        || Boolean(options.autoQuality)
        || options.maxBytes !== undefined
        || Boolean(options.formatQuality);
}

function rawResponse(
    source: Awaited<ReturnType<typeof resolveSource>>,
    request: ImgproxyRequest,
    config: ImgproxyConfig,
    baseHeaders: Headers,
): Response {
    const headers = new Headers(baseHeaders);
    headers.set("Content-Type", source.contentType ?? "application/octet-stream");
    headers.set("Cache-Control", config.cacheControl);
    if (source.size !== undefined) headers.set("Content-Length", String(source.size));
    setContentDisposition(headers, request, source.contentType);
    if (source.stream) {
        return new Response(source.stream, { status: 200, headers });
    }
    if (!source.bytes) {
        return errorResponse(new ImgproxyError("Source image has no body", 422), headers);
    }
    return new Response(blobFromBytes(source.bytes), { status: 200, headers });
}

async function imageResponse(
    bytes: Uint8Array,
    contentType: string,
    imgproxyRequest: ImgproxyRequest,
    config: ImgproxyConfig,
    baseHeaders: Headers,
    size?: number,
    cache?: ImageResultCache,
    cacheKey?: string,
    httpRequest?: Request,
): Promise<Response> {
    const headers = new Headers(baseHeaders);
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", config.cacheControl);
    const etag = cacheEtag(bytes);
    headers.set("Content-Length", String(size ?? bytes.byteLength));
    headers.set("ETag", etag);
    setContentDisposition(headers, imgproxyRequest, contentType);
    if (cache && cacheKey) {
        await cache.set(cacheKey, { bytes, contentType, etag });
    }
    if (httpRequest && cacheMatches(httpRequest, etag)) {
        return new Response(null, { status: 304, headers });
    }
    if (httpRequest?.method === "HEAD") {
        return new Response(null, { status: 200, headers });
    }
    return new Response(blobFromBytes(bytes), { status: 200, headers });
}

function cachedResponse(
    bytes: Uint8Array,
    contentType: string,
    etag: string,
    request: Request,
    imgproxyRequest: ImgproxyRequest,
    config: ImgproxyConfig,
    baseHeaders: Headers,
): Response {
    const headers = new Headers(baseHeaders);
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", config.cacheControl);
    headers.set("Content-Length", String(bytes.byteLength));
    headers.set("ETag", etag);
    setContentDisposition(headers, imgproxyRequest, contentType);
    if (request.method === "HEAD" || cacheMatches(request, etag)) {
        return new Response(null, { status: cacheMatches(request, etag) ? 304 : 200, headers });
    }
    return new Response(blobFromBytes(bytes), { status: 200, headers });
}

function setContentDisposition(
    headers: Headers,
    request: ImgproxyRequest,
    contentType?: string,
): void {
    if (!request.filename && !request.returnAttachment) return;
    const fallbackName = request.filename
        ?? (contentType?.includes("json") ? "info.json" : "image");
    const safe = fallbackName.replace(/[\r\n"]/g, "_");
    const disposition = request.returnAttachment ? "attachment" : "inline";
    headers.set(
        "Content-Disposition",
        `${disposition}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
    );
}

async function fallbackOrError(
    error: unknown,
    headers: Headers,
    config: ImgproxyConfig,
    request?: ImgproxyRequest,
): Promise<Response> {
    if (request?.fallbackImageUrl) {
        try {
            const fallback = await fetchFallbackImage(request.fallbackImageUrl, config);
            if (fallback.bytes) {
                const fallbackHeaders = new Headers(headers);
                fallbackHeaders.set("Content-Type", fallback.contentType ?? "application/octet-stream");
                fallbackHeaders.set("Cache-Control", config.cacheControl);
                if (fallback.size !== undefined) {
                    fallbackHeaders.set("Content-Length", String(fallback.size));
                }
                return new Response(blobFromBytes(fallback.bytes), { status: 200, headers: fallbackHeaders });
            }
        } catch {
            // Use the original error when the fallback image cannot be loaded.
        }
    }

    if (!(error instanceof ImgproxyError) && !(error instanceof ImageEngineError)) {
        console.error("[image-service] imgproxy processing error:", error);
        return errorResponse(new ImgproxyError("Internal image processing error", 500), headers);
    }
    return errorResponse(error, headers);
}

function errorResponse(error: unknown, baseHeaders: Headers): Response {
    const status = error instanceof ImgproxyError || error instanceof ImageEngineError
        ? error.status
        : 500;
    const message = error instanceof Error ? error.message : "Internal image processing error";
    const headers = new Headers(baseHeaders);
    headers.set("Content-Type", "text/plain; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(status >= 500 && !(error instanceof ImgproxyError)
        ? "Internal image processing error"
        : message, { status, headers });
}

function corsHeaders(config: ImgproxyConfig): Headers {
    const headers = new Headers();
    if (config.allowOrigin) {
        headers.set("Access-Control-Allow-Origin", config.allowOrigin);
        headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Authorization, Accept, Content-Type");
        headers.set("Access-Control-Max-Age", "86400");
    }
    return headers;
}

function blobFromBytes(bytes: Uint8Array): Blob {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Blob([copy.buffer as ArrayBuffer]);
}
