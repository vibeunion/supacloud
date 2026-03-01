import * as p from "@clack/prompts";
import { StorageManager, type StorageConfig } from "./infra/storage";

export async function runStorageManager() {
    p.intro("\x1b[46m SupaCloud 云原生存储配置 (Storage) \x1b[0m");

    const storageType = await p.select({
        message: "请选择存储后端类型:",
        options: [
            { value: "local" as const, label: "本地磁盘 (默认 /var/lib/supacloud)", hint: "推荐开发环境" },
            { value: "juicefs" as const, label: "JuiceFS (S3 + PostgreSQL)", hint: "推荐生产环境，具备高可用与弹性" },
        ],
    });

    if (p.isCancel(storageType)) {
        p.cancel("操作已取消");
        return;
    }

    if (storageType === "local") {
        p.log.info("已选择本地存储。系统将继续使用本地文件系统。");
        p.outro("配置完成");
        return;
    }

    // JuiceFS 配置流
    const config = await p.group(
        {
            metaUrl: () => p.text({
                message: "JuiceFS 元数据 URL (PostgreSQL)",
                placeholder: "postgres://user:pass@localhost:5432/juicefs",
                validate: (v) => v && v.startsWith("postgres://") ? undefined : "必须是标准的 PostgreSQL 连接字符串",
            }),
            bucketName: () => p.text({
                message: "S3 Bucket 名称",
                placeholder: "supacloud-storage",
            }),
            endpoint: () => p.text({
                message: "S3 Endpoint (如空则使用 AWS)",
                placeholder: "https://s3.amazonaws.com",
            }),
            accessKey: () => p.text({
                message: "S3 Access Key",
            }),
            secretKey: () => p.password({
                message: "S3 Secret Key",
            }),
            mountPoint: () => p.text({
                message: "挂载点路径",
                initialValue: "/mnt/supacloud",
            }),
        },
        {
            onCancel: () => {
                p.cancel("已取消");
                process.exit(0);
            },
        }
    );

    const s = p.spinner();
    s.start("正在配置并挂载存储后端...");

    try {
        const manager = new StorageManager({
            type: "juicefs",
            ...config
        });

        await manager.setup();
        await manager.saveConfig();
        await manager.enablePersistence();

        s.stop("存储挂载成功");

        p.log.success(`JuiceFS 已成功挂载到 ${config.mountPoint} 且配置已持久化`);
        p.note(`
      管理 API 现已自动识别该路径。
      您可以运行 'supacloud doctor' 查看详细状态。
    `, "存储就绪");

        p.outro("云原生存储配置完成！");
    } catch (error: any) {
        s.stop("配置失败");
        p.log.error(`JuiceFS 设置过程中出错: ${error.message}`);
        process.exit(1);
    }
}
