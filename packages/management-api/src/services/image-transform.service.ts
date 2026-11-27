import { createHash } from "node:crypto";
import { config } from "../config";

export type ImageTransformQuery = Record<string, unknown>;

export type ImageTransformSource = {
    bytes: ArrayBuffer;
    contentType: string;
};

export type ImageTransformOperation = "standard" | "smartcrop" | "watermark" | "blur" | "info" | "thumbnail";

export type ImageTransformRequest = {
    path: string;
    outputFormat: string | null;
};

export class ImageTransformRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ImageTransformRequestError";
    }
}

export const DEFAULT_IMAGE_TRANSFORM_MAX_BYTES = 64 * 1024 * 1024;

export const PUBLIC_IMAGE_TRANSFORM_CACHE_CONTROL =
    "public, max-age=3600, stale-while-revalidate=86400";

const IMAGE_TRANSFORM_URL = config.imageTransformUrl.replace(/\/+$/, "");

const SUPPORTED_FORMATS = new Set(["avif", "jpeg", "jpg", "png", "webp", "bmp", "tiff", "tif"]);
const SUPPORTED_QUERY_KEYS = new Set([
    "width", "height", "resize", "format", "quality",
    "fit_in", "full_fit_in", "stretch",
    "flip", "flip_h", "flip_v",
    "grayscale", "invert", "blur", "sigma", "sharpen",
    "rotate", "brightness", "contrast",
    "smartcrop", "smart",
    "watermark", "text", "font", "opacity", "text_color", "text_x", "text_y",
    "text_width", "text_align", "text_justify", "text_wrap",
    "image", "gravity", "wm", "wm_text", "wm_image", "wm_opacity",
    "wm_gravity", "wm_dx", "wm_dy", "wm_width", "wm_height",
]);

// Kept below common HTTP header limits; the watermark travels as base64 in a
// header so the source image can stay a plain POST body.
const MAX_WATERMARK_BYTES = 256 * 1024;

function allowedWatermarkOrigins(): Set<string> {
    return new Set((process.env.SUPACLOUD_IMAGE_WATERMARK_ALLOWED_ORIGINS || "")
        .split(",")
        .map((value) => value.trim().replace(/\/+$/, "").toLowerCase())
        .filter(Boolean));
}

function queryString(query: ImageTransformQuery, key: string): string | undefined {
    const value = query[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return undefined;
}

function positiveInteger(query: ImageTransformQuery, key: string): number | undefined {
    const value = Number(queryString(query, key));
    if (!Number.isInteger(value) || value < 0 || value > 10000) return undefined;
    return value;
}

function enabled(query: ImageTransformQuery, key: string): boolean {
    const value = query[key];
    return value === true || value === 1 || value === "1" || value === "true";
}

function negotiatedFormat(query: ImageTransformQuery, accept: string | undefined): string | undefined {
    const requested = queryString(query, "format")?.toLowerCase();
    if (requested && requested !== "origin") return undefined;
    const normalized = accept?.toLowerCase() || "";
    if (normalized.includes("image/avif")) return "avif";
    if (normalized.includes("image/webp")) return "webp";
    return undefined;
}

export function imageTransformEtag(sourceVersion: string, request: ImageTransformRequest): string {
    const digest = createHash("sha256")
        .update(sourceVersion)
        .update("\0")
        .update(request.path)
        .digest("base64url");
    return `"supacloud-image-${digest}"`;
}

export function imageTransformUsesAccept(query: ImageTransformQuery): boolean {
    return queryString(query, "format") === undefined;
}

export function resolveImageTransformMaxBytes(
    value = process.env.SUPACLOUD_IMAGE_TRANSFORM_MAX_BYTES,
): number {
    const configured = Number(value);
    return Number.isSafeInteger(configured) && configured > 0 && configured <= DEFAULT_IMAGE_TRANSFORM_MAX_BYTES
        ? configured
        : DEFAULT_IMAGE_TRANSFORM_MAX_BYTES;
}

function filter(name: string, args: string[] = []): string {
    return args.length > 0
        ? `${name}(${args.map((value) => encodeURIComponent(value)).join(",")})`
        : `${name}()`;
}

function normalizeFormat(query: ImageTransformQuery): string | null {
    const value = queryString(query, "format")?.toLowerCase();
    if (!value || value === "origin") return null;
    if (value === "jpg") return "jpeg";
    if (value === "tif") return "tiff";
    if (!SUPPORTED_FORMATS.has(value)) return "webp";
    return value;
}

function outputMimeType(format: string | null, sourceContentType?: string): string | undefined {
    if (!format) return sourceContentType;
    if (format === "jpeg") return "image/jpeg";
    if (format === "tiff") return "image/tiff";
    return `image/${format}`;
}

/**
 * The native service implements the Supabase-compatible resize/format/quality
 * path. Reject unsupported parameters instead of silently
 * returning an image that ignored them.
 */
export function assertSupportedImageTransform(query: ImageTransformQuery): void {
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        if (!SUPPORTED_QUERY_KEYS.has(key)) {
            throw new ImageTransformRequestError(`Unsupported image transform parameter: ${key}`);
        }
    }

    const format = queryString(query, "format")?.toLowerCase();
    if (format === "origin") {
        throw new ImageTransformRequestError("format=origin is not supported by the native image service");
    }
    if (format && !SUPPORTED_FORMATS.has(format)) {
        throw new ImageTransformRequestError(`Unsupported image format: ${format}`);
    }

    const resize = queryString(query, "resize")?.toLowerCase();
    if (resize && !["cover", "contain", "fill", "embed"].includes(resize)) {
        throw new ImageTransformRequestError(`Unsupported resize mode: ${resize}`);
    }

    const rotateRaw = queryString(query, "rotate");
    if (rotateRaw !== undefined && ![0, 90, 180, 270].includes(Number(rotateRaw))) {
        throw new ImageTransformRequestError("rotate must be 0, 90, 180 or 270");
    }

    const qualityRaw = queryString(query, "quality");
    if (qualityRaw !== undefined) {
        const quality = Number(qualityRaw);
        if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
            throw new ImageTransformRequestError("quality must be an integer from 0 to 100");
        }
    }

    for (const key of ["width", "height"]) {
        const raw = queryString(query, key);
        if (raw === undefined) continue;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0 || value > 10000) {
            throw new ImageTransformRequestError(`${key} must be an integer from 0 to 10000`);
        }
    }

    const watermarkUrl = queryString(query, "image") || queryString(query, "wm_image");
    if (watermarkUrl) {
        let origin = "";
        try {
            origin = new URL(watermarkUrl).origin.toLowerCase();
        } catch {
            throw new ImageTransformRequestError("Watermark image URL is invalid");
        }
        if (!allowedWatermarkOrigins().has(origin)) {
            throw new ImageTransformRequestError("Remote watermark images are not allowed");
        }
    }
}

