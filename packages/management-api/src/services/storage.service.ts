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
   * 获取存储状态 (JuiceFS)
   */
  async getStatus(): Promise<StorageStatus> {
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
   * 启动迁移任务 (JuiceFS -> S3)
   */
  async startMigration(s3Url: string, credentials: { access_key: string, secret_key: string, endpoint: string }): Promise<{ message: string }> {
    const options = JSON.stringify(credentials);
    shellService.execute('storage_manager.sh', ['migrate_to_s3', s3Url, options]).catch(err => {
      console.error('Async migration task failed:', err);
    });
    return { message: '存储迁移后台任务已启动，请在后台日志中关注 juicefs sync 进度' };
  }

  /**
   * 兼容旧版：创建 S3 Bucket (Garage/MinIO/RustFS)
   */
  async createBucket(projectRef: string): Promise<{ success: boolean; accessKey?: string; secretKey?: string; error?: string }> {
    const { success, output, error } = await shellService.execute('s3_manager.sh', ['create', projectRef]);
    if (!success) return { success: false, error };

    const accessKey = output.match(/ACCESS_KEY=([^\n]+)/)?.[1];
    const secretKey = output.match(/SECRET_KEY=([^\n]+)/)?.[1];
    return { success: true, accessKey, secretKey };
  }

  /**
   * 兼容旧版：删除 S3 Bucket
   */
  async deleteBucket(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const { success, error } = await shellService.execute('s3_manager.sh', ['delete', projectRef]);
    return { success, error };
  }

  /**
   * 兼容旧版：获取 S3 凭据
   */
  async getCredentials(projectRef: string): Promise<{ success: boolean; accessKey?: string; secretKey?: string; error?: string }> {
    const { success, output, error } = await shellService.execute('s3_manager.sh', ['credentials', projectRef]);
    if (!success) return { success: false, error };

    const accessKey = output.match(/ACCESS_KEY=([^\n]+)/)?.[1];
    const secretKey = output.match(/SECRET_KEY=([^\n]+)/)?.[1];
    return { success: true, accessKey, secretKey };
  }
}

export const storageService = new StorageService();
