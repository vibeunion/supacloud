import { config } from "../config";
import { logger } from "../utils/logger";
import { shellService } from "./shell.service";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { S3Client } from "bun";

export interface StorageDriver {
  createBucket(projectRef: string, bucket: string): Promise<boolean>;
  deleteBucket(projectRef: string, bucket: string): Promise<boolean>;
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
      const entries = await fs.readdir(bucketPath, { withFileTypes: true, recursive: true }).catch(() => []);
      const files: any[] = [];
      
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        
        // Native fs recursive gives us relative paths in entry.name if we manually construct it, 
        // but Node 20+ recursive readdir gives entry.path.
        // Fallback for Bun fs.readdir recursive behavior:
        const fullPath = path.join((entry as any).path || bucketPath, entry.name);
        const relPath = path.relative(bucketPath, fullPath);
        
        const stat = await fs.stat(fullPath);
        files.push({
          id: relPath,
          name: relPath,
          updated: stat.mtime.toISOString(),
          size: Math.round(stat.size / 1024) + ' KB',
          type: relPath.includes('.') ? relPath.split('.').pop() : 'unknown'
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
  private async getCreds(projectRef: string) {
    const { success, output } = await shellService.execute('s3_manager.sh', ['credentials', projectRef]);
    if (!success) return null;
    return {
      accessKey: output.match(/ACCESS_KEY=([^\n]+)/)?.[1]?.trim(),
      secretKey: output.match(/SECRET_KEY=([^\n]+)/)?.[1]?.trim(),
      endpoint: output.match(/ENDPOINT=([^\n]+)/)?.[1]?.trim() || config.s3Endpoint,
      bucket: output.match(/BUCKET=([^\n]+)/)?.[1]?.trim() || `supa-${projectRef}`
    };
  }

  private getClient(creds: Record<string, any>): S3Client {
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

  async uploadFile(projectRef: string, bucket: string, key: string, data: Blob | Buffer | Uint8Array | ArrayBuffer, contentType: string): Promise<boolean> {
    const creds = await this.getCreds(projectRef);
    if (!creds?.accessKey || !creds?.secretKey) return false;
    
    try {
      const s3 = this.getClient(creds);
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
      const s3 = this.getClient(creds);
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
      const s3 = this.getClient(creds);
      const res = await s3.list();
      const s3Contents = (res.contents || []).filter((f: any) => f.key.startsWith(`${bucket}/`));
      
      return s3Contents.map((file: any) => {
        const relativeKey = file.key.substring(bucket.length + 1);
        return {
          id: relativeKey,
          name: relativeKey,
          updated: file.lastModified,
          size: Math.round((file.size ?? 0) / 1024) + ' KB',
          type: file.key.includes('.') ? file.key.split('.').pop() : 'unknown'
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