function normalizeDimensions(
    query: ImageTransformQuery,
    operation: ImageTransformOperation,
): [number | undefined, number | undefined] {
    const defaultSize = operation === "thumbnail" ? 150 : undefined;
    return [
        positiveInteger(query, "width") ?? defaultSize,
        positiveInteger(query, "height"),
    ];
}

export function buildImageTransformRequest(
    query: ImageTransformQuery,
    operation: ImageTransformOperation = "standard",
    accept?: string,
): ImageTransformRequest {
    assertSupportedImageTransform(query);
    const negotiated = negotiatedFormat(query, accept);
    if (negotiated && (queryString(query, "format") === undefined || queryString(query, "format") === "origin")) {
        query = { ...query, format: negotiated };
    }

    const watermarkKeys = [
        "watermark", "text", "font", "opacity", "text_color", "text_x", "text_y",
        "text_width", "text_align", "text_justify", "text_wrap",
        "image", "gravity", "wm", "wm_text", "wm_image", "wm_opacity",
        "wm_gravity", "wm_dx", "wm_dy", "wm_width", "wm_height",
    ];
    if (operation !== "watermark" && watermarkKeys.some((key) => query[key] !== undefined)) {
        throw new ImageTransformRequestError("Watermark parameters require the watermark transform operation");
    }
    if (operation !== "smartcrop" && (query.smartcrop !== undefined || query.smart !== undefined)) {
        throw new ImageTransformRequestError("Smartcrop parameters require the smartcrop transform operation");
    }

    const parts: string[] = [];
    if (operation === "info") parts.push("meta");
    if (operation === "smartcrop") parts.push("smart");

    const [width, height] = normalizeDimensions(query, operation);
    const resize = queryString(query, "resize")?.toLowerCase() || (operation === "thumbnail" ? "contain" : "cover");
    const fitIn = enabled(query, "fit_in") || resize === "contain" || resize === "embed";
    const stretch = resize === "fill" || enabled(query, "stretch");
    const flipHorizontal = queryString(query, "flip") === "horizontal"
        || queryString(query, "flip") === "both"
        || enabled(query, "flip_h");
    const flipVertical = queryString(query, "flip") === "vertical"
        || queryString(query, "flip") === "both"
        || enabled(query, "flip_v");

    if (enabled(query, "full_fit_in")) parts.push("full-fit-in");
    else if (fitIn) parts.push("fit-in");
    else if (stretch) parts.push("stretch");

    if (width !== undefined || height !== undefined) {
        const widthPart = width === undefined ? "0" : `${flipHorizontal ? "-" : ""}${width}`;
        const heightPart = height === undefined ? "0" : `${flipVertical ? "-" : ""}${height}`;
        parts.push(`${widthPart}x${heightPart}`);
    }

    const filters: string[] = [];
    if (operation !== "info") {
        filters.push(filter("format", [normalizeFormat(query) || "webp"]));
        const quality = Number(queryString(query, "quality") ?? "80");
        filters.push(filter("quality", [String(Math.min(100, Math.max(0, Math.round(quality))))]));
    }
    if (enabled(query, "grayscale")) filters.push(filter("grayscale"));
    if (enabled(query, "invert")) filters.push(filter("invert"));
    if (queryString(query, "rotate") !== undefined) {
        filters.push(filter("rotate", [queryString(query, "rotate")!]));
    }
    if (queryString(query, "sharpen") !== undefined) {
        filters.push(filter("sharpen", [queryString(query, "sharpen")!]));
    }
    const blur = queryString(query, "blur") || queryString(query, "sigma");
    if (blur !== undefined) filters.push(filter("blur", [blur]));
    if (queryString(query, "brightness") !== undefined) {
        filters.push(filter("brightness", [queryString(query, "brightness")!]));
    }
    if (queryString(query, "contrast") !== undefined) {
        filters.push(filter("contrast", [queryString(query, "contrast")!]));
    }
    if (operation === "watermark") {
        const text = queryString(query, "text")
            || queryString(query, "watermark")
            || queryString(query, "wm")
            || queryString(query, "wm_text");
        if (text !== undefined) {
            filters.push(filter("text", [
                `b64:${Buffer.from(text, "utf8").toString("base64url")}`,
                queryString(query, "text_x") || queryString(query, "wm_dx") || "center",
                queryString(query, "text_y") || queryString(query, "wm_dy") || "bottom",
                queryString(query, "font") || "sans bold 14",
                queryString(query, "text_color") || "white",
                String(Math.round(Number(queryString(query, "opacity") ?? queryString(query, "wm_opacity") ?? "0.3") * 100)),
                "",
                queryString(query, "text_width") || "0",
                queryString(query, "text_align") || "low",
                queryString(query, "text_justify") || "false",
                queryString(query, "text_wrap") || "word",
            ]));
        }
        const watermarkImage = queryString(query, "image") || queryString(query, "wm_image");
        if (watermarkImage) {
            filters.push(filter("watermark", [
                `b64:${watermarkImage}`,
                queryString(query, "wm_x") || queryString(query, "wm_dx") || "center",
                queryString(query, "wm_y") || queryString(query, "wm_dy") || "bottom",
                String(Math.round(Number(queryString(query, "opacity") ?? queryString(query, "wm_opacity") ?? "0.3") * 100)),
                queryString(query, "wm_width") || "none",
                queryString(query, "wm_height") || "none",
            ]));
        }
    }

    const filterSegment = filters.length > 0 ? `filters:${filters.join(":")}` : "";
    if (filterSegment) parts.push(filterSegment);
    if (parts.length === 0 && operation !== "info") parts.push("filters:format(webp):quality(80)");

    const outputFormat = operation === "info" ? null : normalizeFormat(query) || "webp";
    return {
        path: `/${parts.join("/")}/`,
        outputFormat,
    };
}

