import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type ImageCacheEntry = {
    bytes: Uint8Array;
    contentType: string;
    etag: string;
    createdAt: number;
};

type CacheMetadata = {
    contentType: string;
    etag: string;
    createdAt: number;
    size: number;
};

export type ImageCacheOptions = {
    directory: string;
    ttlSeconds: number;
    maxBytes: number;
    maxEntries: number;
};

export function createImageCacheKey(parts: readonly string[]): string {
    const digest = createHash("sha256");
    for (const part of parts) {
        digest.update(String(part).length.toString(10));
        digest.update(":");
        digest.update(String(part));
        digest.update("|");
    }
    return digest.digest("hex");
}

export class ImageResultCache {
    private ready?: Promise<void>;

    constructor(private readonly options: ImageCacheOptions) {}

    get enabled(): boolean {
        return Boolean(this.options.directory)
            && this.options.ttlSeconds > 0
            && this.options.maxBytes > 0
            && this.options.maxEntries > 0;
    }

    async get(key: string): Promise<ImageCacheEntry | undefined> {
        if (!this.enabled) return undefined;
        try {
            await this.ensureDirectory();
            const paths = this.paths(key);
            const [metadataRaw, bytes] = await Promise.all([
                readFile(paths.metadata, "utf8"),
                readFile(paths.body),
            ]);
            const metadata = JSON.parse(metadataRaw) as CacheMetadata;
            if (!Number.isFinite(metadata.createdAt)
                || Date.now() - metadata.createdAt > this.options.ttlSeconds * 1000
                || metadata.size !== bytes.byteLength) {
                await this.remove(paths);
                return undefined;
            }
            return {
                bytes: new Uint8Array(bytes),
                contentType: metadata.contentType,
                etag: metadata.etag,
                createdAt: metadata.createdAt,
            };
        } catch {
            // Result caching is an optimization; an unavailable cache must not fail image delivery.
            return undefined;
        }
    }

    async set(key: string, value: Omit<ImageCacheEntry, "createdAt">): Promise<void> {
        if (!this.enabled) return;
        let bodyTemp: string | undefined;
        let metadataTemp: string | undefined;
        try {
            await this.ensureDirectory();
            const createdAt = Date.now();
            const paths = this.paths(key);
            const metadata: CacheMetadata = {
                contentType: value.contentType,
                etag: value.etag,
                createdAt,
                size: value.bytes.byteLength,
            };
            const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
            bodyTemp = `${paths.body}.${suffix}.tmp`;
            metadataTemp = `${paths.metadata}.${suffix}.tmp`;
            await writeFile(bodyTemp, value.bytes);
            await writeFile(metadataTemp, JSON.stringify(metadata));
            await rename(bodyTemp, paths.body);
            await rename(metadataTemp, paths.metadata);
            await this.prune();
        } catch {
            // Result caching is an optimization; an unavailable cache must not fail image delivery.
        } finally {
            await Promise.all([
                bodyTemp ? unlink(bodyTemp).catch(() => undefined) : Promise.resolve(),
                metadataTemp ? unlink(metadataTemp).catch(() => undefined) : Promise.resolve(),
            ]);
        }
    }

    private paths(key: string): { body: string; metadata: string } {
        const base = path.join(this.options.directory, key);
        return { body: `${base}.body`, metadata: `${base}.json` };
    }

    private async ensureDirectory(): Promise<void> {
        if (!this.ready) {
            this.ready = mkdir(this.options.directory, { recursive: true })
                .then(() => undefined)
                .catch((error) => {
                    this.ready = undefined;
                    throw error;
                });
        }
        await this.ready;
    }

    private async remove(paths: { body: string; metadata: string }): Promise<void> {
        await Promise.all([
            unlink(paths.body).catch(() => undefined),
            unlink(paths.metadata).catch(() => undefined),
        ]);
    }

    private async prune(): Promise<void> {
        const entries = await readdir(this.options.directory).catch(() => []);
        const metadataEntries = entries.filter((entry) => entry.endsWith(".json"));
        const records: Array<{ key: string; createdAt: number; size: number }> = [];
        for (const entry of metadataEntries) {
            const metadataPath = path.join(this.options.directory, entry);
            try {
                const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as CacheMetadata;
                const bodyPath = metadataPath.slice(0, -".json".length) + ".body";
                const bodyInfo = await stat(bodyPath);
                records.push({
                    key: entry.slice(0, -".json".length),
                    createdAt: metadata.createdAt,
                    size: bodyInfo.size,
                });
            } catch {
                await unlink(metadataPath).catch(() => undefined);
            }
        }

        records.sort((left, right) => left.createdAt - right.createdAt);
        let totalBytes = records.reduce((total, record) => total + record.size, 0);
        while (records.length > this.options.maxEntries || totalBytes > this.options.maxBytes) {
            const record = records.shift();
            if (!record) break;
            totalBytes -= record.size;
            await this.remove(this.paths(record.key));
        }
    }
}

export function cacheEtag(bytes: Uint8Array): string {
    return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

export function cacheMatches(request: Request, etag: string): boolean {
    return request.headers.get("if-none-match")?.split(",").some((value) => value.trim() === etag) ?? false;
}
