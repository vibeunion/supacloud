import { config } from "../config";
import { shellService } from './shell.service';
import { logger } from "../utils/logger";
import { getStorageDriver } from "./storage.adapter";
import {
  storageBucketInputError,
  storageBucketRevisionError,
  type StorageBucketSettings,
} from "./storage-bucket-contract";
import {
  deleteEmptyBucketAtRevision as deleteEmptyBucketMetadataAtRevision,
  updateBucketAtRevision,
  type BucketDeleteResult,
  type BucketUpdateResult,
} from "./storage-bucket-mutation";
import { statfs } from "node:fs/promises";

export interface StorageStatus {
  status: 'mounted' | 'unmounted';
  backend: string;
  mountPoint?: string;
  healthy: boolean;
  size?: string;
  used?: string;
  avail?: string;
  use_percent?: string;
  reason?: "storage_mount_unavailable" | "object_storage_http_error" | "object_storage_unreachable";
  reasonStatus?: number;
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
   * Get the status of the configured storage backend without assuming that it
   * is a JuiceFS mount. Local and JuiceFS backends have a filesystem capacity;
   * S3-compatible backends expose reachability but not a meaningful quota.
   */
  static async getStatus(): Promise<StorageStatus> {
    const backend = config.storageType.toLowerCase();
    if (backend === "local" || backend === "juicefs") return this.getFilesystemStatus(backend);

    try {
      const response = await fetch(`${config.s3Endpoint.replace(/\/+$/, "")}/minio/health/live`, {
        signal: AbortSignal.timeout(3_000),
      });
      return {
        status: response.ok ? "mounted" : "unmounted",
        backend,
        healthy: response.ok,
        ...(response.ok ? {} : { reason: "object_storage_http_error" as const, reasonStatus: response.status }),
      };
    } catch (error: unknown) {
      logger.warn("Failed to probe object storage status", {
        backend,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "unmounted",
        backend,
        healthy: false,
        reason: "object_storage_unreachable",
      };
    }
  }

  private static async getFilesystemStatus(backend: string): Promise<StorageStatus> {
    const mountPoint = config.storageMountPoint;
    try {
      const filesystem = await statfs(mountPoint);
      const total = filesystem.blocks * filesystem.bsize;
      const available = filesystem.bavail * filesystem.bsize;
      const used = Math.max(total - available, 0);
      const usePercent = total > 0 ? Math.round((used / total) * 100) : 0;

      return {
        status: "mounted",
        backend,
        mountPoint,
        healthy: true,
        size: formatBytes(total),
        used: formatBytes(used),
        avail: formatBytes(available),
        use_percent: `${usePercent}%`,
      };
    } catch (error: unknown) {
      logger.warn("Failed to read storage filesystem status", {
        backend,
        mountPoint,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "unmounted",
        backend,
        mountPoint,
        healthy: false,
        reason: "storage_mount_unavailable",
      };
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
        
        const proc = Bun.spawn([scriptPath, 'migrate_to_s3', s3Url], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe'
        });
        proc.stdin.write(options);
        proc.stdin.end();

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
    const deletion = await getStorageDriver().deleteBucket(projectRef, bucketName);
    if (deletion.success) return deletion;
    return {
      success: false,
      error: deletion.reason === "not_empty"
        ? "Bucket is not empty"
        : "Bucket deletion outcome is unknown",
    };
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

  static async updateBucket(
    projectRef: string,
    bucketId: string,
    updates: StorageBucketSettings,
    expectedRevision: string,
  ): Promise<BucketUpdateResult | { success: false; error: string }> {
    const inputError = storageBucketInputError(projectRef, bucketId, updates);
    if (inputError) return { success: false, error: inputError };
    const revisionError = storageBucketRevisionError(expectedRevision);
    if (revisionError) return { success: false, error: revisionError };
    if (Object.values(updates).every((setting) => setting === undefined)) {
      return { success: false, error: "Invalid empty bucket update" };
    }

    try {
      const { getProjectDb, resolveDbName } = await import("../db");
      const dbName = await resolveDbName(projectRef);
      const db = getProjectDb(dbName);
      return await updateBucketAtRevision(db, { bucketId, expectedRevision, updates });
    } catch (error: unknown) {
      logger.error("Failed to update bucket", {
        projectRef,
        bucketId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: "Failed to update bucket" };
    }
  }

  static async deleteEmptyBucketAtRevision(
    projectRef: string,
    bucketId: string,
    expectedRevision: string,
  ): Promise<BucketDeleteResult | { success: false; error: string }> {
    const inputError = storageBucketInputError(projectRef, bucketId, {});
    if (inputError) return { success: false, error: inputError };
    const revisionError = storageBucketRevisionError(expectedRevision);
    if (revisionError) return { success: false, error: revisionError };

    try {
      const { getProjectDb, resolveDbName } = await import("../db");
      const database = getProjectDb(await resolveDbName(projectRef));
      return await deleteEmptyBucketMetadataAtRevision(database, {
        bucketId,
        expectedRevision,
        deletePhysicalBucket: () => this.deleteBucket(projectRef, bucketId),
      });
    } catch (error: unknown) {
      logger.error("Failed to delete bucket at revision", {
        projectRef,
        bucketId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: "Bucket deletion outcome is unknown" };
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export const storageService = StorageService;
