import { $ } from "bun";
import os from "node:os";

export interface PigstyConfig {
    internalIp: string;
    publicDomain: string;
    studioDomain: string;
    dashboardPass: string;
    postgresPass: string;
    grafanaPass: string;
    jwtSecret: string;
    storageType: string;
    force?: boolean;
    anonKey?: string;
    serviceRoleKey?: string;
}

export enum PigstyStatus {
    NOT_INSTALLED = "NOT_INSTALLED",
    DOWNLOADED = "DOWNLOADED",
    CONFIGURED = "CONFIGURED",
    INSTALLED = "INSTALLED",
}

/**
 * Pigsty 核心编排代理层
 * 负责收集上游 TS 类型化的环境参数，将配置映射渲染至 `pigsty.yml`，并妥善调度 Ansible 环境
 */
export class PigstyManager {
    static async checkStatus(): Promise<PigstyStatus> {
        const home = os.homedir();
        const pigstyDir = `${home}/pigsty`;

        if ((await $`test -f ${home}/.pigsty_installed`.nothrow()).exitCode === 0) {
            return PigstyStatus.INSTALLED;
        }

        if ((await $`test -f ${pigstyDir}/pigsty.yml`.nothrow()).exitCode === 0) {
            // 检查是否已经 configure 过 (简单判断是否包含我们的 IP)
            const content = await Bun.file(`${pigstyDir}/pigsty.yml`).text();
            if (content.includes("SITE_URL") && !content.includes("10.10.10.10")) {
                return PigstyStatus.CONFIGURED;
            }
            return PigstyStatus.DOWNLOADED;
        }

        return PigstyStatus.NOT_INSTALLED;
    }

    /**
     * 执行完整的下载、配置、Ansible 部署流程
     */
    static async install(config: PigstyConfig) {
        const status = await this.checkStatus();
        if (status === PigstyStatus.INSTALLED && !config.force) {
            console.log("[PigstyManager] 检测到 Pigsty 已完成安装，跳过。使用 force: true 可强制重新安装。");
            return;
        }

        console.log(`[PigstyManager] 当前状态: ${status}, 开始部署流程...`);
        const home = os.homedir();
        const pigstyDir = `${home}/pigsty`;
        const ymlPath = `${pigstyDir}/pigsty.yml`;
        const backupPath = `${ymlPath}.pre_sc_patch`;

        // 1. 获取 Pigsty 安装目录
        if (status === PigstyStatus.NOT_INSTALLED) {
            console.log("[PigstyManager] 正在下载 Pigsty 发行版...");
            await $`rm -rf ${pigstyDir}`.nothrow();
            await $`curl -fsSL https://repo.pigsty.io/get | bash`;
        }

        // 2. 调度执行 Bootstrap 与模板 Configure
        if (status === PigstyStatus.NOT_INSTALLED || status === PigstyStatus.DOWNLOADED) {
            console.log("[PigstyManager] 执行初始化和模板映射...");
            // 确保不带 .nothrow()，如果 bootstrap 失败必须抛出异常
            await $`cd ${pigstyDir} && ./bootstrap`;

            await $`cd ${pigstyDir} && ./configure -i ${config.internalIp} -c app/supa`;
        }

        // 3. 将变量映射进入 YML (带回滚保护)
        try {
            // 创建快照
            if (await Bun.file(ymlPath).exists()) {
                await $`cp -f ${ymlPath} ${backupPath}`;
            }

            await this.updatePigstyConfig(config, ymlPath);

            console.log("[PigstyManager] 调用底层 Ansible Playbooks (这通常需要 10-20 分钟)...");

            let entrypoint = "";
            if ((await $`test -f ${pigstyDir}/deploy.yml`.nothrow()).exitCode === 0) {
                entrypoint = "deploy.yml";
            } else if ((await $`test -f ${pigstyDir}/install.yml`.nothrow()).exitCode === 0) {
                entrypoint = "install.yml";
            } else {
                throw new Error("找不到 Pigsty 的可执行剧本 (deploy.yml 或 install.yml)");
            }

            const extraArgsArray = await this.getPlaybookExtraArgs();

            // 执行 Pigsty Core 环境
            console.log(`[PigstyManager] 启动主剧本部署: ${entrypoint}...`);
            await this.runCommandWithStreaming(
                ["ansible-playbook", entrypoint, ...extraArgsArray],
                pigstyDir
            );

            const isPodman = process.env.CONTAINER_RUNTIME === "podman";
            if (!isPodman && (await $`test -f ${pigstyDir}/docker.yml`.nothrow()).exitCode === 0) {
                console.log("[PigstyManager] 配置 Docker 环境...");
                await this.runCommandWithStreaming(
                    ["ansible-playbook", "docker.yml", ...extraArgsArray],
                    pigstyDir
                );
            }

            if ((await $`test -f ${pigstyDir}/app.yml`.nothrow()).exitCode === 0) {
                console.log("[PigstyManager] 启动 Supabase 集成群...");
                await this.runCommandWithStreaming(
                    ["ansible-playbook", "app.yml", ...extraArgsArray],
                    pigstyDir
                );
            }

            // 标记安装成功
            await $`touch ${home}/.pigsty_installed`;
            // 删除备份
            await $`rm -f ${backupPath}`.nothrow();

        } catch (error) {
            console.error("[PigstyManager] 部署中途崩溃，启动回滚机制...");
            if (await Bun.file(backupPath).exists()) {
                await $`mv -f ${backupPath} ${ymlPath}`;
                console.log("[PigstyManager] 已恢复原始 pigsty.yml 配置文件。");
            }
            throw error;
        }
    }

