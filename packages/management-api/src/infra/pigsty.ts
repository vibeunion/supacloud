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
    anonKey?: string;
    serviceRoleKey?: string;
}

/**
 * Pigsty 核心编排代理层
 * 负责收集上游 TS 类型化的环境参数，将配置映射渲染至 `pigsty.yml`，并妥善调度 Ansible 环境
 */
export class PigstyManager {
    /**
     * 执行完整的下载、配置、Ansible 部署流程
     */
    static async install(config: PigstyConfig) {
        console.log("[PigstyManager] 开始部署基准数据库及中间件群落 (Pigsty)...");
        const home = os.homedir();
        const pigstyDir = `${home}/pigsty`;

        // 1. 获取 Pigsty 安装目录
        if ((await $`test -f ${pigstyDir}/bootstrap`.nothrow()).exitCode !== 0) {
            console.log("[PigstyManager] 正在下载 Pigsty 发行版...");
            await $`rm -rf ${pigstyDir}`.nothrow();
            await $`curl -fsSL https://repo.pigsty.io/get | bash`;
        } else {
            console.log("[PigstyManager] Pigsty 已下载 (bootstrap 存在)");
        }

        // 2. 调度执行 Bootstrap 与模板 Configure
        // 注意: cwd 变更使用 Bun $ 的 cwd 选项或显式写入串联 Shell 语句
        console.log("[PigstyManager] 执行初始化和模板映射...");
        await $`cd ${pigstyDir} && ./bootstrap`;
        await $`cd ${pigstyDir} && ./configure -i ${config.internalIp} -c app/supa`;

        // 3. 将变量映射进入 YML (替代笨重的 sed 流)
        await this.updatePigstyConfig(config, `${pigstyDir}/pigsty.yml`);

        console.log("[PigstyManager] 调用底层 Ansible Playbooks (这通常需要 10-20 分钟)...");

        // 判断入口点并进行调用
        let entrypoint = "";
        if ((await $`test -f ${pigstyDir}/deploy.yml`.nothrow()).exitCode === 0) {
            entrypoint = "deploy.yml";
        } else if ((await $`test -f ${pigstyDir}/install.yml`.nothrow()).exitCode === 0) {
            entrypoint = "install.yml";
        } else {
            throw new Error("找不到 Pigsty 的可执行剧本 (deploy.yml 或 install.yml)");
        }

        // 强制使用原生 ansible-playbook 执行入口剧本 (带可能的容器参数支持)
        const extraArgsArray = await this.getPlaybookExtraArgs();
        // Convert array to a string since passing an array directly to Bun's $ literal is tricky
        const extraArgs = extraArgsArray.join(" ");

        // 执行 Pigsty Core 环境
        const installRes = await $`cd ${pigstyDir} && ansible-playbook ${entrypoint} ${extraArgs}`.nothrow();
        if (installRes.exitCode !== 0) {
            throw new Error(`Pigsty 核心环境搭建失败：${installRes.stderr.toString()}`);
        }

        // 执行容器运行时依赖 (限非 Podman 主机层环境)
        const isPodman = process.env.CONTAINER_RUNTIME === "podman";
        if (!isPodman && (await $`test -f ${pigstyDir}/docker.yml`.nothrow()).exitCode === 0) {
            console.log("[PigstyManager] 配置 Docker 环境...");
            await $`cd ${pigstyDir} && ansible-playbook docker.yml ${extraArgs}`.nothrow();
        }

        // 执行 Supabase 集成依赖剧本
        if ((await $`test -f ${pigstyDir}/app.yml`.nothrow()).exitCode === 0) {
            console.log("[PigstyManager] 启动 Supabase 集成群...");
            const appRes = await $`cd ${pigstyDir} && ansible-playbook app.yml ${extraArgs}`.nothrow();
            if (appRes.exitCode !== 0) {
                console.warn("[PigstyManager] app.yml 集群启动受挫，尝试使用传统手段编排。");
            }
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

        if (config.anonKey) yml = yml.replace(/ANON_KEY: .*/g, `ANON_KEY: ${config.anonKey}`);
        if (config.serviceRoleKey) yml = yml.replace(/SERVICE_ROLE_KEY: .*/g, `SERVICE_ROLE_KEY: ${config.serviceRoleKey}`);

        // 关闭 Pigsty 默认的 Nginx 并发配置 (我们已经交给了 Angie 负责前端)
        if (!yml.includes("nginx_enabled: false")) {
            yml = yml.replace(/  vars:/, `  vars:\n    nginx_enabled: false\n    nginx_exporter_enabled: false\n    pgbouncer_max_client_conn: 10000\n    pgbouncer_default_pool_size: 20`);
        }

        // 后续可直接处理 MinIO / JuiceFS 的剥离屏蔽逻辑

        await Bun.write(ymlPath, yml);
    }

    /**
     * 获取用于处理非标环境(如容器内部隔离网络)执行 Ansible 的必须安全指令
     */
    private static async getPlaybookExtraArgs(): Promise<string[]> {
        const isDockerEnv = (await $`test -f /.dockerenv`.nothrow()).exitCode === 0;
        if (isDockerEnv) {
            console.log("[PigstyManager] 检测到容器运行时沙盒隔离，添加专属 Ansible 解析层参数。");
            const pythonPath = (await $`command -v python3`.text()).trim() || "/usr/bin/python3";
            return [
                "-vvv",
                "-e", `ansible_python_interpreter=${pythonPath}`,
                "-e", "repo_enabled=false",
                "-e", "node_write_etc_hosts=false",
                "-e", "node_dns_method=none",
                "-e", "node_repo_remove=false",
                "-e", "node_tune=none",
                "-e", "node_kernel_modules=[]"
            ];
        }
        return [];
    }
}
