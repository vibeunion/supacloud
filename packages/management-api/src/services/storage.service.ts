import { shellService } from "./shell.service";

export class StorageService {
  // 创建项目 S3 Bucket
  async createBucket(projectRef: string): Promise<{ success: boolean; accessKey?: string; secretKey?: string; error?: string }> {
    const result = await shellService.execute("s3_manager.sh", ["create", projectRef]);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // 解析输出获取凭据
    const lines = result.output.split("\n");
    let accessKey: string | undefined;
    let secretKey: string | undefined;

    for (const line of lines) {
      if (line.startsWith("ACCESS_KEY=")) {
        accessKey = line.split("=")[1];
      } else if (line.startsWith("SECRET_KEY=")) {
        secretKey = line.split("=")[1];
      }
    }

    return { success: true, accessKey, secretKey };
  }

  // 删除项目 Bucket
  async deleteBucket(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.execute("s3_manager.sh", ["delete", projectRef]);
    return result;
  }

  // 获取 Bucket 凭据
  async getCredentials(projectRef: string): Promise<{ success: boolean; accessKey?: string; secretKey?: string; error?: string }> {
    const result = await shellService.execute("s3_manager.sh", ["credentials", projectRef]);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    const lines = result.output.split("\n");
    let accessKey: string | undefined;
    let secretKey: string | undefined;

    for (const line of lines) {
      if (line.startsWith("ACCESS_KEY=")) {
        accessKey = line.split("=")[1];
      } else if (line.startsWith("SECRET_KEY=")) {
        secretKey = line.split("=")[1];
      }
    }

    return { success: true, accessKey, secretKey };
  }
}

export const storageService = new StorageService();
