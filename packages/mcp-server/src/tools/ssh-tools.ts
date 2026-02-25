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

    // ══════════════════════════════════════════════
    // 多租户运行时管理工具（方案C: per-tenant PostgREST）
    // ══════════════════════════════════════════════

    // ── 管理租户运行时 ──
    server.tool(
        "manage_tenant_runtime",
        "管理租户专属 PostgREST 运行时进程（启动/停止/重启/查看状态）",
        {
            action: z.enum(["start", "stop", "restart", "status"]).describe("操作类型"),
            project_ref: z.string().describe("项目引用 ID，例如 u3gksdpq3r"),
        },
        async ({ action, project_ref }) => {
            const cmd = `bash /opt/supacloud/scripts/lib/tenant_runtime.sh ${action} ${project_ref}`;
            const result = await ssh.exec(cmd, 60_000);
            const emoji = result.success ? "✅" : "❌";
            return {
                content: [
                    {
                        type: "text",
                        text: `${emoji} 租户运行时 ${action} [${project_ref}]\n\n${result.stdout}${result.stderr ? `\nstderr:\n${result.stderr}` : ""}`,
                    },
                ],
            };
        }
    );

    // ── 列出所有租户运行时 ──
    server.tool(
        "list_tenant_runtimes",
        "列出所有已注册的租户 PostgREST 运行时进程及其状态",
        {},
        async () => {
            const cmd = [
                "echo '=== 租户运行时状态 ==='",
                "for f in /etc/supabase/tenants/*.env; do",
                "  [ -f \"$f\" ] || continue",
                "  ref=$(basename \"$f\" .env)",
                "  port=$(grep PGRST_SERVER_PORT \"$f\" | cut -d= -f2)",
                "  if systemctl is-active \"supacloud-pgrst@${ref}\" >/dev/null 2>&1; then",
                "    health=$(curl -sf http://127.0.0.1:${port}/ >/dev/null 2>&1 && echo 'healthy' || echo 'unhealthy')",
                "    echo \"  ✅ ${ref}  port=${port}  status=running  health=${health}\"",
                "  else",
                "    echo \"  ⏹️ ${ref}  port=${port}  status=stopped\"",
                "  fi",
                "done",
                "echo ''",
                "echo '=== Kong Services ==='",
                "curl -s http://localhost:8001/services 2>/dev/null | python3 -m json.tool 2>/dev/null | grep -E '\"name\"|\"host\"|\"port\"' | head -30 || echo '无法获取 Kong 服务列表'",
            ].join("\n");
            const result = await ssh.exec(cmd, 30_000);
            return {
                content: [{ type: "text", text: result.stdout || result.stderr }],
            };
        }
    );

    // ── 多租户环境诊断 ──
    server.tool(
        "diagnose_multi_tenant",
        "诊断多租户环境：检查 PostgREST 进程、Kong 路由、数据库隔离、JWT 配置",
        {
            project_ref: z.string().optional().describe("指定租户 ID 进行精准诊断，留空则诊断全部"),
        },
        async ({ project_ref }) => {
            const checks: string[] = [
                "echo '══════ 多租户诊断报告 ══════'",
                "echo ''",
                "echo '--- PostgREST 进程 ---'",
                "ps aux | grep postgrest | grep -v grep || echo '无 PostgREST 进程运行'",
                "echo ''",
                "echo '--- systemd 租户服务 ---'",
                "systemctl list-units 'supacloud-pgrst@*' --no-pager 2>/dev/null || echo '无租户服务'",
                "echo ''",
                "echo '--- Kong Routes ---'",
                "curl -s http://localhost:8001/routes 2>/dev/null | python3 -c \"import sys,json; data=json.load(sys.stdin); [print(f'  {r[\\\"name\\\"]}  →  headers={r.get(\\\"headers\\\",{})}') for r in data.get('data',[])]\" 2>/dev/null || echo '无法获取'",
                "echo ''",
                "echo '--- 租户数据库列表 ---'",
                "su - postgres -c \"psql -tAc \\\"SELECT datname FROM pg_database WHERE datname LIKE 'supa_%'\\\"\" 2>/dev/null || echo '无法查询'",
            ];

            if (project_ref) {
                checks.push(
                    `echo ''`,
                    `echo '--- 租户 ${project_ref} 详情 ---'`,
                    `systemctl status supacloud-pgrst@${project_ref} --no-pager 2>/dev/null || echo '服务未找到'`,
                    `echo ''`,
                    `cat /etc/supabase/tenants/${project_ref}.env 2>/dev/null | grep -v PASSWORD | grep -v SECRET || echo '配置未找到'`,
                    `echo ''`,
                    `echo '--- authenticator 权限 ---'`,
                    `su - postgres -c "psql -tAc \\"SELECT has_database_privilege('authenticator', 'supa_${project_ref}', 'CONNECT')\\"" 2>/dev/null || echo '无法检查'`,
                );
            }

            const result = await ssh.exec(checks.join("\n"), 30_000);
            return {
                content: [{ type: "text", text: result.stdout || result.stderr }],
            };
        }
    );

    // ── 租户数据迁移 ──
    server.tool(
        "migrate_tenant_data",
        "通过 pg_dump/pg_restore 在租户数据库之间迁移数据",
        {
            source_ref: z.string().describe("源租户项目 ID"),
            target_ref: z.string().describe("目标租户项目 ID"),
            schemas: z.string().default("public,auth,storage").describe("要迁移的 schema，逗号分隔"),
            data_only: z.boolean().default(false).describe("仅迁移数据（不含结构）"),
        },
        async ({ source_ref, target_ref, schemas, data_only }) => {
            const schemaArgs = schemas.split(",").map(s => `-n ${s.trim()}`).join(" ");
            const dataFlag = data_only ? "--data-only" : "";
            const cmd = [
                `echo '迁移数据: supa_${source_ref} → supa_${target_ref}'`,
                `echo 'Schemas: ${schemas}'`,
                `echo ''`,
                // 磁盘空间检查
                `avail=$(df -k /tmp | awk 'NR==2 {print $4}')`,
                `if [ "$avail" -lt 5242880 ]; then echo 'ERROR: /tmp 剩余空间 < 5GB，请清理后重试'; exit 1; fi`,
                // dump
                `pg_dump -h localhost -U postgres -d supa_${source_ref} ${schemaArgs} ${dataFlag} -Fc -f /tmp/migrate_${source_ref}_to_${target_ref}.dump 2>&1`,
                `echo '✅ Dump 完成'`,
                // restore
                `pg_restore -h localhost -U postgres -d supa_${target_ref} --no-owner --no-acl /tmp/migrate_${source_ref}_to_${target_ref}.dump 2>&1 || true`,
                `echo '✅ Restore 完成'`,
                // 清理
                `rm -f /tmp/migrate_${source_ref}_to_${target_ref}.dump`,
                `echo '✅ 临时文件已清理'`,
            ].join("\n");

            const result = await ssh.exec(cmd, 600_000); // 10 分钟超时
            return {
                content: [
                    {
                        type: "text",
                        text: result.success
                            ? `✅ 数据迁移完成\n\n${result.stdout}`
                            : `❌ 迁移过程有错误\n\n${result.stdout}\n\nstderr:\n${result.stderr.slice(-1000)}`,
                    },
                ],
            };
        }
    );
}
