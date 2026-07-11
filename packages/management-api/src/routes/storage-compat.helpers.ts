import { createHmac, timingSafeEqual } from "node:crypto";

import type { SignedUpload } from "../services/storage-store";

const TRANSFORM_QUERY_KEYS = new Set([
    "width", "height", "resize", "format", "quality", "smartcrop", "blur", "sigma", "watermark",
    "text", "font", "opacity", "image", "gravity", "wm", "wm_text", "wm_image", "wm_opacity",
    "wm_gravity", "wm_dx", "wm_dy",
]);

export function signedUrlPayload(ref: string, bucket: string, path: string, expiresAt: number): string {
    return `${ref}:${bucket}/${path}:${expiresAt}`;
}

export function verifyLegacySignedToken(
    secret: string,
    ref: string,
    bucket: string,
    path: string,
    token: string,
    expiresAt?: number,
    nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
    if (!expiresAt || expiresAt < nowSeconds || !/^[0-9a-f]{64}$/i.test(token)) return false;

    const expectedToken = createHmac("sha256", secret)
        .update(signedUrlPayload(ref, bucket, path, expiresAt))
        .digest("hex");
    const tokenBuffer = Buffer.from(token, "hex");
    const expectedBuffer = Buffer.from(expectedToken, "hex");
    return tokenBuffer.length === expectedBuffer.length && timingSafeEqual(tokenBuffer, expectedBuffer);
}

export function extractMultipartFileFast(
    buffer: Buffer,
    boundary: string,
): { fileBuffer: Buffer; mimeType: string; metadata?: Record<string, unknown> } | null {
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    let searchPos = 0;
    let bestFile: { fileBuffer: Buffer; mimeType: string } | null = null;
    let metadataStr: string | null = null;
    let cacheControlStr: string | null = null;

    while (searchPos < buffer.length) {
        const partStart = buffer.indexOf(boundaryBuffer, searchPos);
        if (partStart === -1) break;

        const contentStart = partStart + boundaryBuffer.length;
        const nextBoundaryPos = buffer.indexOf(boundaryBuffer, contentStart);
        if (nextBoundaryPos === -1) break;

        const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), contentStart);
        if (headerEnd !== -1 && headerEnd < nextBoundaryPos) {
            const headersRow = buffer.subarray(contentStart, headerEnd).toString("utf-8");
            const fileStart = headerEnd + 4;
            const fileEnd = nextBoundaryPos - 2;

            if (headersRow.includes('name="metadata"') && fileEnd >= fileStart) {
                metadataStr = buffer.subarray(fileStart, fileEnd).toString("utf-8");
            } else if (headersRow.includes('name="cacheControl"') && fileEnd >= fileStart) {
                cacheControlStr = buffer.subarray(fileStart, fileEnd).toString("utf-8");
            } else if (headersRow.includes("filename=") || headersRow.includes("Content-Type:")) {
                const typeMatch = headersRow.match(/Content-Type:\s*([^\r\n]+)/i);
                const mimeType = typeMatch?.[1]?.trim() || "application/octet-stream";
                if (fileEnd >= fileStart) {
                    bestFile = { fileBuffer: buffer.subarray(fileStart, fileEnd), mimeType };
                }
            } else if (fileEnd - fileStart > 100) {
                if (!bestFile || fileEnd - fileStart > bestFile.fileBuffer.length) {
                    bestFile = {
                        fileBuffer: buffer.subarray(fileStart, fileEnd),
                        mimeType: "application/octet-stream",
                    };
                }
            }
        }
        searchPos = nextBoundaryPos;
    }

    if (!bestFile) return null;

    let metadata: Record<string, unknown> = {};
    if (metadataStr) {
        try {
            metadata = JSON.parse(metadataStr) as Record<string, unknown>;
        } catch {
            metadata = {};
        }
    }
    if (cacheControlStr) metadata.cacheControl = cacheControlStr;

    return {
        ...bestFile,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
}

export function isLoopbackHost(host: string): boolean {
    return !host || host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function normalizeListInteger(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : fallback;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.floor(parsed), min), max);
}

export function isMimeAllowed(allowedMimes: string[], actualMime: string): boolean {
    if (!actualMime) return false;
    const [type] = actualMime.split("/");
    return allowedMimes.some((allowed) => {
        if (allowed === actualMime) return true;
        const [allowedType, allowedSubtype] = allowed.split("/");
        return allowedSubtype === "*" && allowedType === type;
    });
}

export function setDownloadDisposition(
    query: Record<string, string | undefined>,
    filePath: string,
    set: { headers: Record<string, string> },
): void {
    const download = query.download;
    if (download === undefined) {
        set.headers["Content-Disposition"] = "inline";
        return;
    }

    const filename = typeof download === "string" && download !== "true" && download !== ""
        ? download
        : filePath.split("/").pop() || "download";
    set.headers["Content-Disposition"] = `attachment; filename="${encodeURIComponent(filename)}"`;
}

export function buildSignedPath(
    pathname: string,
    expiresAt: number,
    token: string,
    transform?: Record<string, unknown>,
    download?: boolean | string,
): string {
    const search = new URLSearchParams({ token, expiresAt: String(expiresAt) });
    if (download) search.set("download", typeof download === "string" ? download : "");

    for (const [key, value] of Object.entries(transform || {})) {
        if (value === undefined || value === null) continue;
        if (["string", "number", "boolean"].includes(typeof value)) search.set(key, String(value));
    }
    return `${pathname}?${search.toString()}`;
}

