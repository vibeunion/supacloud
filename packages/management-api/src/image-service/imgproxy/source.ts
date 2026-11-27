import { createDecipheriv, createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { MAX_PAYLOAD_BYTES } from "../engine";
import type { ImgproxyConfig } from "./config";
import { ImgproxyError } from "./errors";
import type { Hashsum, ImgproxyRequest } from "./options";
import type { SourceRef } from "./url";

export type ResolvedSource = {
    bytes?: Uint8Array;
    stream?: ReadableStream<Uint8Array>;
    contentType?: string;
    size?: number;
    url: string;
};

type RedirectFetch = {
    response: Response;
    url: string;
};

export async function resolveSource(
    ref: SourceRef,
    request: ImgproxyRequest,
    config: ImgproxyConfig,
): Promise<ResolvedSource> {
    const url = decodeSourceRef(ref, config);
    if (!isSourceAllowed(url, config)) {
        throw new ImgproxyError("Source URL is not allowed", 403);
    }

    if (url.startsWith("data:")) {
        const data = decodeDataUrl(url);
        assertSourceSize(data.bytes.byteLength, request, config);
        verifyHashsum(data.bytes, request.hashsum);
        return {
            bytes: data.bytes,
            contentType: data.contentType,
            url,
            size: data.bytes.byteLength,
        };
    }

    if (url.startsWith("local://")) {
        const bytes = await readLocalFile(url, config);
        assertSourceSize(bytes.byteLength, request, config);
        verifyHashsum(bytes, request.hashsum);
        return { bytes, url, size: bytes.byteLength };
    }

    if (!/^https?:\/\//i.test(url)) {
        let protocol = "unknown";
        try {
            protocol = new URL(url).protocol;
        } catch {
            throw new ImgproxyError("Invalid source URL", 400);
        }
        throw new ImgproxyError(`Unsupported source URL scheme: ${protocol}`, 400);
    }

    await assertSafeRemoteUrl(url, config);
    const fetched = await fetchWithRedirects(url, config);
    const { response, url: finalUrl } = fetched;

    if (!response.ok) {
        throw new ImgproxyError(`Source image request failed with status ${response.status}`, response.status === 404 ? 404 : 422);
    }

    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength)) {
        assertSourceSize(contentLength, request, config);
    }

    if (request.raw) {
        if (!response.body) {
            throw new ImgproxyError("Source image response has no body", 422);
        }
        return {
            stream: response.body,
            contentType: response.headers.get("content-type") ?? undefined,
            size: Number.isFinite(contentLength) ? contentLength : undefined,
            url: finalUrl,
        };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    assertSourceSize(bytes.byteLength, request, config);
    verifyHashsum(bytes, request.hashsum);
    return {
        bytes,
        contentType: response.headers.get("content-type") ?? undefined,
        size: bytes.byteLength,
        url: finalUrl,
    };
}

export async function fetchWatermark(url: string, config: ImgproxyConfig): Promise<Uint8Array> {
    if (!/^https?:\/\//i.test(url)) {
        throw new ImgproxyError("Watermark URL must use http or https", 400);
    }
    if (!isSourceAllowed(url, config)) {
        throw new ImgproxyError("Watermark URL is not allowed", 403);
    }
    await assertSafeRemoteUrl(url, config);
    const { response } = await fetchWithRedirects(url, config);
    if (!response.ok) {
        throw new ImgproxyError(`Watermark image request failed with status ${response.status}`, 422);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 8 * 1024 * 1024) {
        throw new ImgproxyError("Watermark image is too large", 413);
    }
    return bytes;
}

export async function fetchFallbackImage(url: string, config: ImgproxyConfig): Promise<ResolvedSource> {
    if (!/^https?:\/\//i.test(url)) {
        throw new ImgproxyError("Fallback image URL must use http or https", 400);
    }
    if (!isSourceAllowed(url, config)) {
        throw new ImgproxyError("Fallback image URL is not allowed", 403);
    }
    await assertSafeRemoteUrl(url, config);
    const { response, url: finalUrl } = await fetchWithRedirects(url, config);
    if (!response.ok) {
        throw new ImgproxyError(`Fallback image request failed with status ${response.status}`, 422);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
        bytes,
        contentType: response.headers.get("content-type") ?? undefined,
        size: bytes.byteLength,
        url: finalUrl,
    };
}

function decodeSourceRef(ref: SourceRef, config: ImgproxyConfig): string {
    let url: string;
    if (ref.kind === "plain") {
        url = ref.value;
    } else if (ref.kind === "base64") {
        try {
            url = Buffer.from(ref.value, "base64url").toString("utf8");
        } catch {
            throw new ImgproxyError("Invalid Base64-encoded source URL", 400);
        }
    } else {
        url = decryptSourceUrl(ref.value, config);
    }

    url = url.trim();
    if (!url) {
        throw new ImgproxyError("Empty source URL", 400);
    }
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && config.baseUrl) {
        url = `${config.baseUrl}/${url.replace(/^\/+/, "")}`;
    }
    return url;
}

function decryptSourceUrl(value: string, config: ImgproxyConfig): string {
    if (!config.sourceUrlEncryptionKey) {
        throw new ImgproxyError("Source URL encryption is not configured", 500);
    }
    let encrypted: Buffer;
    try {
        encrypted = Buffer.from(value, "base64url");
    } catch {
        throw new ImgproxyError("Invalid encrypted source URL", 400);
    }
    if (encrypted.byteLength < 32) {
        throw new ImgproxyError("Invalid encrypted source URL", 400);
    }
    const iv = encrypted.subarray(0, 16);
    const body = encrypted.subarray(16);
    try {
        const algorithm = `aes-${config.sourceUrlEncryptionKey.byteLength * 8}-cbc`;
        const decipher = createDecipheriv(algorithm, config.sourceUrlEncryptionKey, iv);
        const decrypted = Buffer.concat([decipher.update(body), decipher.final()]);
        return decrypted.toString("utf8");
    } catch {
        throw new ImgproxyError("Invalid encrypted source URL", 400);
    }
}

