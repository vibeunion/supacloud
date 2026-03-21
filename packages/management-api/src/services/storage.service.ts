import { shellService } from './shell.service';
import { logger } from "../utils/logger";

export interface StorageStatus {
  status: 'mounted' | 'unmounted';
  size?: string;
  used?: string;
  avail?: string;
  use_percent?: string;
}

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
   * Start migration task (JuiceFS -> S3)
   */
  static async startMigration(s3Url: string, credentials: { access_key: string, secret_key: string, endpoint: string }): Promise<{ message: string }> {
    const options = JSON.stringify(credentials);
    shellService.execute('storage_manager.sh', ['migrate_to_s3', s3Url, options]).catch(err => {
      logger.error('Async migration task failed:', { error: err instanceof Error ? err.message : String(err) });
    });
    return { message: 'Storage migration background task started, please monitor juicefs sync progress in background logs' };
  }

  /**
   * Legacy compatibility: Create S3 Bucket (Garage/MinIO/RustFS)
   */
  static async createBucket(projectRef: string): Promise<{ success: boolean; accessKey?: string; secretKey?: string; error?: string }> {
    const { success, output, error } = await shellService.execute('s3_manager.sh', ['create', projectRef]);
    if (!success) return { success: false, error };

    const accessKey = output.match(/ACCESS_KEY=([^\n]+)/)?.[1];
    const secretKey = output.match(/SECRET_KEY=([^\n]+)/)?.[1];
    return { success: true, accessKey, secretKey };
  }

  /**
   * Legacy compatibility: Delete S3 Bucket
   */
  static async deleteBucket(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const { success, error } = await shellService.execute('s3_manager.sh', ['delete', projectRef]);
    return { success, error };
  }

  /**
   * Get S3 credentials
   */
  static async getCredentials(projectRef: string): Promise<{ success: boolean; accessKey?: string; secretKey?: string; endpoint?: string; bucket?: string; error?: string }> {
    const { success, output, error } = await shellService.execute('s3_manager.sh', ['credentials', projectRef]);
    if (!success) return { success: false, error };

    const accessKey = output.match(/ACCESS_KEY=([^\n]+)/)?.[1]?.trim();
    const secretKey = output.match(/SECRET_KEY=([^\n]+)/)?.[1]?.trim();
    const endpoint = output.match(/ENDPOINT=([^\n]+)/)?.[1]?.trim() || process.env.S3_ENDPOINT || 'http://localhost:9000';
    const bucket = output.match(/BUCKET=([^\n]+)/)?.[1]?.trim() || `supa-${projectRef}`;
    return { success: true, accessKey, secretKey, endpoint, bucket };
  }

  /**
   * List Buckets (Real API)
   * In SupaCloud's S3 model, each project gets one real S3 bucket 'supa-<ref>'
   */
  static async listBuckets(projectRef: string): Promise<Record<string, unknown>[]> {
    const creds = await this.getCredentials(projectRef);
    if (!creds.success || !creds.bucket) {
      return [{ id: 'default', name: 'default', public: true, size: '0 B' }];
    }
    // Return the logical root bucket for this project
    return [{ id: creds.bucket, name: creds.bucket, public: false, size: '-' }];
  }

  /**
   * List Files (Direct S3 API implementation)
   */
  static async listFiles(projectRef: string, bucketName: string): Promise<Record<string, unknown>[]> {
    const creds = await this.getCredentials(projectRef);
    if (!creds.success || !creds.accessKey || !creds.secretKey || !creds.endpoint || !creds.bucket) {
      logger.error('Failed to get credentials for storage');
      return [];
    }

    try {
      const { S3Client } = await import('bun');
      let baseUrl = creds.endpoint.endsWith('/') ? creds.endpoint.slice(0, -1) : creds.endpoint;

      const s3 = new S3Client({
        accessKeyId: creds.accessKey,
        secretAccessKey: creds.secretKey,
        endpoint: baseUrl,
        region: 'us-east-1',
        bucket: creds.bucket,
      });

      const res = await s3.list();
      
      const s3Contents = res.contents || [];
      return s3Contents.map((file: { key: string; lastModified?: string; size?: number }) => ({
        id: file.key,
        name: file.key,
        updated: file.lastModified,
        size: Math.round((file.size ?? 0) / 1024) + ' KB',
        type: file.key.includes('.') ? file.key.split('.').pop() : 'unknown'
      }));
    } catch (err: unknown) {
      logger.error('Exception during native S3 listing:', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /**
   * Upload File to S3
   */
  static async uploadFile(projectRef: string, bucketName: string, fileName: string, fileData: Blob | Buffer | Uint8Array | ArrayBuffer, contentType: string): Promise<boolean> {
    const creds = await this.getCredentials(projectRef);
    if (!creds.success || !creds.accessKey || !creds.secretKey || !creds.endpoint || !creds.bucket) return false;

    try {
      const { S3Client } = await import('bun');
      let baseUrl = creds.endpoint.endsWith('/') ? creds.endpoint.slice(0, -1) : creds.endpoint;

      const s3 = new S3Client({
        accessKeyId: creds.accessKey,
        secretAccessKey: creds.secretKey,
        endpoint: baseUrl,
        region: 'us-east-1',
        bucket: creds.bucket,
      });

      const cleanFileName = fileName.replace(/^\/+/, '');
      const bytesWritten = await s3.file(cleanFileName).write(fileData, {
        type: contentType
      });
      
      return bytesWritten > 0;
    } catch (err: unknown) {
      logger.error('Exception during native S3 upload:', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /**
   * Delete File from S3
   */
  static async deleteFile(projectRef: string, bucketName: string, fileName: string): Promise<boolean> {
    const creds = await this.getCredentials(projectRef);
    if (!creds.success || !creds.accessKey || !creds.secretKey || !creds.endpoint || !creds.bucket) return false;

    try {
      const { S3Client } = await import('bun');
      let baseUrl = creds.endpoint.endsWith('/') ? creds.endpoint.slice(0, -1) : creds.endpoint;

      const s3 = new S3Client({
        accessKeyId: creds.accessKey,
        secretAccessKey: creds.secretKey,
        endpoint: baseUrl,
        region: 'us-east-1',
        bucket: creds.bucket,
      });

      const cleanFileName = fileName.replace(/^\/+/, '');
      await s3.file(cleanFileName).delete();
      
      return true;
    } catch (err: unknown) {
      logger.error('Exception during native S3 delete:', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
}

export const storageService = StorageService;
