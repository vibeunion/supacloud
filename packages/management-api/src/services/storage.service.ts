import { config } from "../config";
import { shellService } from './shell.service';
import { logger } from "../utils/logger";
import { getStorageDriver } from "./storage.adapter";

export interface StorageStatus {
  status: 'mounted' | 'unmounted';
  size?: string;
  used?: string;
  avail?: string;
  use_percent?: string;
}

export type MigrationJob = {
  id: string;
  status: 'running' | 'completed' | 'failed';
  progress: number;
  logs: string[];
  createdAt: Date;
  updatedAt: Date;
}

export const migrationJobs = new Map<string, MigrationJob>();

export class StorageService {
  /**
   * Get storage status (JuiceFS)
   */
  static async getStatus(): Promise<StorageStatus> {
    const { success, output, error } = await shellService.execute('storage_manager.sh', ['status']);
    if (!success) {
      logger.error('Failed to get storage status:', error);
      return { status: 'unmounted' };
    }
    try {
      return JSON.parse(output || '{"status":"unmounted"}');
    } catch (e: unknown) {
      return { status: 'unmounted' };
    }
  }

  /**
   * Start migration task (JuiceFS -> S3) with async live progress tracking.
   */
  static async startMigration(s3Url: string, credentials: { access_key: string, secret_key: string, endpoint: string }): Promise<{ jobId: string }> {
    const jobId = crypto.randomUUID();
    const job: MigrationJob = {
      id: jobId,
      status: 'running',
      progress: 0,
      logs: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    migrationJobs.set(jobId, job);
    
    // Asynchronously begin the spawn operation
    (async () => {
      try {
        const options = JSON.stringify(credentials);
        const scriptPath = config.scriptsPath ? `${config.scriptsPath}/storage_manager.sh` : './scripts/lib/storage_manager.sh';

        job.logs.push(`[${new Date().toISOString()}] Starting juicefs sync to ${s3Url}...`);
        
        const proc = Bun.spawn([scriptPath, 'migrate_to_s3', s3Url, options], {
          stdout: 'pipe',
          stderr: 'pipe'
        });

        // Function to process a single pipe stream, extracting progress strings
        const processStream = async (stream: ReadableStream<Uint8Array>) => {
           const reader = stream.getReader();
           const decoder = new TextDecoder();
           while (true) {
             const { done, value } = await reader.read();
             if (done) break;
             
             const text = decoder.decode(value, { stream: true });
             const lines = text.split('\n');
             for (const line of lines) {
               if (!line.trim()) continue;
               
               // Look for "100.00%" or similar
               const match = line.match(/(\d{1,3}\.\d+)%/);
               if (match) {
                 job.progress = parseFloat(match[1]);
                 job.updatedAt = new Date();
               }

               // Buffer logs strictly
               job.logs.push(line);
               if (job.logs.length > 50) job.logs.shift(); // Keep latest 50
             }
           }
        };

        await Promise.allSettled([
           processStream(proc.stdout),
           processStream(proc.stderr)
        ]);
        
        const exitCode = await proc.exited;

        if (exitCode === 0) {
           job.progress = 100;
           job.status = 'completed';
           job.logs.push(`[${new Date().toISOString()}] Sync successfully completed.`);
        } else {
           job.status = 'failed';
           job.logs.push(`[${new Date().toISOString()}] Exited with failing bounds (code: ${exitCode}).`);
           logger.error(`Migration job ${jobId} failed with exit code ${exitCode}`);
        }
      } catch (err: unknown) {
        job.status = 'failed';
        job.logs.push(`[SYSTEM_ERROR] ${err instanceof Error ? err.message : String(err)}`);
        logger.error(`Async migration task ${jobId} threw exception.`, err as Error);
      } finally {
        job.updatedAt = new Date();
      }
    })();
    
    return { jobId };
  }

  /**
   * Tenant Initialization hooks
   */
  static async createBucket(projectRef: string, bucketName: string = ""): Promise<{ success: boolean; error?: string }> {
    const success = await getStorageDriver().createBucket(projectRef, bucketName);
    return { success };
  }

  static async deleteBucket(projectRef: string, bucketName: string = ""): Promise<{ success: boolean; error?: string }> {
    const success = await getStorageDriver().deleteBucket(projectRef, bucketName);
    return { success };
  }

  static async emptyBucket(projectRef: string, bucketName: string): Promise<{ success: boolean; error?: string }> {
    const success = await getStorageDriver().emptyBucket(projectRef, bucketName);
    return { success };
  }

  /**
   * Return the logical root bucket for this project setup
   */
  static async listBuckets(projectRef: string): Promise<Record<string, unknown>[]> {
    return await getStorageDriver().listBuckets(projectRef);
  }

  static async listFiles(projectRef: string, bucketName: string): Promise<Record<string, unknown>[]> {
    return await getStorageDriver().listFiles(projectRef, bucketName);
  }

  static async isBucketEmpty(projectRef: string, bucketName: string): Promise<boolean> {
    return await getStorageDriver().isBucketEmpty(projectRef, bucketName);
  }

  static async updateBucket(projectRef: string, bucketId: string, updates: { public?: boolean; file_size_limit?: number; allowed_mime_types?: string[] }): Promise<{ success: boolean; error?: string; bucket?: Record<string, unknown> }> {
    if (!/^[a-zA-Z0-9._-]+$/.test(bucketId)) {
      return { success: false, error: "Invalid bucket id" };
    }

    try {
      const { getProjectDb, resolveDbName } = await import("../db");
      const dbName = await resolveDbName(projectRef);
      const db = getProjectDb(dbName);

      if (updates.public !== undefined) {
        await db`UPDATE storage.buckets SET public = ${updates.public} WHERE id = ${bucketId}`;
      }
      if (updates.file_size_limit !== undefined) {
        await db`UPDATE storage.buckets SET file_size_limit = ${updates.file_size_limit} WHERE id = ${bucketId}`;
      }
      if (updates.allowed_mime_types !== undefined) {
        await db`UPDATE storage.buckets SET allowed_mime_types = ${JSON.stringify(updates.allowed_mime_types)} WHERE id = ${bucketId}`;
      }

      const [bucket] = await db`SELECT * FROM storage.buckets WHERE id = ${bucketId}`;
      if (!bucket) {
        return { success: false, error: "Bucket not found" };
      }

      return { success: true, bucket: bucket as Record<string, unknown> };
    } catch (error: unknown) {
      logger.error("Failed to update bucket", {
        projectRef,
        bucketId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: "Failed to update bucket" };
    }
  }

  static async uploadFile(projectRef: string, bucketName: string, fileName: string, fileData: Blob | Buffer | Uint8Array | ArrayBuffer | ReadableStream, contentType: string): Promise<boolean> {
    return await getStorageDriver().uploadFile(projectRef, bucketName, fileName, fileData, contentType);
  }

  static async copyFile(projectRef: string, srcBucket: string, srcKey: string, destBucket: string, destKey: string): Promise<boolean> {
    return await getStorageDriver().copyFile(projectRef, srcBucket, srcKey, destBucket, destKey);
  }

  static async deleteFile(projectRef: string, bucketName: string, fileName: string): Promise<boolean> {
    return await getStorageDriver().deleteFile(projectRef, bucketName, fileName);
  }

  static async getDownloadResponse(projectRef: string, bucketName: string, fileName: string): Promise<Response | null> {
    return await getStorageDriver().getDownloadResponse(projectRef, bucketName, fileName);
  }
}

export const storageService = StorageService;