function decodeDataUrl(url: string): { bytes: Uint8Array; contentType?: string } {
    const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) {
        throw new ImgproxyError("Invalid data URL", 400);
    }
    try {
        if (match[2]) {
            return {
                bytes: new Uint8Array(Buffer.from(match[3], "base64")),
                contentType: match[1],
            };
        }
        return {
            bytes: new TextEncoder().encode(decodeURIComponent(match[3])),
            contentType: match[1],
        };
    } catch {
        throw new ImgproxyError("Invalid data URL", 400);
    }
}

async function readLocalFile(url: string, config: ImgproxyConfig): Promise<Uint8Array> {
    if (!config.localFilesystemRoot) {
        throw new ImgproxyError("Local filesystem sources are disabled", 403);
    }
    const relative = decodeURIComponent(url.slice("local://".length));
    const root = path.resolve(config.localFilesystemRoot);
    const filePath = path.resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        throw new ImgproxyError("Local source path escapes the configured root", 403);
    }
    const info = await stat(filePath).catch(() => undefined);
    if (!info?.isFile()) {
        throw new ImgproxyError("Local source image was not found", 404);
    }
    return new Uint8Array(await readFile(filePath));
}

function assertSourceSize(size: number, request: ImgproxyRequest, config: ImgproxyConfig): void {
    const limit = Math.min(
        MAX_PAYLOAD_BYTES,
        request.maxSrcFileSize || Number.POSITIVE_INFINITY,
        config.maxSrcFileSize || Number.POSITIVE_INFINITY,
    );
    if (size > limit) {
        throw new ImgproxyError(`Source image exceeds maximum size of ${limit} bytes`, 413);
    }
}

function verifyHashsum(bytes: Uint8Array, hashsum?: Hashsum): void {
    if (!hashsum || hashsum.type === "none" || !hashsum.hash) return;
    const algorithms: Record<string, string> = {
        md5: "md5",
        sha1: "sha1",
        sha256: "sha256",
        sha512: "sha512",
    };
    const algorithm = algorithms[hashsum.type];
    if (!algorithm) {
        throw new ImgproxyError(`Unsupported hashsum type: ${hashsum.type}`, 400);
    }
    const digest = createHash(algorithm).update(bytes).digest("hex");
    if (digest !== hashsum.hash.toLowerCase()) {
        throw new ImgproxyError("Source image hashsum mismatch", 422);
    }
}

function isSourceAllowed(url: string, config: ImgproxyConfig): boolean {
    if (config.allowedSources.length === 0) return true;
    return config.allowedSources.some((pattern) => {
        const escaped = pattern
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*");
        return new RegExp(`^${escaped}`).test(url);
    });
}

async function assertSafeRemoteUrl(url: string, config: ImgproxyConfig): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ImgproxyError(`Unsupported source URL scheme: ${parsed.protocol}`, 400);
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost") {
        if (!config.allowLoopback) {
            throw new ImgproxyError("Loopback source addresses are not allowed", 403);
        }
        return;
    }

    const literal = isIP(hostname);
    const addresses = literal
        ? [{ address: hostname, family: literal }]
        : await lookup(hostname, { all: true }).catch(() => []);

    if (addresses.length === 0) {
        throw new ImgproxyError("Source hostname could not be resolved", 422);
    }

    for (const { address } of addresses) {
        if (isLoopbackAddress(address) && !config.allowLoopback) {
            throw new ImgproxyError("Loopback source addresses are not allowed", 403);
        }
        if (isLinkLocalAddress(address) && !config.allowLinkLocal) {
            throw new ImgproxyError("Link-local source addresses are not allowed", 403);
        }
        if (isPrivateAddress(address) && !config.allowPrivate) {
            throw new ImgproxyError("Private source addresses are not allowed", 403);
        }
    }
}

function isLoopbackAddress(address: string): boolean {
    if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
    const ipv4 = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) return Number(ipv4[1]) === 127;
    return false;
}

function isLinkLocalAddress(address: string): boolean {
    if (address.startsWith("fe80:") || address.startsWith("169.254.")) return true;
    return false;
}

function isPrivateAddress(address: string): boolean {
    if (address === "::1") return true;
    if (address.startsWith("::ffff:")) {
        return isPrivateAddress(address.slice("::ffff:".length));
    }
    const ipv4 = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
        const a = Number(ipv4[1]);
        const b = Number(ipv4[2]);
        return a === 10
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || a === 127
            || (a === 169 && b === 254)
            || a === 0;
    }
    const ipv6 = address.toLowerCase();
    return ipv6.startsWith("fc") || ipv6.startsWith("fd") || ipv6.startsWith("fe80:");
}

async function fetchWithRedirects(url: string, config: ImgproxyConfig): Promise<RedirectFetch> {
    let current = url;
    for (let redirect = 0; redirect < 5; redirect += 1) {
        await assertSafeRemoteUrl(current, config);
        const response = await fetch(current, {
            redirect: "manual",
            signal: AbortSignal.timeout(config.timeoutMs),
            headers: {
                "User-Agent": "SupaCloud-Image/1.0 (+https://github.com/vibeunion/supacloud)",
                Accept: "image/*,*/*;q=0.8",
            },
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) {
                throw new ImgproxyError("Source image redirect has no Location header", 422);
            }
            current = new URL(location, current).toString();
            continue;
        }
        return { response, url: current };
    }
    throw new ImgproxyError("Too many source image redirects", 422);
}
