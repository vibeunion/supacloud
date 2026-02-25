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
}
