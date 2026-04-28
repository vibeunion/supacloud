import { config } from "../config";
import { logger } from "../utils/logger";
import { normalizeCiS3Endpoint } from "../utils/sdk-parity";
import { shellService } from "./shell.service";
import { resolveBucketName } from "../db";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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

export interface StorageDriver {
  createBucket(projectRef: string, bucket: string): Promise<boolean>;
  deleteBucket(projectRef: string, bucket: string): Promise<boolean>;
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
  getDownloadResponse(
    projectRef: string,
    bucket: string,
    key: string,
  ): Promise<Response | null>;
}

export class JuiceFSDriver implements StorageDriver {
  private getBasePath(
    projectRef: string,
    bucket?: string,
    key?: string,
  ): string {
    const root = path.resolve(
      config.storageMountPoint,
      resolveBucketName(projectRef),
    );
    let p = root;
    if (bucket) p = path.join(p, bucket);
    if (key) p = path.join(p, normalizeObjectKey(key));
    // Resolve to absolute path and ensure it stays within the project root (prevent .. traversal)
    const resolved = path.resolve(p);
    if (!resolved.startsWith(root)) {
      throw new Error(`Path traversal blocked: ${resolved} escapes ${root}`);
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

  async deleteBucket(projectRef: string, bucket: string): Promise<boolean> {
    try {
      await fs.rm(this.getBasePath(projectRef, bucket), {
        recursive: true,
        force: true,
      });
      return true;
    } catch (e) {
      return false;
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
      const filePath = this.getBasePath(projectRef, bucket, key);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await Bun.write(filePath, await toUint8Array(data));
      return true;
    } catch (e: unknown) {
      logger.error("JuiceFS uploadFile error:", {
        error: e instanceof Error ? e.message : String(e),
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
    try {
      const srcPath = this.getBasePath(projectRef, srcBucket, srcKey);
      const destPath = this.getBasePath(projectRef, destBucket, destKey);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
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

  async getDownloadResponse(
    projectRef: string,
    bucket: string,
    key: string,
  ): Promise<Response | null> {
    const file = Bun.file(this.getBasePath(projectRef, bucket, key));
    if (!(await file.exists())) return null;
    return new Response(file);
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
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return new Uint8Array(await new Response(data as ReadableStream).arrayBuffer());
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

  async deleteBucket(projectRef: string, bucket: string): Promise<boolean> {
    return true; // No distinct deletion for logical prefix unless we rm -rf objects
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
