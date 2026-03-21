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
      const { AwsClient } = await import('aws4fetch');
      const aws = new AwsClient({
        accessKeyId: creds.accessKey,
        secretAccessKey: creds.secretKey,
        service: 's3',
        region: 'us-east-1', // Default for S3-compatible endpoints
      });

      // We normalize the endpoint (MinIO/Garage typical path-style routing: endpoint/bucket?list-type=2)
      let baseUrl = creds.endpoint.endsWith('/') ? creds.endpoint.slice(0, -1) : creds.endpoint;
      
      const url = new URL(`${baseUrl}/${creds.bucket}/?list-type=2`);
      const res = await aws.fetch(url.toString(), { method: 'GET' });
      
      if (!res.ok) {
        logger.error('S3 ListObjectsV2 failed:', await res.text());
        return [];
      }

      const xml = await res.text();
      
      // Manual quick parsing of S3 XML response using regex 
      const files: Record<string, unknown>[] = [];
      const regex = /<Contents><Key>(.*?)<\/Key><LastModified>(.*?)<\/LastModified><ETag>.*?<\/ETag><Size>(.*?)<\/Size>.*?<\/Contents>/g;
      
      let match;
      while ((match = regex.exec(xml)) !== null) {
        files.push({
          id: match[1],
          name: match[1],
          updated: match[2],
          size: Math.round(parseInt(match[3]) / 1024) + ' KB', // Convert to KB
          type: match[1].includes('.') ? match[1].split('.').pop() : 'unknown'
        });
      }
      return files;
    } catch (err: unknown) {
      logger.error('Exception during S3 listing:', { error: err instanceof Error ? err.message : String(err) });
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
      const { AwsClient } = await import('aws4fetch');
      const aws = new AwsClient({
        accessKeyId: creds.accessKey,
        secretAccessKey: creds.secretKey,
        service: 's3',
        region: 'us-east-1',
      });

      let baseUrl = creds.endpoint.endsWith('/') ? creds.endpoint.slice(0, -1) : creds.endpoint;
      
      // Clean up filename (e.g. remove leading slashes)
      const cleanFileName = fileName.replace(/^\/+/, '');
      const url = new URL(`${baseUrl}/${creds.bucket}/${cleanFileName}`);
      const res = await aws.fetch(url.toString(), { 
        method: 'PUT',
        body: fileData instanceof Blob ? fileData : fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : Uint8Array.from(fileData as Uint8Array),
        headers: {
          'Content-Type': contentType
        }
      });
      
      if (!res.ok) {
        logger.error('S3 Upload failed:', await res.text());
        return false;
      }
      return true;
    } catch (err: unknown) {
      logger.error('Exception during S3 upload:', { error: err instanceof Error ? err.message : String(err) });
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
      const { AwsClient } = await import('aws4fetch');
      const aws = new AwsClient({
        accessKeyId: creds.accessKey,
        secretAccessKey: creds.secretKey,
        service: 's3',
        region: 'us-east-1',
      });

      let baseUrl = creds.endpoint.endsWith('/') ? creds.endpoint.slice(0, -1) : creds.endpoint;
      const cleanFileName = fileName.replace(/^\/+/, '');
      const url = new URL(`${baseUrl}/${creds.bucket}/${cleanFileName}`);
      
      const res = await aws.fetch(url.toString(), { method: 'DELETE' });
      
      if (!res.ok) {
        logger.error('S3 Delete failed:', await res.text());
        return false;
      }
      return true;
    } catch (err: unknown) {
      logger.error('Exception during S3 delete:', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
}

export const storageService = StorageService;
