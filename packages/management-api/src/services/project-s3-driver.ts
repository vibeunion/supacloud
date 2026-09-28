import type { StorageDriver, BucketDeletionResult } from "./storage.adapter";
import { logicalBucket, storagePath, ProjectStorageError, type ProjectS3Configuration } from "./project-storage-contract";

type UploadBody = Blob | Buffer | Uint8Array | ArrayBuffer | ReadableStream;
interface ObjectEntry { key: string; size?: number; lastModified?: string | Date; }
export interface ProjectS3Client {
  list(options: { prefix: string; maxKeys?: number; continuationToken?: string }): Promise<{
    contents?: ObjectEntry[]; isTruncated?: boolean; nextContinuationToken?: string;
  }>;
  file(key: string): {
    type?: string | undefined;
    exists(): Promise<boolean>;
    arrayBuffer(): Promise<ArrayBuffer>;
    write(data: Uint8Array, options: { type: string }): Promise<unknown>;
    delete(): Promise<unknown>;
    presign(options: { method: "GET"; expiresIn: number }): string;
  };
}

/** One immutable project/client pair. Never reads process-wide S3 credentials. */
export class ProjectS3Driver implements StorageDriver {
  private readonly settings: Readonly<ProjectS3Configuration>;
  constructor(settings: ProjectS3Configuration, private readonly client: ProjectS3Client) {
    this.settings = Object.freeze({ ...settings });
  }
  private root(ref: string): string {
    if (ref !== this.settings.projectRef || !this.settings.enabled) throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
    return this.settings.prefix;
  }
  private prefix(ref: string, bucket: string): string {
    return `${this.root(ref)}${logicalBucket(bucket)}/`;
  }
  private key(ref: string, bucket: string, key: string): string {
    const result = `${this.prefix(ref, bucket)}${storagePath(key)}`;
    if (new TextEncoder().encode(result).length > 1024) throw new ProjectStorageError("STORAGE_CONFIG_INVALID", 400);
    return result;
  }
  private async perform<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ProjectStorageError) throw error;
      // Never return false/[]/null for transport or credential failures.
      throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    }
  }
  private async *objects(prefix: string): AsyncGenerator<ObjectEntry> {
    let continuationToken: string | undefined;
    const tokens = new Set<string>();
    for (let page = 0; page < 10000; page++) {
      const result = await this.client.list({ prefix, maxKeys: 1000, ...(continuationToken ? { continuationToken } : {}) });
      for (const item of result.contents ?? []) {
        if (typeof item.key !== 'string' || !item.key.startsWith(prefix)) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
        yield item;
      }
      if (!result.isTruncated) return;
      continuationToken = result.nextContinuationToken;
      if (!continuationToken || tokens.has(continuationToken)) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
      tokens.add(continuationToken);
    }
    throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
  }
  async createBucket(ref: string, bucket: string): Promise<boolean> {
    const prefix = bucket ? this.prefix(ref, bucket) : this.root(ref);
    return this.perform(async () => {
      // Attached physical buckets already exist; never create/change an upstream bucket.
      await this.client.list({ prefix, maxKeys: 1 });
      return true;
    });
  }
  async deleteBucket(ref: string, bucket: string): Promise<BucketDeletionResult> {
    return (await this.isBucketEmpty(ref, bucket)) ? { success: true } : { success: false, reason: "not_empty" };
  }
  async emptyBucket(ref: string, bucket: string): Promise<boolean> {
    const prefix = this.prefix(ref, bucket);
    return this.perform(async () => {
      // Delete only this prefix. Restart each page because the listing changes after deletion.
      let previous = "";
      for (let page = 0; page < 10000; page++) {
        const result = await this.client.list({ prefix, maxKeys: 100 });
        const keys = (result.contents ?? []).map((entry) => entry.key);
        if (keys.some((key) => typeof key !== 'string' || !key.startsWith(prefix))) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
        if (!keys.length) {
          if (result.isTruncated) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
          return true;
        }
        const fingerprint = JSON.stringify(keys);
        if (fingerprint === previous) throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
        previous = fingerprint;
        for (let index = 0; index < keys.length; index += 8) {
          await Promise.all(keys.slice(index, index + 8).map((key) => this.client.file(key).delete()));
        }
      }
      throw new ProjectStorageError("STORAGE_BACKEND_UNAVAILABLE");
    });
  }
  async listBuckets(ref: string) {
    const root = this.root(ref);
    return this.perform(async () => {
      const buckets = new Set<string>();
      for await (const item of this.objects(root)) {
        const suffix = item.key.slice(root.length);
        if (suffix.includes('/')) buckets.add(suffix.split('/')[0]!);
      }
      return [...buckets].map((id) => ({ id, name: id, public: false, size: "-" }));
    });
  }
  async uploadFile(ref: string, bucket: string, key: string, data: UploadBody, contentType: string): Promise<boolean> {
    const target = this.key(ref, bucket, key);
    return this.perform(async () => {
      const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data)
        : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(await new Response(data).arrayBuffer());
      await this.client.file(target).write(bytes, { type: contentType });
      return true;
    });
  }
  async copyFile(ref: string, srcBucket: string, srcKey: string, destBucket: string, destKey: string): Promise<boolean> {
    // Both locations belong to the SAME immutable project configuration.
    this.key(ref, destBucket, destKey);
    const source = await this.getDownloadResponse(ref, srcBucket, srcKey);
    if (!source) return false;
    return this.uploadFile(ref, destBucket, destKey, await source.arrayBuffer(), source.headers.get('content-type') ?? 'application/octet-stream');
  }
  async deleteFile(ref: string, bucket: string, key: string): Promise<boolean> {
    const target = this.key(ref, bucket, key);
    return this.perform(async () => { await this.client.file(target).delete(); return true; });
  }
  async listFiles(ref: string, bucket: string) {
    const prefix = this.prefix(ref, bucket);
    return this.perform(async () => {
      const files: { id: string; name: string; size: string; type: string; updated?: string }[] = [];
      for await (const item of this.objects(prefix)) {
        const name = item.key.slice(prefix.length);
        files.push({ id: name, name, size: Math.round((item.size ?? 0) / 1024) + " KB",
          type: name.includes('.') ? name.split('.').pop()! : 'unknown',
          ...(item.lastModified === undefined ? {} : { updated: String(item.lastModified) }) });
      }
      return files;
    });
  }
  async isBucketEmpty(ref: string, bucket: string): Promise<boolean> {
    const prefix = this.prefix(ref, bucket);
    return this.perform(async () => {
      for await (const _item of this.objects(prefix)) return false;
      return true;
    });
  }
  async getDownloadResponse(ref: string, bucket: string, key: string): Promise<Response | null> {
    const target = this.key(ref, bucket, key);
    return this.perform(async () => {
      const file = this.client.file(target);
      if (!(await file.exists())) return null;
      const bytes = await file.arrayBuffer();
      return new Response(bytes, { headers: { 'content-type': file.type || 'application/octet-stream', 'content-length': String(bytes.byteLength) } });
    });
  }
  async getInternalSourceUrl(ref: string, bucket: string, key: string): Promise<string> {
    const target = this.key(ref, bucket, key);
    return this.perform(async () => this.client.file(target).presign({ method: 'GET', expiresIn: 60 }));
  }
}
