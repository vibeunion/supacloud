import { shellService } from './shell.service';

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
      console.error('Failed to get storage status:', error);
      return { status: 'unmounted' };
    }
    try {
      return JSON.parse(output || '{"status":"unmounted"}');
    } catch (e) {
      return { status: 'unmounted' };
    }
  }

  /**
   * Start migration task (JuiceFS -> S3)
   */
  static async startMigration(s3Url: string, credentials: { access_key: string, secret_key: string, endpoint: string }): Promise<{ message: string }> {
    const options = JSON.stringify(credentials);
    shellService.execute('storage_manager.sh', ['migrate_to_s3', s3Url, options]).catch(err => {
      console.error('Async migration task failed:', err);
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
   * Legacy compatibility: Get S3 credentials
   */
  static async getCredentials(projectRef: string): Promise<{ success: boolean; accessKey?: string; secretKey?: string; error?: string }> {
    const { success, output, error } = await shellService.execute('s3_manager.sh', ['credentials', projectRef]);
    if (!success) return { success: false, error };

    const accessKey = output.match(/ACCESS_KEY=([^\n]+)/)?.[1];
    const secretKey = output.match(/SECRET_KEY=([^\n]+)/)?.[1];
    return { success: true, accessKey, secretKey };
  }
}

export const storageService = StorageService;
