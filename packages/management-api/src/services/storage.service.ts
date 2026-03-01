import { $ } from "bun";
import { StorageManager } from "../infra/storage";

export interface StorageStatus {
  status: 'mounted' | 'unmounted';
  size?: string;
  used?: string;
  avail?: string;
  use_percent?: string;
}

export class StorageService {
  private static getManager(): StorageManager {
    // 实际配置应从环境变量或 config 对象中读取
    return new StorageManager({
      type: (process.env.STORAGE_TYPE as any) || "local",
      mountPoint: process.env.STORAGE_MOUNT_POINT || "/mnt/supacloud",
      metaUrl: process.env.JUICEFS_META_URL,
      bucketName: process.env.S3_BUCKET_NAME,
      endpoint: process.env.S3_ENDPOINT,
      accessKey: process.env.S3_ACCESS_KEY,
      secretKey: process.env.S3_SECRET_KEY,
    });
  }

  /**
   * 创建存储桶 (S3 后端)
   */
  static async createBucket(ref: string): Promise<{ success: boolean; accessKey?: string; secretKey?: string; error?: string }> {
    const { shellService } = await import("./shell.service");
    const result = await shellService.execute("s3_manager.sh", ["create", ref]);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // 解析输出中的 ACCESS_KEY 和 SECRET_KEY
    const accessKey = result.output.match(/ACCESS_KEY=([^\n]+)/)?.[1];
    const secretKey = result.output.match(/SECRET_KEY=([^\n]+)/)?.[1];

    return { success: true, accessKey, secretKey };
  }

  /**
   * 删除存储桶
   */
  static async deleteBucket(ref: string): Promise<{ success: boolean; error?: string }> {
    const { shellService } = await import("./shell.service");
    const result = await shellService.execute("s3_manager.sh", ["delete", ref]);
    return { success: result.success, error: result.error };
  }

  /**
   * 获取存储凭据
   */
  static async getCredentials(ref: string): Promise<{ success: boolean; accessKey?: string; secretKey?: string; error?: string }> {
    const { shellService } = await import("./shell.service");
    const result = await shellService.execute("s3_manager.sh", ["credentials", ref]);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    const accessKey = result.output.match(/ACCESS_KEY=([^\n]+)/)?.[1];
    const secretKey = result.output.match(/SECRET_KEY=([^\n]+)/)?.[1];

    return { success: true, accessKey, secretKey };
  }

  /**
   * 获取存储状态
   */
  static async getStatus(): Promise<StorageStatus> {
    const manager = this.getManager();
    const status = await manager.getStatus();

    if (!status.mounted) return { status: 'unmounted' };

    // 解析 df 输出以提取详情
    // 示例: juicefs:supacloud  100G  1.2G   99G   2% /mnt/supacloud
    const parts = status.details.split(/\s+/);
    if (parts.length >= 5) {
      return {
        status: 'mounted',
        size: parts[1],
        used: parts[2],
        avail: parts[3],
        use_percent: parts[4]
      };
    }

    return { status: 'mounted' };
  }

  /**
   * 启动迁移任务 (使用 juicefs sync)
   */
  static async startMigration(s3Url: string, credentials: { access_key: string, secret_key: string, endpoint: string }): Promise<{ message: string }> {
    const manager = this.getManager();

    // 异步执行迁移，不阻塞请求
    (async () => {
      try {
        const mountPoint = process.env.STORAGE_MOUNT_POINT || "/mnt/supacloud";
        // 假设迁移是指将挂载点内容同步到新的 S3 目标，或者反之
        // 这里以同步到外部 S3 为例
        await manager.sync(mountPoint, s3Url);
        console.log(`[Storage] 迁移任务完成: ${s3Url}`);
      } catch (error) {
        console.error(`[Storage] 迁移任务失败:`, error);
      }
    })();

    return { message: '存储同步后台任务已启动，请在后台日志中关注进度' };
  }
}

export const storageService = StorageService;
