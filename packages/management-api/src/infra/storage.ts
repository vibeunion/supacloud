import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";

export interface StorageConfig {
    type: "local" | "juicefs" | "s3";
    mountPoint: string;
    // JuiceFS / S3 specific configs
    bucketName?: string;
    endpoint?: string;
    accessKey?: string;
    secretKey?: string;
    metaUrl?: string; // e.g. "postgres://localhost/juicefs"
}

export class StorageManager {
    private config: StorageConfig;

    constructor(config: StorageConfig) {
        this.config = config;
    }

    /**
     * 确保存储环境就绪
     */
    async setup(): Promise<void> {
        if (!existsSync(this.config.mountPoint)) {
            mkdirSync(this.config.mountPoint, { recursive: true });
        }

        switch (this.config.type) {
            case "juicefs":
                await this.setupJuiceFS();
                break;
            case "s3":
                // S3 behavior might be different, 
                // usually handled via environment variables for Supabase Storage
                break;
            default:
                console.log(`[Storage] 使用本地存储: ${this.config.mountPoint}`);
        }
    }

    /**
     * JuiceFS 格式化与挂载逻辑
     */
    private async setupJuiceFS(): Promise<void> {
        if (!this.config.metaUrl || !this.config.bucketName) {
            throw new Error("JuiceFS 需要 metaUrl 和 bucketName");
        }

        try {
            // 1. 尝试格式化 (如果已存在则报错，我们捕获并继续)
            console.log(`[Storage] 正在格式化 JuiceFS: ${this.config.bucketName}`);
            await $`juicefs format --storage s3 \
        --bucket ${this.config.endpoint}/${this.config.bucketName} \
        --access-key ${this.config.accessKey} \
        --secret-key ${this.config.secretKey} \
        ${this.config.metaUrl} ${this.config.bucketName}`.quiet().nothrow();

            // 2. 检查是否已挂载
            const isMounted = (await $`mount | grep ${this.config.mountPoint}`.quiet().nothrow()).exitCode === 0;

            if (!isMounted) {
                console.log(`[Storage] 正在挂载 JuiceFS 到 ${this.config.mountPoint}`);
                // 3. 执行挂载
                await $`juicefs mount -d ${this.config.metaUrl} ${this.config.mountPoint} \
          --background`.quiet();
            } else {
                console.log(`[Storage] JuiceFS 已挂载于 ${this.config.mountPoint}`);
            }
        } catch (error) {
            console.error("[Storage] JuiceFS 设置失败:", error);
            throw error;
        }
    }

    /**
     * 获取挂载状态报告
     */
    async getStatus(): Promise<{ mounted: boolean; type: string; details: string }> {
        const isMounted = (await $`mount | grep ${this.config.mountPoint}`.quiet().nothrow()).exitCode === 0;
        let details = "";

        if (isMounted) {
            details = (await $`df -h ${this.config.mountPoint} | tail -n 1`.quiet().text()).trim();
        }

        return {
            mounted: isMounted || this.config.type === "local",
            type: this.config.type,
            details
        };
    }

    /**
     * 同步/迁移数据 (使用 juicefs sync)
     */
    async sync(src: string, dest: string, parallel: number = 10): Promise<void> {
        console.log(`[Storage] 正在同步数据从 ${src} 到 ${dest}...`);
        // juicefs sync [flags] SRC DST
        await $`juicefs sync --parallel ${parallel} ${src} ${dest}`.quiet();
    }

    /**
     * 启用开机自动挂载 (Systemd)
     */
    async enablePersistence(): Promise<void> {
        if (this.config.type !== "juicefs") return;

        const unitName = `mnt-supacloud.mount`; // 假设挂载点是 /mnt/supacloud
        const serviceContent = `
[Unit]
Description=JuiceFS Mount for SupaCloud
After=network.target postgresql.service

[Mount]
What=${this.config.metaUrl}
Where=${this.config.mountPoint}
Type=juicefs
Options=_netdev,allow_other,cache-size=1024

[Install]
WantedBy=multi-user.target
    `.trim();

        const tempFile = `/tmp/${unitName}`;
        await Bun.write(tempFile, serviceContent);

        console.log(`[Storage] 正在配置 Systemd 持久化挂载...`);
        await $`sudo cp ${tempFile} /etc/systemd/system/${unitName}`;
        await $`sudo systemctl daemon-reload`;
        await $`sudo systemctl enable ${unitName}`;
    }

    /**
     * 将当前配置保存到系统环境变量文件
     */
    async saveConfig(): Promise<void> {
        const configPath = "/etc/supabase/management-api.env";
        let content = "";

        if (existsSync(configPath)) {
            content = await Bun.file(configPath).text();
        }

        const newVars: Record<string, string> = {
            STORAGE_TYPE: this.config.type,
            STORAGE_MOUNT_POINT: this.config.mountPoint,
            JUICEFS_META_URL: this.config.metaUrl || "",
            S3_BUCKET_NAME: this.config.bucketName || "",
            S3_ENDPOINT: this.config.endpoint || "",
            S3_ACCESS_KEY: this.config.accessKey || "",
            S3_SECRET_KEY: this.config.secretKey || "",
        };

        let updatedContent = content;
        for (const [key, value] of Object.entries(newVars)) {
            const regex = new RegExp(`^${key}=.*$`, "m");
            if (regex.test(updatedContent)) {
                updatedContent = updatedContent.replace(regex, `${key}=${value}`);
            } else {
                updatedContent += `\n${key}=${value}`;
            }
        }

        console.log(`[Storage] 正在持久化存储配置到 ${configPath}...`);
        // 由于通常需要 sudo 权限，这里先写临时文件再 sudo 复制
        const tempFile = `/tmp/management-api.env.tmp`;
        await Bun.write(tempFile, updatedContent.trim());
        await $`sudo cp ${tempFile} ${configPath}`;
    }
}
