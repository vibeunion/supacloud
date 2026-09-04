import { config } from "../config";
import { logger } from "../utils/logger";
import { normalizeCiS3Endpoint } from "../utils/sdk-parity";
import { shellService } from "./shell.service";
import { resolveBucketName } from "../db";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { S3Client } from "bun";
import { AwsClient } from "aws4fetch";

function normalizeObjectKey(key: string): string {
  const normalized = key.replace(/^\/+/, "");
  if (!normalized || normalized.includes("\\") || /[\x00-\x1f\x7f]/.test(normalized)) {
    throw new Error("Invalid object key");
  }
  if (path.isAbsolute(normalized) || normalized.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new Error("Invalid object key");
  }
  return normalized;
}

const BUCKET_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const DOT_ONLY_PATTERN = /^\.+$/;

function normalizeBucketId(bucket: string): string {
  if (!BUCKET_ID_PATTERN.test(bucket) || DOT_ONLY_PATTERN.test(bucket)) {
    throw new Error("Invalid bucket identifier");
  }
  return bucket;
}

function isOutsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function resolveRealPath(p: string): string {
  const rest: string[] = [];
  let candidate = p;
  for (;;) {
    try {
      const real = syncFs.realpathSync(candidate);
      return rest.length > 0 ? path.join(real, ...rest) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return candidate;
      rest.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export interface StorageDriver {
  createBucket(projectRef: string, bucket: string): Promise<boolean>;
  deleteBucket(projectRef: string, bucket: string): Promise<BucketDeletionResult>;
  emptyBucket(projectRef: string, bucket: string): Promise<boolean>;
  listBuckets(
    projectRef: string,
  ): Promise<{ id: string; name: string; public: boolean; size: string }[]>;
  uploadFile(
    projectRef: string,
    bucket: string,
    key: string,
    data: Blob | Buffer | Uint8Array | ArrayBuffer | ReadableStream,
    contentType: string,
  ): Promise<boolean>;
  uploadFileConditional?(
    projectRef: string,
    bucket: string,
    key: string,
    data: Blob | Buffer | Uint8Array | ArrayBuffer | ReadableStream,
    contentType: string,
    expectedEtag: string | null,
  ): Promise<ConditionalUploadResult>;
  copyFile(
    projectRef: string,
    srcBucket: string,
    srcKey: string,
    destBucket: string,
    destKey: string,
  ): Promise<boolean>;
  deleteFile(projectRef: string, bucket: string, key: string): Promise<boolean>;
  listFiles(
    projectRef: string,
    bucket: string,
  ): Promise<
    { id: string; name: string; updated?: string; size: string; type: string }[]
  >;
  isBucketEmpty(projectRef: string, bucket: string): Promise<boolean>;
  getDownloadResponse(
    projectRef: string,
    bucket: string,
    key: string,
  ): Promise<Response | null>;
}

export type ConditionalUploadResult =
  | { outcome: "created" | "replaced"; etag: string }
  | { outcome: "exists" | "etag_mismatch" };

export type BucketDeletionResult =
  | { success: true }
  | { success: false; reason: "not_empty" | "unknown" };

function isDirectoryNotEmpty(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOTEMPTY" || code === "EEXIST";
}

async function createObjectParent(bucketPath: string, objectKey: string): Promise<void> {
  const bucket = await fs.lstat(bucketPath);
  if (!bucket.isDirectory()) throw new Error("Storage bucket is unavailable");

  let objectParent = bucketPath;
  for (const segment of objectKey.split("/").slice(0, -1)) {
    objectParent = path.join(objectParent, segment);
    try {
      await fs.mkdir(objectParent);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await fs.lstat(objectParent)).isDirectory()) {
        throw new Error("Storage object parent is unavailable");
      }
    }
  }
}

function objectEtag(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class JuiceFSDriver implements StorageDriver {
  private getBasePath(
    projectRef: string,
    bucket?: string,
    key?: string,
  ): string {
    const mountRoot = path.resolve(config.storageMountPoint);
    const realMountRoot = resolveRealPath(mountRoot);
    const root = path.resolve(mountRoot, resolveBucketName(projectRef));
    const realRoot = resolveRealPath(root);
    if (isOutsideRoot(realMountRoot, realRoot)) {
      throw new Error(`Path traversal blocked: ${realRoot} escapes ${realMountRoot}`);
    }
    let p = root;
    if (bucket) p = path.join(p, normalizeBucketId(bucket));
    if (key) p = path.join(p, normalizeObjectKey(key));
    const resolved = path.resolve(p);
    if (isOutsideRoot(root, resolved)) {
      throw new Error(`Path traversal blocked: ${resolved} escapes ${root}`);
    }
    const realResolved = resolveRealPath(resolved);
    if (isOutsideRoot(realRoot, realResolved)) {
      throw new Error(`Path traversal blocked: ${realResolved} escapes ${realRoot}`);
    }
    return resolved;
  }

  async createBucket(projectRef: string, bucket: string): Promise<boolean> {
    try {
      await fs.mkdir(this.getBasePath(projectRef, bucket), { recursive: true });
      return true;
    } catch (e: unknown) {
      logger.error("JuiceFS createBucket error:", {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  async deleteBucket(projectRef: string, bucket: string): Promise<BucketDeletionResult> {
    try {
      await fs.rmdir(this.getBasePath(projectRef, bucket));
      return { success: true };
    } catch (error: unknown) {
      if (isDirectoryNotEmpty(error)) return { success: false, reason: "not_empty" };
      logger.warn("JuiceFS deleteBucket failed without deleting the bucket", {
        projectRef,
        bucket,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, reason: "unknown" };
    }
  }

  async emptyBucket(projectRef: string, bucket: string): Promise<boolean> {
    try {
      const bucketPath = this.getBasePath(projectRef, bucket);
      await fs.rm(bucketPath, { recursive: true, force: true });
      await fs.mkdir(bucketPath, { recursive: true });
      return true;
    } catch (e: unknown) {
      logger.error("JuiceFS emptyBucket error:", {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  async listBuckets(
    projectRef: string,
  ): Promise<{ id: string; name: string; public: boolean; size: string }[]> {
    try {
      const dirPath = this.getBasePath(projectRef);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => ({
          id: e.name,
          name: e.name,
          public: false, // Defaulting to false, proper public status lives in tenant DB
          size: "-",
        }));
    } catch (e) {
      return [];
    }
  }

  async uploadFile(
    projectRef: string,
    bucket: string,
    key: string,
    data: Blob | Buffer | Uint8Array | ArrayBuffer | ReadableStream,
    contentType: string,
  ): Promise<boolean> {
    try {
      const cleanKey = normalizeObjectKey(key);
      await createObjectParent(this.getBasePath(projectRef, bucket), cleanKey);
      const filePath = this.getBasePath(projectRef, bucket, cleanKey);
      await Bun.write(filePath, await toUint8Array(data));
      return true;
    } catch (e: unknown) {
      logger.error("JuiceFS uploadFile error:", {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  /**
   * Best-effort conditional write for the filesystem-backed JuiceFS driver.
   * Create-only writes use O_EXCL; replacements validate the current content
   * before an atomic temp-file rename. External SMB writers can still race a
   * replacement after validation, so callers must treat this as an adapter
   * capability rather than a distributed CAS primitive.
   */
  async uploadFileConditional(
    projectRef: string,
    bucket: string,
    key: string,
    data: Blob | Buffer | Uint8Array | ArrayBuffer | ReadableStream,
    _contentType: string,
    expectedEtag: string | null,
  ): Promise<ConditionalUploadResult> {
    const cleanKey = normalizeObjectKey(key);
    const bucketPath = this.getBasePath(projectRef, bucket);
    await createObjectParent(bucketPath, cleanKey);
    const filePath = this.getBasePath(projectRef, bucket, cleanKey);
    const bytes = await toUint8Array(data);

    if (expectedEtag === null) {
      let handle: fs.FileHandle | undefined;
      try {
        handle = await fs.open(filePath, "wx");
        await handle.writeFile(bytes);
        return { outcome: "created", etag: objectEtag(bytes) };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return { outcome: "exists" };
        }
        throw error;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }

    let currentBytes: Buffer;
    try {
      currentBytes = await fs.readFile(filePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { outcome: "etag_mismatch" };
      }
      throw error;
    }
    if (objectEtag(currentBytes) !== expectedEtag.replace(/^"|"$/g, "")) {
      return { outcome: "etag_mismatch" };
    }

    const temporaryPath = `${filePath}.supacloud-${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, bytes, { flag: "wx" });
      await fs.rename(temporaryPath, filePath);
      return { outcome: "replaced", etag: objectEtag(bytes) };
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async copyFile(
    projectRef: string,
    srcBucket: string,
    srcKey: string,
    destBucket: string,
    destKey: string,
  ): Promise<boolean> {
    try {
      const srcPath = this.getBasePath(projectRef, srcBucket, srcKey);
      const cleanDestKey = normalizeObjectKey(destKey);
      await createObjectParent(this.getBasePath(projectRef, destBucket), cleanDestKey);
      const destPath = this.getBasePath(projectRef, destBucket, cleanDestKey);
      await fs.copyFile(srcPath, destPath);
      return true;
    } catch (e) {
      return false;
    }
  }

  async deleteFile(
    projectRef: string,
    bucket: string,
    key: string,
  ): Promise<boolean> {
    try {
      await fs.unlink(this.getBasePath(projectRef, bucket, key));
      return true;
    } catch (e) {
      return false;
    }
  }

  async listFiles(
    projectRef: string,
    bucket: string,
  ): Promise<
    { id: string; name: string; updated?: string; size: string; type: string }[]
  > {
    try {
      const bucketPath = this.getBasePath(projectRef, bucket);
      const { Glob } = await import("bun");
      const glob = new Glob("**/*");
      const files: {
        id: string;
        name: string;
        updated?: string;
        size: string;
        type: string;
      }[] = [];

      for (const relPath of glob.scanSync({
        cwd: bucketPath,
        onlyFiles: true,
      })) {
        const fullPath = path.join(bucketPath, relPath);
        const f = Bun.file(fullPath);

        files.push({
          id: relPath,
          name: relPath,
          updated: new Date(f.lastModified).toISOString(),
          size: Math.round(f.size / 1024) + " KB",
          type: relPath.includes(".")
            ? relPath.split(".").pop() || "unknown"
            : "unknown",
        });
      }
      return files;
    } catch (e) {
      return [];
    }
  }

  async isBucketEmpty(projectRef: string, bucket: string): Promise<boolean> {
    const entries = await fs.readdir(this.getBasePath(projectRef, bucket));
    return entries.length === 0;
  }

  async getDownloadResponse(
    projectRef: string,
    bucket: string,
    key: string,
  ): Promise<Response | null> {
    const file = Bun.file(this.getBasePath(projectRef, bucket, key));
    if (!(await file.exists())) return null;
    const content = await file.arrayBuffer();
    return new Response(content, {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Content-Length": String(content.byteLength),
      },
    });
  }
}

/**
 * Create an S3/MinIO bucket using raw HTTP + AWS Signature V4.
 * Replaces @aws-sdk/client-s3 for bucket creation — uses only Bun's built-in crypto.subtle.
 * Returns true if created or already exists (409 = BucketAlreadyOwnedByYou).
 */
async function createS3BucketWithFetch(
  endpoint: string,
  bucketName: string,
  accessKey: string,
  secretKey: string,
  region = "us-east-1",
): Promise<boolean> {
  const base = endpoint.replace(/\/+$/, "");
  const url = `${base}/${bucketName}`;
  const aws = new AwsClient({ accessKeyId: accessKey, secretAccessKey: secretKey, region, service: "s3" });
  
  try {
    const res = await aws.fetch(url, { method: "PUT" });
    if (res.ok || res.status === 409 || res.status === 200) return true;
    const body = await res.text().catch(() => "");
    logger.warn(`[S3] createBucket HTTP ${res.status}: ${body.slice(0, 120)}`);
    return false;
  } catch (err: unknown) {
    logger.warn(
      "[S3] createBucket fetch error:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

async function toUint8Array(
  data: Blob | Buffer | Uint8Array | ArrayBuffer | ReadableStream,
): Promise<Uint8Array> {
  const bytes = data instanceof Uint8Array
    ? data
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : new Uint8Array(await new Response(data as ReadableStream).arrayBuffer());

  const marker = "[object ReadableStream]";
  if (bytes.byteLength === marker.length && new TextDecoder().decode(bytes) === marker) {
    throw new Error("Refusing to persist stringified ReadableStream marker as object bytes");
  }

  return bytes;
}

async function putS3ObjectWithFetch(
  endpoint: string,
  bucketName: string,
  objectKey: string,
  data: Blob | Buffer | Uint8Array | ArrayBuffer | ReadableStream,
  contentType: string,
  accessKey: string,
  secretKey: string,
  region = "us-east-1",
): Promise<boolean> {
  const base = endpoint.replace(/\/+$/, "");
  const encodedKey = objectKey.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const url = `${base}/${bucketName}/${encodedKey}`;
  
  const aws = new AwsClient({ accessKeyId: accessKey, secretAccessKey: secretKey, region, service: "s3" });

  try {
    const bytes = await toUint8Array(data);
    const response = await aws.fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
      },
      body: Buffer.from(bytes),
    });

    if (response.ok) return true;
    const body = await response.text().catch(() => "");
    logger.warn(
      `[S3] putObject HTTP ${response.status} for ${bucketName}/${objectKey}: ${body.slice(0, 160)}`,
    );
    return false;
  } catch (err: unknown) {
    logger.warn(
      "[S3] putObject fetch error:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

async function retryAsync<T>(
  attempts: number,
  fn: () => Promise<T>,
  shouldRetry: (value: T) => boolean,
  delayMs = 250,
): Promise<T> {
  let lastValue: T | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const value = await fn();
    lastValue = value;
    if (!shouldRetry(value) || attempt === attempts) {
      return value;
    }
    await Bun.sleep(delayMs * attempt);
  }
  return lastValue as T;
}

export class S3Driver implements StorageDriver {
  private normalizeEndpoint(endpoint: string): string {
    return normalizeCiS3Endpoint(endpoint);
  }

  private async getCreds(projectRef: string): Promise<{
    accessKey?: string;
    secretKey?: string;
    endpoint: string;
    bucket: string;
  } | null> {
    if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.NODE_ENV === "test") {
      return {
        accessKey: process.env.S3_ACCESS_KEY || "minioadmin",
        secretKey: process.env.S3_SECRET_KEY || "minioadmin",
        endpoint: this.normalizeEndpoint(
          config.s3Endpoint || "http://127.0.0.1:9000",
        ),
        bucket: resolveBucketName(projectRef),
      };
    }

    const { success, output } = await shellService.execute("s3_manager.sh", [
      "credentials",
      projectRef,
    ]);
    if (!success) {
      return {
        accessKey: process.env.S3_ACCESS_KEY,
        secretKey: process.env.S3_SECRET_KEY,
        endpoint: this.normalizeEndpoint(config.s3Endpoint),
        bucket: resolveBucketName(projectRef),
      };
    }
    return {
      accessKey: output.match(/ACCESS_KEY=([^\n]+)/)?.[1]?.trim(),
      secretKey: output.match(/SECRET_KEY=([^\n]+)/)?.[1]?.trim(),
      endpoint: this.normalizeEndpoint(
        output.match(/ENDPOINT=([^\n]+)/)?.[1]?.trim() || config.s3Endpoint,
      ),
      bucket:
        output.match(/BUCKET=([^\n]+)/)?.[1]?.trim() ||
        resolveBucketName(projectRef),
    };
  }

  private getClient(creds: {
    accessKey: string;
    secretKey: string;
    endpoint: string;
    bucket: string;
  }): S3Client {
    const baseUrl = creds.endpoint.endsWith("/")
      ? creds.endpoint.slice(0, -1)
      : creds.endpoint;
    return new S3Client({
      accessKeyId: creds.accessKey,
      secretAccessKey: creds.secretKey,
      endpoint: baseUrl,
      region: "us-east-1", // or config
      bucket: creds.bucket,
    });
  }

  async createBucket(projectRef: string, bucket: string): Promise<boolean> {
    if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.NODE_ENV === "test") {
      const creds = await this.getCreds(projectRef);
      if (creds?.accessKey && creds?.secretKey) {
        const { endpoint, bucket: physicalBucket, accessKey, secretKey } = creds;
        const ok = await retryAsync(
          4,
          () =>
            createS3BucketWithFetch(
              endpoint,
              physicalBucket,
              accessKey,
              secretKey,
            ),
          (result) => !result,
        );
        if (ok) return true;
        logger.warn(
          `[S3] createBucket failed for ${projectRef} at ${creds.endpoint}`,
        );
        return false;
      }
      logger.warn(`[S3] createBucket missing credentials for ${projectRef}`);
      return false;
    }
    return true; // Buckets are logical prefixes in S3 for SupaCloud
  }

  async deleteBucket(_projectRef: string, _bucket: string): Promise<BucketDeletionResult> {
    return { success: false, reason: "unknown" };
  }

  async emptyBucket(projectRef: string, bucket: string): Promise<boolean> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return false;

    try {
      const s3 = this.getClient(
        creds as {
          accessKey: string;
          secretKey: string;
          endpoint: string;
          bucket: string;
        },
      );
      const res = await s3.list({ prefix: `${bucket}/` });
      const contents = res.contents || [];

      await Promise.all(
        contents.map((file: Record<string, unknown>) =>
          s3.file(String(file.key)).delete(),
        ),
      );
      return true;
    } catch (e: unknown) {
      logger.error("S3 emptyBucket error:", {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  async listBuckets(
    projectRef: string,
  ): Promise<{ id: string; name: string; public: boolean; size: string }[]> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return [];

    try {
      const s3 = this.getClient(
        creds as {
          accessKey: string;
          secretKey: string;
          endpoint: string;
          bucket: string;
        },
      );
      const res = await s3.list();
      const s3Contents = res.contents || [];

      const buckets = new Set<string>();
      for (const obj of s3Contents) {
        // Find top-level directories which represent buckets in our mapping
        const parts = obj.key.split("/");
        if (parts.length > 1) {
          buckets.add(parts[0]);
        }
      }

      return Array.from(buckets).map((b) => ({
        id: b,
        name: b,
        public: false,
        size: "-",
      }));
    } catch (e) {
      return [];
    }
  }

  async uploadFile(
    projectRef: string,
    bucket: string,
    key: string,
    data: Blob | Buffer | Uint8Array | ArrayBuffer | ReadableStream,
    contentType: string,
  ): Promise<boolean> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return false;

    try {
      const cleanFileName = normalizeObjectKey(key);

      if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.NODE_ENV === "test") {
        return await putS3ObjectWithFetch(
          creds.endpoint,
          creds.bucket,
          `${bucket}/${cleanFileName}`,
          data,
          contentType,
          creds.accessKey,
          creds.secretKey,
        );
      }

      const s3 = this.getClient(
        creds as {
          accessKey: string;
          secretKey: string;
          endpoint: string;
          bucket: string;
        },
      );
      const uploadBody = await toUint8Array(data);
      const bytesWritten = await s3
        .file(`${bucket}/${cleanFileName}`)
        .write(uploadBody, { type: contentType });
      return typeof bytesWritten === "number" ? bytesWritten >= 0 : true;
    } catch (e: unknown) {
      logger.warn("[S3] uploadFile failed", {
        error: e instanceof Error ? e.message : String(e),
        projectRef,
        bucket,
        key,
      });
      return false;
    }
  }

  async copyFile(
    projectRef: string,
    srcBucket: string,
    srcKey: string,
    destBucket: string,
    destKey: string,
  ): Promise<boolean> {
    const srcRes = await this.getDownloadResponse(
      projectRef,
      srcBucket,
      srcKey,
    );
    if (!srcRes || !srcRes.body) return false;
    return this.uploadFile(
      projectRef,
      destBucket,
      destKey,
      srcRes.body,
      srcRes.headers.get("content-type") || "application/octet-stream",
    );
  }

  async deleteFile(
    projectRef: string,
    bucket: string,
    key: string,
  ): Promise<boolean> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return false;

    try {
      const cleanFileName = normalizeObjectKey(key);
      const s3 = this.getClient(
        creds as {
          accessKey: string;
          secretKey: string;
          endpoint: string;
          bucket: string;
        },
      );
      await s3.file(`${bucket}/${cleanFileName}`).delete();
      return true;
    } catch (e) {
      return false;
    }
  }

  async listFiles(projectRef: string, bucket: string): Promise<any[]> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return [];

    try {
      const s3 = this.getClient(
        creds as {
          accessKey: string;
          secretKey: string;
          endpoint: string;
          bucket: string;
        },
      );
      const res = await s3.list();
      const s3Contents = (res.contents || []).filter(
        (f: Record<string, unknown>) =>
          typeof f.key === "string" && f.key.startsWith(`${bucket}/`),
      );

      return s3Contents.map((file: Record<string, unknown>) => {
        const key = file.key as string;
        const relativeKey = key.substring(bucket.length + 1);
        return {
          id: relativeKey,
          name: relativeKey,
          updated: String(file.lastModified),
          size: Math.round((Number(file.size) ?? 0) / 1024) + " KB",
          type: key.includes(".")
            ? key.split(".").pop() || "unknown"
            : "unknown",
        };
      });
    } catch (e) {
      return [];
    }
  }

  async isBucketEmpty(projectRef: string, bucket: string): Promise<boolean> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) {
      throw new Error("Storage credentials are unavailable");
    }
    const s3 = this.getClient(
      creds as {
        accessKey: string;
        secretKey: string;
        endpoint: string;
        bucket: string;
      },
    );
    const response = await s3.list({ prefix: `${bucket}/`, maxKeys: 1 });
    return (response.contents?.length ?? 0) === 0;
  }

  async getDownloadResponse(
    projectRef: string,
    bucket: string,
    key: string,
  ): Promise<Response | null> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return null;

    try {
      const s3 = this.getClient(
        creds as {
          accessKey: string;
          secretKey: string;
          endpoint: string;
          bucket: string;
        },
      );
      const cleanFileName = normalizeObjectKey(key);
      const file = s3.file(`${bucket}/${cleanFileName}`);
      if (!(await file.exists())) return null;

      // Eagerly read content to avoid S3File stream consumption issues
      // when the response body gets re-wrapped in route handlers
      const content = await file.arrayBuffer();
      const contentType = file.type || "application/octet-stream";
      return new Response(content, {
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(content.byteLength),
        },
      });
    } catch {
      return null;
    }
  }
}

let activeDriver: StorageDriver | null = null;
export function getStorageDriver(): StorageDriver {
  if (!activeDriver) {
    activeDriver =
      config.storageType === "juicefs" || config.storageType === "local"
        ? new JuiceFSDriver()
        : new S3Driver();
  }
  return activeDriver;
}