    /**
     * 使用 Bun.spawn 实现流式输出捕获
     */
    private static async runCommandWithStreaming(args: string[], cwd: string) {
        const proc = Bun.spawn({
            cmd: args,
            cwd: cwd,
            stdout: "pipe",
            stderr: "pipe",
        });

        let hasFailed = false;
        const reader = async (stream: ReadableStream) => {
            const decoder = new TextDecoder();
            for await (const chunk of stream) {
                const text = decoder.decode(chunk as Uint8Array);
                const lines = text.split("\n").filter(line => line.trim());
                for (const line of lines) {
                    const trimmed = line.trim();
                    console.log(`  [Ansible] ${trimmed}`);
                    // 实时扫描关键错误关键字，防止退出码未对齐
                    if (trimmed.includes("FAILED!") || trimmed.includes("fatal: [")) {
                        hasFailed = true;
                    }
                }
            }
        };

        await Promise.all([reader(proc.stdout), reader(proc.stderr)]);
        const exitCode = await proc.exited;

        if (exitCode !== 0 || hasFailed) {
            const errorMsg = `Ansible 执行失败 (Exit Code: ${exitCode}, Failure Detected: ${hasFailed})`;
            console.error(`\n[CRITICAL ERROR] ${errorMsg}`);
            console.error(`[CRITICAL ERROR] 请检查上述 [Ansible] 日志以获取详细错误堆栈。\n`);
            throw new Error(errorMsg);
        }
    }

