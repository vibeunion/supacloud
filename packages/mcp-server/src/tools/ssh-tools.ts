/**
 * SSH 工具集 – 安装/升级/诊断 (SupaCloud 安装前可用)
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SshTransport } from "../transports/ssh";

export function registerSshTools(server: McpServer, ssh: SshTransport): void {
    // ── 检测目标服务器连通性 ──
    server.tool(
        "ping_server",
        "检测目标服务器是否可通过 SSH 连接",
        {},
        async () => {
            const ok = await ssh.ping();
            return {
                content: [
                    {
                        type: "text",
                        text: ok ? "✅ 服务器可达" : "❌ 服务器不可达，请检查 SSH 配置",
                    },
                ],
            };
        }
    );

    // ── 安装 SupaCloud ──
    server.tool(
        "install_supacloud",
        "在目标服务器上一键安装 SupaCloud (Pigsty + Supabase)",
        {
            public_domain: z.string().describe("API 域名，例如 api.example.com"),
            studio_domain: z.string().optional().describe("Studio 域名，默认同 public_domain"),
            postgres_password: z.string().optional().describe("数据库密码，留空则自动生成"),
            dashboard_password: z.string().optional().describe("控制台密码"),
            edge_runtime: z.enum(["deno", "bun"]).default("deno").describe("云函数运行时"),
            storage_type: z.enum(["garage", "rustfs", "minio", "external"]).default("garage").describe("存储后端"),
        },
        async ({ public_domain, studio_domain, postgres_password, dashboard_password, edge_runtime, storage_type }) => {
            // 1. 检测基础环境
            const osCheck = await ssh.exec("cat /etc/os-release | head -5");

            // 2. 构建配置
            const envLines = [
                `SUPABASE_PUBLIC_DOMAIN=${public_domain}`,
                `SUPABASE_STUDIO_DOMAIN=${studio_domain ?? public_domain}`,
                `EDGE_RUNTIME=${edge_runtime}`,
                `S3_STORAGE_TYPE=${storage_type}`,
            ];
            if (postgres_password) envLines.push(`POSTGRES_PASSWORD=${postgres_password}`);
            if (dashboard_password) envLines.push(`DASHBOARD_PASSWORD=${dashboard_password}`);

            // 3. 下载并执行安装脚本
            const installCmd = [
                `cd /tmp`,
                `curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh -o setup.sh`,
                `cat > /tmp/supacloud-config.env << 'ENVEOF'`,
                ...envLines,
                `ENVEOF`,
                `export $(cat /tmp/supacloud-config.env | xargs)`,
                `bash setup.sh`,
            ].join("\n");

            const result = await ssh.exec(installCmd, 1800_000); // 30 分钟超时

            return {
                content: [
                    {
                        type: "text",
                        text: result.success
                            ? `✅ SupaCloud 安装成功！\n\n操作系统:\n${osCheck.stdout}\n\n安装日志(最后 500 字符):\n${result.stdout.slice(-500)}`
                            : `❌ 安装失败 (exit ${result.code})\n\nstderr:\n${result.stderr.slice(-1000)}\n\nstdout:\n${result.stdout.slice(-500)}`,
                    },
                ],
            };
        }
    );

    // ── 升级 SupaCloud ──
    server.tool(
        "upgrade_supacloud",
        "将目标服务器上的 SupaCloud 升级到最新版本",
        {
            version: z.string().optional().describe("指定版本号，留空则升级到最新"),
        },
        async ({ version }) => {
            const cmd = version
                ? `cd ~/supacloud && git fetch && git checkout ${version} && bash install.sh`
                : `cd ~/supacloud && git pull && bash install.sh`;
            const result = await ssh.exec(cmd, 600_000);
            return {
                content: [
                    {
                        type: "text",
                        text: result.success
                            ? `✅ 升级完成\n${result.stdout.slice(-300)}`
                            : `❌ 升级失败 (exit ${result.code})\n${result.stderr.slice(-500)}`,
                    },
                ],
            };
        }
    );

    // ── 系统诊断 ──
    server.tool(
        "diagnose_server",
        "诊断目标服务器状态：内存/磁盘/服务运行情况",
        {},
        async () => {
            const cmds = [
                "echo '=== OS ===' && uname -a",
                "echo '=== Memory ===' && free -h",
                "echo '=== Disk ===' && df -h /",
                "echo '=== Docker/Podman ===' && (docker ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || podman ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || echo 'Not found')",
                "echo '=== PostgreSQL ===' && (pg_isready 2>/dev/null && echo 'Running' || echo 'Not detected')",
                "echo '=== Management API ===' && (curl -sf http://localhost:9090/v1/projects > /dev/null && echo 'Running' || echo 'Not running')",
            ];
            const result = await ssh.exec(cmds.join(" && "));
            return {
                content: [{ type: "text", text: result.stdout || result.stderr }],
            };
        }
    );

    // ── 执行任意命令 ──
    server.tool(
        "ssh_exec",
        "在目标服务器上执行自定义 Shell 命令 (谨慎使用)",
        {
            command: z.string().describe("要执行的 Shell 命令"),
            timeout_seconds: z.number().default(60).describe("超时秒数"),
        },
        async ({ command, timeout_seconds }) => {
            const result = await ssh.exec(command, timeout_seconds * 1000);
            return {
                content: [
                    {
                        type: "text",
                        text: `exit: ${result.code}\n\nstdout:\n${result.stdout.slice(-2000)}\n\nstderr:\n${result.stderr.slice(-500)}`,
                    },
                ],
            };
        }
    );

    // ── 安装故障排查 ──
    server.tool(
        "troubleshoot_install",
        "自动诊断 SupaCloud 安装故障：采集容器日志、系统资源、端口冲突、DNS 等信息并输出结构化报告",
        {
            focus: z
                .enum(["all", "containers", "database", "network", "disk", "logs"])
                .default("all")
                .describe("重点排查方向"),
        },
        async ({ focus }) => {
            const checks: string[] = [];

            // 始终采集基础信息
            checks.push(
                "echo '══════ 系统信息 ══════'",
                "cat /etc/os-release | head -3",
                "echo ''",
                "echo '══════ 内存 ══════'",
                "free -h",
                "echo ''",
                "echo '══════ 磁盘 ══════'",
                "df -h / /var /tmp 2>/dev/null",
            );

            if (focus === "all" || focus === "containers") {
                checks.push(
                    "echo ''",
                    "echo '══════ 容器状态 ══════'",
                    "(docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || podman ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo '未检测到容器运行时')",
                    "echo ''",
                    "echo '══════ 退出容器日志 (最近 30 行) ══════'",
                    "for c in $(docker ps -a --filter 'status=exited' --format '{{.Names}}' 2>/dev/null || podman ps -a --filter 'status=exited' --format '{{.Names}}' 2>/dev/null); do echo \"--- $c ---\"; (docker logs --tail 30 $c 2>&1 || podman logs --tail 30 $c 2>&1); echo ''; done",
                );
            }

            if (focus === "all" || focus === "database") {
                checks.push(
                    "echo ''",
                    "echo '══════ PostgreSQL ══════'",
                    "(pg_isready -h localhost 2>&1 && echo 'PostgreSQL: 运行中' || echo 'PostgreSQL: 未运行或不可达')",
                    "(systemctl is-active patroni 2>/dev/null && echo 'Patroni: 运行中' || echo 'Patroni: 未检测到')",
                );
            }

            if (focus === "all" || focus === "network") {
                checks.push(
                    "echo ''",
                    "echo '══════ 端口占用 ══════'",
                    "ss -tlnp | grep -E ':(80|443|5432|8000|8443|9090|3000) ' 2>/dev/null || echo '无法获取端口信息'",
                    "echo ''",
                    "echo '══════ DNS 解析 ══════'",
                    "(cat /etc/supabase/supacloud-credentials.env 2>/dev/null | grep 'DOMAIN' || echo '未找到域名配置')",
                    "echo ''",
                    "echo '══════ 防火墙 ══════'",
                    "(firewall-cmd --list-ports 2>/dev/null || ufw status 2>/dev/null || iptables -L -n 2>/dev/null | head -20 || echo '无法获取防火墙信息')",
                );
            }

            if (focus === "all" || focus === "logs") {
                checks.push(
                    "echo ''",
                    "echo '══════ 安装日志 (最后 50 行) ══════'",
                    "(tail -50 /var/log/supacloud-install.log 2>/dev/null || tail -50 /tmp/supacloud-install.log 2>/dev/null || echo '未找到安装日志')",
                    "echo ''",
                    "echo '══════ Systemd 失败服务 ══════'",
                    "(systemctl --failed --no-pager 2>/dev/null || echo '无法获取')",
                );
            }

            if (focus === "all" || focus === "disk") {
                checks.push(
                    "echo ''",
                    "echo '══════ 大文件/目录 ══════'",
                    "du -sh /var/lib/postgresql /var/lib/containers /var/lib/docker ~/pigsty 2>/dev/null | sort -rh | head -10",
                    "echo ''",
                    "echo '══════ Inode 使用率 ══════'",
                    "df -i / 2>/dev/null",
                );
            }

            const result = await ssh.exec(checks.join("\n"), 60_000);

            // 智能错误检测
            const output = result.stdout + "\n" + result.stderr;
            const issues: string[] = [];

            if (output.includes("No space left on device") || output.match(/Use%\s+(\d+)%/) && parseInt(RegExp.$1) > 90) {
                issues.push("⚠️ 磁盘空间不足，建议清理 /var/lib/containers 或扩容");
            }
            if (output.includes("exited") || output.includes("Exited")) {
                const exitedContainers = output.match(/supabase-\w+/g);
                if (exitedContainers) {
                    issues.push(`⚠️ 有容器异常退出: ${[...new Set(exitedContainers)].join(", ")}`);
                }
            }
            if (output.includes("PostgreSQL: 未运行") || output.includes("pg_isready")) {
                issues.push("⚠️ PostgreSQL 未运行，容器服务可能无法连接数据库");
            }
            if (output.includes("ECONNREFUSED") || output.includes("Connection refused")) {
                issues.push("⚠️ 存在端口连接拒绝，可能服务未启动或端口被占用");
            }
            if (output.includes("invalid character") || output.includes("manifest unknown")) {
                issues.push("⚠️ 容器镜像拉取异常，可能是 registry 配置错误（检查 Podman mirrors）");
            }

            const summary = issues.length > 0
                ? `\n\n🔍 自动检测到 ${issues.length} 个潜在问题:\n${issues.join("\n")}`
                : "\n\n✅ 未检测到明显异常";

            return {
                content: [
                    {
                        type: "text",
                        text: `${result.stdout.slice(-3000)}${summary}`,
                    },
                ],
            };
        }
    );

    // ── 查看容器日志 ──
    server.tool(
        "get_container_logs",
        "获取指定容器的最近日志，用于排查服务启动失败等问题",
        {
            container: z.string().describe("容器名称，例如 supabase-analytics, supabase-kong"),
            lines: z.number().default(100).describe("获取最近 N 行日志"),
        },
        async ({ container, lines }) => {
            const cmd = `(docker logs --tail ${lines} ${container} 2>&1 || podman logs --tail ${lines} ${container} 2>&1 || echo '容器 ${container} 不存在')`;
            const result = await ssh.exec(cmd, 30_000);
            return {
                content: [
                    {
                        type: "text",
                        text: `📋 ${container} 最近 ${lines} 行日志:\n\n${result.stdout || result.stderr}`,
                    },
                ],
            };
        }
    );
}
