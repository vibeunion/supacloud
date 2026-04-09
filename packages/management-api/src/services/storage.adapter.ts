import { config } from "../config";
import { logger } from "../utils/logger";
import { shellService } from "./shell.service";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { S3Client } from "bun";

export interface StorageDriver {
  createBucket(projectRef: string, bucket: string): Promise<boolean>;
  deleteBucket(projectRef: string, bucket: string): Promise<boolean>;
  emptyBucket(projectRef: string, bucket: string): Promise<boolean>;
  listBuckets(projectRef: string): Promise<{id: string, name: string, public: boolean, size: string}[]>;
  uploadFile(projectRef: string, bucket: string, key: string, data: Blob | Buffer | Uint8Array | ArrayBuffer, contentType: string): Promise<boolean>;
  deleteFile(projectRef: string, bucket: string, key: string): Promise<boolean>;
  listFiles(projectRef: string, bucket: string): Promise<{id: string, name: string, updated?: string, size: string, type: string}[]>;
  getDownloadResponse(projectRef: string, bucket: string, key: string): Promise<Response | null>;
}

export class JuiceFSDriver implements StorageDriver {
  private getBasePath(projectRef: string, bucket?: string, key?: string): string {
    let p = path.join(config.storageMountPoint, `supa-${projectRef}`);
    if (bucket) p = path.join(p, bucket);
    if (key) p = path.join(p, key);
    return p;
  }