export function getRequestOrigin(request: Request): string {
    const url = new URL(request.url);
    const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
    const host = request.headers.get("x-forwarded-host") || url.host;
    return `${proto}://${host}/storage/v1`;
}

export function hasTransformQuery(query: Record<string, unknown>): boolean {
    return Object.entries(query).some(([key, value]) =>
        value !== undefined && value !== null && TRANSFORM_QUERY_KEYS.has(key),
    );
}

export function isTransformQueryKey(key: string): boolean {
    return TRANSFORM_QUERY_KEYS.has(key);
}

export function getUploadMetadata(headers: Record<string, string | undefined>): Record<string, unknown> {
    const raw = headers["x-metadata"] || headers["X-Metadata"];
    let parsed: Record<string, unknown> = {};
    if (raw) {
        try {
            parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) as Record<string, unknown>;
        } catch {
            parsed = {};
        }
    }

    const cacheControl = headers["cache-control"] || headers["Cache-Control"];
    if (cacheControl && !parsed.cacheControl) parsed.cacheControl = cacheControl;
    return parsed;
}

export function parseContentLength(value: string | null | undefined): number | null {
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.floor(parsed);
}

export function isMultipartContentType(contentType: string | undefined): boolean {
    return (contentType || "").toLowerCase().includes("multipart/form-data");
}

function normalizeContentType(value: unknown): string {
    return String(value || "").trim();
}

function isSpecificContentType(value: string): boolean {
    const mediaType = value.split(";")[0]?.trim().toLowerCase();
    return Boolean(mediaType) && mediaType !== "application/octet-stream";
}

export function resolveDownloadContentType(
    response: Response,
    info?: Record<string, unknown> | null,
): string {
    const metadata = (info?.metadata || {}) as Record<string, unknown>;
    const metadataType = normalizeContentType(info?.content_type || metadata.mimetype);
    if (isSpecificContentType(metadataType)) return metadataType;

    const responseType = normalizeContentType(response.headers.get("Content-Type"));
    if (isSpecificContentType(responseType)) return responseType;
    return metadataType || responseType || "application/octet-stream";
}

export async function readUploadBody(
    request: Request,
    contentType: string | undefined,
    contentLengthHeader: string | undefined,
    maxSize: number,
): Promise<{
    fileData: Buffer | ReadableStream;
    fileMimeType: string;
    size: number;
    customMetadata?: Record<string, unknown>;
}> {
    const normalizedMime = contentType?.split(";")[0]?.trim() || "application/octet-stream";
    const declaredLength = parseContentLength(contentLengthHeader || request.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > maxSize) throw new Error("UPLOAD_TOO_LARGE");

    if (!isMultipartContentType(contentType) && request.body && declaredLength !== null) {
        return { fileData: request.body, fileMimeType: normalizedMime, size: declaredLength };
    }

    let fileBuffer = Buffer.from(await request.arrayBuffer());
    if (fileBuffer.byteLength > maxSize) throw new Error("UPLOAD_TOO_LARGE");
    let fileMimeType = normalizedMime;
    let customMetadata: Record<string, unknown> | undefined;

    const isActuallyMultipart = fileBuffer.length > 20
        && fileBuffer.subarray(0, 2).toString("utf-8") === "--"
        && fileBuffer.indexOf(Buffer.from("Content-Disposition: form-data;")) !== -1;

    if (isMultipartContentType(contentType) || isActuallyMultipart) {
        const boundaryMatch = (contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        let boundary = boundaryMatch?.[1] || boundaryMatch?.[2] || "";
        if (!boundary && isActuallyMultipart) {
            const firstLineEnd = fileBuffer.indexOf(Buffer.from("\r\n"));
            if (firstLineEnd !== -1) boundary = fileBuffer.subarray(2, firstLineEnd).toString("utf-8");
        }
        if (!boundary) throw new Error("Missing multipart boundary");

        const extracted = extractMultipartFileFast(fileBuffer, boundary);
        if (!extracted) throw new Error("No file found in multipart data");
        fileBuffer = Buffer.from(extracted.fileBuffer);
        if (!fileMimeType || fileMimeType === "application/octet-stream" || (contentType || "").includes("multipart")) {
            fileMimeType = extracted.mimeType;
        }
        customMetadata = extracted.metadata;
    }

    return { fileData: fileBuffer, fileMimeType, size: fileBuffer.byteLength, customMetadata };
}

export function parseFileSizeLimit(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
    if (typeof value !== "string") return null;

    const match = value.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb|bytes?)?$/i);
    if (!match) return null;
    const amount = Number.parseFloat(match[1]);
    switch ((match[2] || "bytes").toLowerCase()) {
        case "kb": return Math.floor(amount * 1024);
        case "mb": return Math.floor(amount * 1024 * 1024);
        case "gb": return Math.floor(amount * 1024 * 1024 * 1024);
        default: return Math.floor(amount);
    }
}

export function parseAllowedMimeTypes(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    return value.filter((entry): entry is string => typeof entry === "string");
}

export function signedUploadMatches(
    upload: SignedUpload | null,
    ref: string,
    bucket: string,
    objectName: string,
): upload is SignedUpload {
    return upload !== null
        && upload.ref === ref
        && upload.bucket === bucket
        && upload.objectName === objectName;
}