async function resolveWatermarkImage(query: ImageTransformQuery): Promise<Uint8Array | undefined> {
    const url = queryString(query, "image") || queryString(query, "wm_image");
    if (!url) return undefined;
    const response = await fetch(url);
    if (!response.ok) {
        throw new ImageTransformRequestError("Watermark image could not be downloaded");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_WATERMARK_BYTES) {
        throw new ImageTransformRequestError("Watermark image is too large");
    }
    return bytes;
}

export async function runImageTransformWithRequest(
    query: ImageTransformQuery,
    source: ImageTransformSource,
    operation: ImageTransformOperation = "standard",
    options: { accept?: string; watermarkImage?: Uint8Array } = {},
): Promise<{ request: ImageTransformRequest; response: Response }> {
    const request = buildImageTransformRequest(query, operation, options.accept);
    const watermarkImage = options.watermarkImage ?? await resolveWatermarkImage(query);
    const response = await fetch(`${IMAGE_TRANSFORM_URL}${request.path}`, {
        method: "POST",
        headers: {
            "Content-Type": source.contentType,
            ...(options.accept ? { Accept: options.accept } : {}),
            ...(watermarkImage ? { "X-SupaCloud-Watermark-Image": Buffer.from(watermarkImage).toString("base64") } : {}),
        },
        body: source.bytes,
    });
    return { request, response };
}

export async function runImageTransform(
    query: ImageTransformQuery,
    source: ImageTransformSource,
    operation: ImageTransformOperation = "standard",
): Promise<Response> {
    return (await runImageTransformWithRequest(query, source, operation)).response;
}

export async function checkImageTransformHealth(): Promise<Response> {
    return await fetch(`${IMAGE_TRANSFORM_URL}/healthcheck`);
}

export function imageTransformOutputContentType(
    response: Response,
    request: ImageTransformRequest,
    sourceContentType?: string,
): string | undefined {
    return response.headers.get("Content-Type")
        || outputMimeType(request.outputFormat, sourceContentType);
}