    /**
     * 细粒度修改 pigsty.yml。采用 Bun.file 整体读出并作正则式安全替换
     */
    private static async updatePigstyConfig(config: PigstyConfig, ymlPath: string) {
        console.log("[PigstyManager] 智能映射并重写目标 YML 设置...");
        let yml = await Bun.file(ymlPath).text();

        // 修正 IPs
        yml = yml.replace(/10\.10\.10\.10/g, config.internalIp);
        yml = yml.replace(/10\.6\.0\.9/g, config.internalIp);
        yml = yml.replace(/10\.2\.0\.14/g, config.internalIp);

        // [ROBUST FIX] 此处我们仅通过单纯的正则修正一些明确定义的 Supabase 域参数
        yml = yml.replace(/SITE_URL: https:\/\/supa.pigsty/g, `SITE_URL: https://${config.studioDomain}`);
        yml = yml.replace(/API_EXTERNAL_URL: https:\/\/supa.pigsty/g, `API_EXTERNAL_URL: https://${config.publicDomain}`);
        yml = yml.replace(/SUPABASE_PUBLIC_URL: https:\/\/supa.pigsty/g, `SUPABASE_PUBLIC_URL: https://${config.publicDomain}`);
        yml = yml.replace(/domain: supa.pigsty/g, `domain: ${config.publicDomain}`);

        // Certbot 多个子域名
        const certbotDomains = config.publicDomain === config.studioDomain
            ? config.publicDomain
            : `${config.publicDomain},${config.studioDomain}`;
        yml = yml.replace(/certbot: supa.pigsty/g, `certbot: ${certbotDomains}`);

        yml = yml.replace(/supa.pigsty/g, config.publicDomain); // 一般占位符替换

        // 密码和安全证书
        yml = yml.replace(/DASHBOARD_PASSWORD: pigsty/g, `DASHBOARD_PASSWORD: ${config.dashboardPass}`);
        yml = yml.replace(/POSTGRES_PASSWORD: DBUser.Supa/g, `POSTGRES_PASSWORD: ${config.postgresPass}`);
        yml = yml.replace(/password: 'DBUser.Supa'/g, `password: '${config.postgresPass}'`);
        yml = yml.replace(/grafana_admin_password: pigsty/g, `grafana_admin_password: ${config.grafanaPass}`);
        yml = yml.replace(/JWT_SECRET: your-super-secret-jwt-token-with-at-least-32-characters-long/g, `JWT_SECRET: ${config.jwtSecret}`);

        if (config.serviceRoleKey) yml = yml.replace(/SERVICE_ROLE_KEY: .*/g, `SERVICE_ROLE_KEY: ${config.serviceRoleKey}`);

        // 云原生存储集成 (JuiceFS)
        const storageType = process.env.STORAGE_TYPE || "local";
        const mountPoint = process.env.STORAGE_MOUNT_POINT || "/mnt/supacloud";

        if (storageType === "juicefs") {
            console.log(`[PigstyManager] 正在将 Supabase Storage 后端切换至 JuiceFS: ${mountPoint}`);
            yml = yml.replace(/STORAGE_BACKEND: .*/g, `STORAGE_BACKEND: local`);
            if (yml.includes("STORAGE_LOCAL_ROOTPATH")) {
                yml = yml.replace(/STORAGE_LOCAL_ROOTPATH: .*/g, `STORAGE_LOCAL_ROOTPATH: ${mountPoint}`);
            } else {
                yml = yml.replace(/  vars:/, `  vars:\n    STORAGE_LOCAL_ROOTPATH: ${mountPoint}`);
            }
        }

        // --- 多节点集群扩展 (Phase 6: HA) ---
        const { NodeManager } = await import("./node");
        const nodes = await NodeManager.listNodes();
        if (nodes.length > 0) {
            console.log(`[PigstyManager] 检测到 ${nodes.length} 个额外节点，正在注入集群定义...`);
            const pgNodes = nodes.filter(n => n.role === "pg");
            if (pgNodes.length > 0) {
                let nodeInjections = "";
                pgNodes.forEach((node, idx) => {
                    nodeInjections += `    ${node.hostname}: { node_id: ${idx + 2}, ip: ${node.ip} }\n`;
                });
                if (yml.includes("pg-test:")) {
                    yml = yml.replace(/pg-test:\s+hosts: \{([^\}]+)\}/, (match, p1) => {
                        return `pg-test:\n  hosts: {${p1.trim()}\n${nodeInjections.trimEnd()}\n  }`;
                    });
                }
            }
        }

        // --- Nginx 停用逻辑 (交由 Angie 负责) ---
        if (!yml.includes("nginx_enabled: false")) {
            // 改进注入逻辑，如果 vars: 已存在则追加，否则创建
            if (yml.includes("  vars:")) {
                yml = yml.replace(/^  vars:/m, `  vars:\n    nginx_enabled: false\n    nginx_exporter_enabled: false\n    pgbouncer_max_client_conn: 10000\n    pgbouncer_default_pool_size: 20`);
            } else {
                yml = yml.replace(/^all:/m, `all:\n  vars:\n    nginx_enabled: false\n    nginx_exporter_enabled: false\n    pgbouncer_max_client_conn: 10000\n    pgbouncer_default_pool_size: 20`);
            }
        }

        await Bun.write(ymlPath, yml);
    }

    /**
     * 获取执行 Ansible 的附加参数
     * 支持通过环境变量 SUPACLOUD_ANSIBLE_ARGS 传递额外参数（如 -e 变量覆盖），实现 CI 环境与应用代码的解耦。
     */
    private static async getPlaybookExtraArgs(): Promise<string[]> {
        const extra = process.env.SUPACLOUD_ANSIBLE_ARGS;
        if (extra) {
            console.log(`[PigstyManager] 检测到外部 Ansible 参数注入: ${extra}`);
            return extra.split(/\s+/).filter(Boolean);
        }
        return [];
    }

    // 移除了针对 Debian 12 的 stabilizeAptSources 补丁，依循最佳实践交由底层处理
}