  async createBucket(projectRef: string, bucket: string): Promise<boolean> {
    try {
      await fs.mkdir(this.getBasePath(projectRef, bucket), { recursive: true });
      return true;
    } catch (e: unknown) {
      logger.error('JuiceFS createBucket error:', { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  async deleteBucket(projectRef: string, bucket: string): Promise<boolean> {
    try {
      await fs.rm(this.getBasePath(projectRef, bucket), { recursive: true, force: true });
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
      logger.error('JuiceFS emptyBucket error:', { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  async listBuckets(projectRef: string): Promise<{id: string, name: string, public: boolean, size: string}[]> {
    try {
      const dirPath = this.getBasePath(projectRef);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => ({
          id: e.name,
          name: e.name,
          public: false, // Defaulting to false, proper public status lives in tenant DB
          size: '-'
        }));
    } catch (e) {
      return [];
    }
  }

  async uploadFile(projectRef: string, bucket: string, key: string, data: Blob | Buffer | Uint8Array | ArrayBuffer, contentType: string): Promise<boolean> {
    try {
      const filePath = this.getBasePath(projectRef, bucket, key);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await Bun.write(filePath, data);
      return true;
    } catch (e: unknown) {
      logger.error('JuiceFS uploadFile error:', { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  async deleteFile(projectRef: string, bucket: string, key: string): Promise<boolean> {
    try {
      await fs.unlink(this.getBasePath(projectRef, bucket, key));
      return true;
    } catch (e) {
      return false;
    }
  }

  async listFiles(projectRef: string, bucket: string): Promise<{id: string, name: string, updated?: string, size: string, type: string}[]> {
    try {
      const bucketPath = this.getBasePath(projectRef, bucket);
      const { Glob } = await import("bun");
      const glob = new Glob("**/*");
      const files: {id: string, name: string, updated?: string, size: string, type: string}[] = [];
      
      for (const relPath of glob.scanSync({ cwd: bucketPath, onlyFiles: true })) {
        const fullPath = path.join(bucketPath, relPath);
        const f = Bun.file(fullPath);
        
        files.push({
          id: relPath,
          name: relPath,
          updated: new Date(f.lastModified).toISOString(),
          size: Math.round(f.size / 1024) + ' KB',
          type: relPath.includes('.') ? relPath.split('.').pop() || 'unknown' : 'unknown'
        });
      }
      return files;
    } catch (e) {
      return [];
    }
  }

  async getDownloadResponse(projectRef: string, bucket: string, key: string): Promise<Response | null> {
    const file = Bun.file(this.getBasePath(projectRef, bucket, key));
    if (!await file.exists()) return null;
    return new Response(file);
  }
}

export class S3Driver implements StorageDriver {
  private async getCreds(projectRef: string): Promise<{ accessKey?: string, secretKey?: string, endpoint: string, bucket: string } | null> {
    const { success, output } = await shellService.execute('s3_manager.sh', ['credentials', projectRef]);
    if (!success) return null;
    return {
      accessKey: output.match(/ACCESS_KEY=([^\n]+)/)?.[1]?.trim(),
      secretKey: output.match(/SECRET_KEY=([^\n]+)/)?.[1]?.trim(),
      endpoint: output.match(/ENDPOINT=([^\n]+)/)?.[1]?.trim() || config.s3Endpoint,
      bucket: output.match(/BUCKET=([^\n]+)/)?.[1]?.trim() || `supa-${projectRef}`
    };
  }

  private getClient(creds: { accessKey: string, secretKey: string, endpoint: string, bucket: string }): S3Client {
    const baseUrl = creds.endpoint.endsWith('/') ? creds.endpoint.slice(0, -1) : creds.endpoint;
    return new S3Client({
      accessKeyId: creds.accessKey,
      secretAccessKey: creds.secretKey,
      endpoint: baseUrl,
      region: 'us-east-1', // or config
      bucket: creds.bucket,
    });
  }

  async createBucket(projectRef: string, bucket: string): Promise<boolean> {
    return true; // Buckets are logical prefixes in S3 for SupaCloud
  }

  async deleteBucket(projectRef: string, bucket: string): Promise<boolean> {
    return true; // No distinct deletion for logical prefix unless we rm -rf objects
  }

  async emptyBucket(projectRef: string, bucket: string): Promise<boolean> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return false;

    try {
      const s3 = this.getClient(creds as { accessKey: string, secretKey: string, endpoint: string, bucket: string });
      const res = await s3.list({ prefix: `${bucket}/` });
      const contents = res.contents || [];

      await Promise.all(contents.map((file: Record<string, unknown>) => s3.file(String(file.key)).delete()));
      return true;
    } catch (e: unknown) {
      logger.error('S3 emptyBucket error:', { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  async listBuckets(projectRef: string): Promise<{id: string, name: string, public: boolean, size: string}[]> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return [];
    
    try {
      const s3 = this.getClient(creds as { accessKey: string, secretKey: string, endpoint: string, bucket: string });
      const res = await s3.list();
      const s3Contents = res.contents || [];
      
      const buckets = new Set<string>();
      for (const obj of s3Contents) {
        // Find top-level directories which represent buckets in our mapping
        const parts = obj.key.split('/');
        if (parts.length > 1) {
          buckets.add(parts[0]);
        }
      }
      
      return Array.from(buckets).map(b => ({
        id: b,
        name: b,
        public: false,
        size: '-'
      }));
    } catch (e) {
      return [];
    }
  }

  async uploadFile(projectRef: string, bucket: string, key: string, data: Blob | Buffer | Uint8Array | ArrayBuffer, contentType: string): Promise<boolean> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return false;
    
    try {
      const s3 = this.getClient(creds as { accessKey: string, secretKey: string, endpoint: string, bucket: string });
      const cleanFileName = key.replace(/^\/+/, '');
      const bytesWritten = await s3.file(`${bucket}/${cleanFileName}`).write(data, { type: contentType });
      return bytesWritten > 0;
    } catch (e) {
      return false;
    }
  }

  async deleteFile(projectRef: string, bucket: string, key: string): Promise<boolean> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return false;
    
    try {
      const s3 = this.getClient(creds as { accessKey: string, secretKey: string, endpoint: string, bucket: string });
      await s3.file(`${bucket}/${key}`).delete();
      return true;
    } catch (e) {
      return false;
    }
  }

  async listFiles(projectRef: string, bucket: string): Promise<any[]> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return [];
    
    try {
      const s3 = this.getClient(creds as { accessKey: string, secretKey: string, endpoint: string, bucket: string });
      const res = await s3.list();
      const s3Contents = (res.contents || []).filter((f: Record<string, unknown>) => typeof f.key === 'string' && f.key.startsWith(`${bucket}/`));
      
      return s3Contents.map((file: Record<string, unknown>) => {
        const key = file.key as string;
        const relativeKey = key.substring(bucket.length + 1);
        return {
          id: relativeKey,
          name: relativeKey,
          updated: String(file.lastModified),
          size: Math.round((Number(file.size) ?? 0) / 1024) + ' KB',
          type: key.includes('.') ? key.split('.').pop() || 'unknown' : 'unknown'
        };
      });
    } catch (e) {
      return [];
    }
  }

  async getDownloadResponse(projectRef: string, bucket: string, key: string): Promise<Response | null> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return null;
    
    const url = `${creds.endpoint.endsWith('/') ? creds.endpoint : creds.endpoint + '/'}${creds.bucket}/${bucket}/${key}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return new Response(res.body, {
        headers: {
          'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
          'Content-Length': res.headers.get('Content-Length') || ''
        }
      });
    } catch {
      return null;
    }
  }
}

let activeDriver: StorageDriver | null = null;
export function getStorageDriver(): StorageDriver {
  if (!activeDriver) {
    activeDriver = (config.storageType === 'juicefs' || config.storageType === 'local')
      ? new JuiceFSDriver()
      : new S3Driver();
  }
  return activeDriver;
}
