/**
 * SSH Tools - Install/Upgrade/Diagnose (Available before SupaCloud installation)
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SshTransport } from "../transports/ssh";

export function registerSshTools(server: McpServer, ssh: SshTransport): void {
    // ── Check target server connectivity ──
    server.tool(
        "ping_server",
        "Check if target server is reachable via SSH",
        {},
        async () => {
            const ok = await ssh.ping();
            return {
                content: [
                    {
                        type: "text",
                        text: ok ? "✅ Server reachable" : "❌ Server unreachable, please check SSH config",
                    },
                ],
            };
        }
    );

    // ── Configure target server SSH self-connection (Ansible required) ──
    server.tool(
        "setup_server_ssh",
        "Configure root user SSH self-connection on target server, fix OpenSSL compatibility, prepare for Pigsty/Ansible installation",
        {},
        async () => {
            // 1. Ensure basic tools (Git, OpenSSL compat libs) exist
            const baseTools = await ssh.exec(
                "if ! command -v git &>/dev/null; then " +
                "  if command -v dnf &>/dev/null; then dnf install -y git; " +
                "  elif command -v yum &>/dev/null; then yum install -y git; " +
                "  elif command -v apt-get &>/dev/null; then apt-get update && apt-get install -y git; fi; " +
                "fi; " +
                "if command -v dnf &>/dev/null; then dnf install -y compat-openssl11 libatomic 2>/dev/null; " +
                "elif command -v yum &>/dev/null; then yum install -y compat-openssl11 libatomic 2>/dev/null; fi; " +
                "ldconfig 2>/dev/null; git --version; openssl version"
            );

            // 2. Configure root SSH self-connection
            const sshSetup = await ssh.exec(
                "mkdir -p ~/.ssh && chmod 700 ~/.ssh && " +
                "if [ ! -f ~/.ssh/id_ed25519 ]; then ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519; fi && " +
                "cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys && " +
                "chmod 600 ~/.ssh/authorized_keys && " +
                "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && " +
                "sed -i 's/^#\\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config && " +
                "grep -q '^PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config && " +
                "systemctl restart sshd || service ssh restart"
            );

            // 3. Wait for sshd ready, populate known_hosts, verify self-connection
            await ssh.exec("sleep 2");
            const keyscan = await ssh.exec(
                "IP=$(hostname -I | cut -d' ' -f1) && " +
                "ssh-keyscan -H localhost 127.0.0.1 $IP >> ~/.ssh/known_hosts 2>/dev/null && " +
                "chmod 600 ~/.ssh/known_hosts"
            );
            const verify = await ssh.exec(
                "ssh -o StrictHostKeyChecking=no root@localhost 'echo SSH_SELF_OK'"
            );

            const success = verify.stdout.includes("SSH_SELF_OK");
            return {
                content: [{
                    type: "text",
                    text: [
                        success ? "✅ SSH self-connection configured successfully, Ansible can run normally" : "❌ SSH self-connection verification failed, please check sshd status",
                        `Environment tools: ${baseTools.stdout.trim()}`,
                        `SSH config: exit ${sshSetup.code}`,
                        `known_hosts: exit ${keyscan.code}`,
                        `Self-connection verification: ${verify.stdout.trim() || verify.stderr.trim()}`,
                    ].join("\n"),
                }],
            };
        }
    );

    // ── Install SupaCloud ──
    server.tool(
        "install_supacloud",
        "One-click install SupaCloud (Pigsty + Supabase + OpenResty) on target server. Please call setup_server_ssh first to ensure prerequisites are ready.",
        {
            public_domain: z.string().describe("API domain, e.g. api.example.com"),
            studio_domain: z.string().optional().describe("Studio domain, defaults to public_domain"),
            postgres_password: z.string().optional().describe("Database password, auto-generated if empty"),
            dashboard_password: z.string().optional().describe("Console password"),
            edge_runtime: z.enum(["deno", "bun"]).default("deno").describe("Cloud function runtime"),
            storage_type: z.enum(["garage", "rustfs", "minio", "external"]).default("garage").describe("Storage backend"),
        },
        async ({ public_domain, studio_domain, postgres_password, dashboard_password, edge_runtime, storage_type }) => {
            const INSTALL_DIR = "/opt/supacloud";
            const LOG_FILE = "/tmp/supacloud-install.log";
            const REPO_URL = "https://github.com/zuohuadong/supacloud.git";
            const REPO_PROXY = "https://ghproxy.net/" + REPO_URL;

            // 1. Detect basic environment
            const osCheck = await ssh.exec("cat /etc/os-release | grep -E 'NAME|VERSION_ID' | head -4");

            // 2. Clone/update repo
            const cloneCmd = [
                `if [ -d "${INSTALL_DIR}/.git" ]; then`,
                `  echo 'repo exists, pulling latest...'; git -C ${INSTALL_DIR} pull --ff-only`,
                `else`,
                `  echo 'cloning repo...'`,
                `  git clone ${REPO_PROXY} ${INSTALL_DIR} 2>/dev/null || git clone ${REPO_URL} ${INSTALL_DIR}`,
                `fi`,
                `echo CLONE_OK`,
            ].join("\n");
            const clone = await ssh.exec(cloneCmd, 120_000);

            if (!clone.stdout.includes("CLONE_OK")) {
                return {
                    content: [{ type: "text", text: `❌ Repo clone failed, please check server network\n\n${clone.stderr.slice(-500)}` }],
                };
            }

            // 3. Write config.env
            const envLines = [
                `SUPABASE_PUBLIC_DOMAIN=${public_domain}`,
                `SUPABASE_STUDIO_DOMAIN=${studio_domain ?? public_domain}`,
                `EDGE_RUNTIME=${edge_runtime}`,
                `S3_STORAGE_TYPE=${storage_type}`,
                postgres_password ? `POSTGRES_PASSWORD=${postgres_password}` : "",
                dashboard_password ? `DASHBOARD_PASSWORD=${dashboard_password}` : "",
            ].filter(Boolean).join("\n");

            await ssh.exec(
                `cat > ${INSTALL_DIR}/config.env << 'ENVEOF'\n${envLines}\nENVEOF`
            );

            // 4. Start installation in background (nohup to avoid SSH timeout)
            const installCmd = [
                `chmod +x ${INSTALL_DIR}/install.sh`,
                `nohup bash ${INSTALL_DIR}/install.sh > ${LOG_FILE} 2>&1 &`,
                `INSTALL_PID=$!`,
                `sleep 3`,
                `kill -0 $INSTALL_PID 2>/dev/null && echo "INSTALL_STARTED pid=$INSTALL_PID" || echo 'INSTALL_FAILED'`,
            ].join(" && ");

            const result = await ssh.exec(installCmd, 30_000);
            const started = result.stdout.includes("INSTALL_STARTED");

            return {
                content: [{
                    type: "text",
                    text: started
                        ? [
                            `✅ SupaCloud installation started in background!`,
                            ``,
                            `OS: ${osCheck.stdout.trim()}`,
                            ``,
                            `Process: ${result.stdout.trim()}`,
                            `Install dir: ${INSTALL_DIR}`,
                            `Install log: ${LOG_FILE}`,
                            ``,
                            `📋 Track progress in real-time (via ssh_exec):`,
                            `  tail -f ${LOG_FILE}`,
                            ``,
                            `⏱ Installation takes about 15-30 minutes. Call diagnose_server after completion to verify service status.`,
                        ].join("\n")
                        : `❌ Start failed (exit ${result.code})\n${result.stderr.slice(-500)}`,
                }],
            };
        }
    );

    // ── Upgrade SupaCloud ──
    server.tool(
        "upgrade_supacloud",
        "Upgrade SupaCloud on target server to latest version",
        {
            version: z.string().optional().describe("Specific version, leave empty for latest"),
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
                            ? `✅ Upgrade completed\n${result.stdout.slice(-300)}`
                            : `❌ Upgrade failed (exit ${result.code})\n${result.stderr.slice(-500)}`,
                    },
                ],
            };
        }
    );

    // ── System diagnostics ──
    server.tool(
        "diagnose_server",
        "Diagnose target server status: memory/disk/service running status",
        {},
        async () => {
            const cmds = [
                "echo '=== OS ===' && uname -a",
                "echo '=== Memory ===' && free -h",
                "echo '=== Disk ===' && df -h /",
                "echo '=== Docker/Podman ===' && (docker ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || podman ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || echo 'Not found')",
                "echo '=== PostgreSQL ===' && (pg_isready 2>/dev/null && echo 'Running' || echo 'Not detected')",
                "echo '=== OpenResty ===' && (systemctl is-active openresty 2>/dev/null && openresty -v 2>&1 || echo 'Not running')",
                "echo '=== Management API ===' && (curl -sf http://localhost:9090/v1/projects > /dev/null && echo 'Running' || echo 'Not running')",
            ];
            const result = await ssh.exec(cmds.join(" && "));
            return {
                content: [{ type: "text", text: result.stdout || result.stderr }],
            };
        }
    );

    // ── Execute arbitrary command ──
    server.tool(
        "ssh_exec",
        "Execute custom Shell command on target server (use with caution)",
        {
            command: z.string().describe("Shell command to execute"),
            timeout_seconds: z.number().default(60).describe("Timeout in seconds"),
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

    // ── Installation troubleshooting ──
    server.tool(
        "troubleshoot_install",
        "Automatically diagnose SupaCloud installation issues: collect container logs, system resources, port conflicts, DNS, etc. and output structured report",
        {
            focus: z
                .enum(["all", "containers", "database", "network", "disk", "logs"])
                .default("all")
                .describe("Focus area for troubleshooting"),
        },
        async ({ focus }) => {
            const checks: string[] = [];

            // Always collect basic info
            checks.push(
                "echo '══════ System Info ══════'",
                "cat /etc/os-release | head -3",
                "echo ''",
                "echo '══════ Memory ══════'",
                "free -h",
                "echo ''",
                "echo '══════ Disk ══════'",
                "df -h / /var /tmp 2>/dev/null",
            );

            if (focus === "all" || focus === "containers") {
                checks.push(
                    "echo ''",
                    "echo '══════ Container Status ══════'",
                    "(docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || podman ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo 'Container runtime not detected')",
                    "echo ''",
                    "echo '══════ Exited Container Logs (last 30 lines) ══════'",
                    "for c in $(docker ps -a --filter 'status=exited' --format '{{.Names}}' 2>/dev/null || podman ps -a --filter 'status=exited' --format '{{.Names}}' 2>/dev/null); do echo \"--- $c ---\"; (docker logs --tail 30 $c 2>&1 || podman logs --tail 30 $c 2>&1); echo ''; done",
                );
            }

            if (focus === "all" || focus === "database") {
                checks.push(
                    "echo ''",
                    "echo '══════ PostgreSQL ══════'",
                    "(pg_isready -h localhost 2>&1 && echo 'PostgreSQL: Running' || echo 'PostgreSQL: Not running or unreachable')",
                    "(systemctl is-active patroni 2>/dev/null && echo 'Patroni: Running' || echo 'Patroni: Not detected')",
                );
            }

            if (focus === "all" || focus === "network") {
                checks.push(
                    "echo ''",
                    "echo '══════ Port Usage ══════'",
                    "ss -tlnp | grep -E ':(80|443|5432|8000|8443|9090|3000) ' 2>/dev/null || echo 'Cannot get port info'",
                    "echo ''",
                    "echo '══════ DNS Resolution ══════'",
                    "(cat /etc/supabase/supacloud-credentials.env 2>/dev/null | grep 'DOMAIN' || echo 'Domain config not found')",
                    "echo ''",
                    "echo '══════ Firewall ══════'",
                    "(firewall-cmd --list-ports 2>/dev/null || ufw status 2>/dev/null || iptables -L -n 2>/dev/null | head -20 || echo 'Cannot get firewall info')",
                );
            }

            if (focus === "all" || focus === "logs") {
                checks.push(
                    "echo ''",
                    "echo '══════ Install Logs (last 50 lines) ══════'",
                    "(tail -50 /var/log/supacloud-install.log 2>/dev/null || tail -50 /tmp/supacloud-install.log 2>/dev/null || echo 'Install log not found')",
                    "echo ''",
                    "echo '══════ Failed Systemd Services ══════'",
                    "(systemctl --failed --no-pager 2>/dev/null || echo 'Cannot get')",
                );
            }

            if (focus === "all" || focus === "disk") {
                checks.push(
                    "echo ''",
                    "echo '══════ Large Files/Directories ══════'",
                    "du -sh /var/lib/postgresql /var/lib/containers /var/lib/docker ~/pigsty 2>/dev/null | sort -rh | head -10",
                    "echo ''",
                    "echo '══════ Inode Usage ══════'",
                    "df -i / 2>/dev/null",
                );
            }

            const result = await ssh.exec(checks.join("\n"), 60_000);

            // Smart error detection
            const output = result.stdout + "\n" + result.stderr;
            const issues: string[] = [];

            if (output.includes("No space left on device") || output.match(/Use%\s+(\d+)%/) && parseInt(RegExp.$1) > 90) {
                issues.push("⚠️ Disk space insufficient, recommend cleaning /var/lib/containers or expanding");
            }
            if (output.includes("exited") || output.includes("Exited")) {
                const exitedContainers = output.match(/supabase-\w+/g);
                if (exitedContainers) {
                    issues.push(`⚠️ Containers exited abnormally: ${[...new Set(exitedContainers)].join(", ")}`);
                }
            }
            if (output.includes("PostgreSQL: Not running") || output.includes("pg_isready")) {
                issues.push("⚠️ PostgreSQL not running, container services may not connect to database");
            }
            if (output.includes("ECONNREFUSED") || output.includes("Connection refused")) {
                issues.push("⚠️ Port connection refused, service may not be started or port occupied");
            }
            if (output.includes("invalid character") || output.includes("manifest unknown")) {
                issues.push("⚠️ Container image pull abnormal, may be registry config error (check Podman mirrors)");
            }

            const summary = issues.length > 0
                ? `\n\n🔍 Detected ${issues.length} potential issues:\n${issues.join("\n")}`
                : "\n\n✅ No obvious anomalies detected";

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

    // ── View container logs ──
    server.tool(
        "get_container_logs",
        "Get recent logs of specified container, for troubleshooting service startup failures",
        {
            container: z.string().describe("Container name, e.g. supabase-analytics, supabase-kong"),
            lines: z.number().default(100).describe("Get last N lines of logs"),
        },
        async ({ container, lines }) => {
            const cmd = `(docker logs --tail ${lines} ${container} 2>&1 || podman logs --tail ${lines} ${container} 2>&1 || echo 'Container ${container} not found')`;
            const result = await ssh.exec(cmd, 30_000);
            return {
                content: [
                    {
                        type: "text",
                        text: `📋 ${container} last ${lines} lines of logs:\n\n${result.stdout || result.stderr}`,
                    },
                ],
            };
        }
    );

    // ══════════════════════════════════════════════
    // Multi-tenant runtime management tools (Plan C: per-tenant PostgREST)
    // ══════════════════════════════════════════════

    // ── Manage tenant runtime ──
    server.tool(
        "manage_tenant_runtime",
        "Manage tenant-specific PostgREST & GoTrue runtime processes (start/stop/restart/status)",
        {
            action: z.enum(["start", "stop", "restart", "status"]).describe("Action type"),
            project_ref: z.string().describe("Project reference ID, e.g. u3gksdpq3r"),
        },
        async ({ action, project_ref }) => {
            const cmd = `bash /opt/supacloud/scripts/lib/tenant_runtime.sh ${action} ${project_ref}`;
            const result = await ssh.exec(cmd, 60_000);
            const emoji = result.success ? "✅" : "❌";
            return {
                content: [
                    {
                        type: "text",
                        text: `${emoji} Tenant runtime ${action} [${project_ref}]\n\n${result.stdout}${result.stderr ? `\nstderr:\n${result.stderr}` : ""}`,
                    },
                ],
            };
        }
    );

    // ── List all tenant runtimes ──
    server.tool(
        "list_tenant_runtimes",
        "List all registered tenant PostgREST & GoTrue runtime processes and their status",
        {},
        async () => {
            const cmd = [
                "echo '=== Tenant Runtime Status ==='",
                "for f in /etc/supabase/tenants/*.env; do",
                "  [ -f \"$f\" ] || continue",
                "  if [[ \"$f\" == *_gotrue.env ]]; then continue; fi",
                "  ref=$(basename \"$f\" .env)",
                "  port=$(grep PGRST_SERVER_PORT \"$f\" | cut -d= -f2 || echo 'N/A')",
                "  gotrue_port=$(grep GOTRUE_API_PORT \"/etc/supabase/tenants/${ref}_gotrue.env\" 2>/dev/null | cut -d= -f2 || echo 'N/A')",
                "  if systemctl is-active \"supacloud-pgrst@${ref}\" >/dev/null 2>&1 || systemctl is-active \"supacloud-gotrue@${ref}\" >/dev/null 2>&1; then",
                "    pgrst_h=$(curl -sf http://127.0.0.1:${port}/ >/dev/null 2>&1 && echo 'ok' || echo 'fail')",
                "    gotrue_h=$(curl -sf http://127.0.0.1:${gotrue_port}/health >/dev/null 2>&1 && echo 'ok' || echo 'fail')",
                "    echo \"  ✅ ${ref}  pgrst=${port}(${pgrst_h})  gotrue=${gotrue_port}(${gotrue_h})  status=running\"",
                "  else",
                "    echo \"  ⏹️ ${ref}  pgrst=${port}  gotrue=${gotrue_port}  status=stopped\"",
                "  fi",
                "done",
                "echo ''",
                "echo '=== Kong Declarative Route Config ==='",
                "ls -l /etc/supabase/kong_tenants/*.yml 2>/dev/null | awk '{print $9}' || echo 'No dynamic route config'",
            ].join("\n");
            const result = await ssh.exec(cmd, 30_000);
            return {
                content: [{ type: "text", text: result.stdout || result.stderr }],
            };
        }
    );

    // ── View tenant gateway config ──
    server.tool(
        "inspect_tenant_gateway",
        "View tenant's Kong declarative gateway route config (YAML)",
        {
            project_ref: z.string().describe("Project reference ID"),
        },
        async ({ project_ref }) => {
            const cmd = `cat /etc/supabase/kong_tenants/${project_ref}.yml 2>/dev/null || echo 'Gateway config file not found for this tenant'`;
            const result = await ssh.exec(cmd, 10_000);
            return {
                content: [
                    {
                        type: "text",
                        text: `📄 ${project_ref} gateway config:\n\n${result.stdout || result.stderr}`,
                    },
                ],
            };
        }
    );

    // ── Multi-tenant environment diagnostics ──
    server.tool(
        "diagnose_multi_tenant",
        "Diagnose multi-tenant environment: check PostgREST & GoTrue processes, Kong declarative routes, database isolation, JWT config",
        {
            project_ref: z.string().optional().describe("Specify tenant ID for targeted diagnosis, leave empty for all"),
        },
        async ({ project_ref }) => {
            const checks: string[] = [
                "echo '══════ Multi-tenant Diagnostic Report ══════'",
                "echo ''",
                "echo '--- Tenant Processes (PostgREST & GoTrue) ---'",
                "ps aux | grep -E 'postgrest|gotrue' | grep -v grep || echo 'No tenant processes running'",
                "echo ''",
                "echo '--- systemd Tenant Services ---'",
                "systemctl list-units 'supacloud-pgrst@*' 'supacloud-gotrue@*' --no-pager 2>/dev/null || echo 'No tenant services'",
                "echo ''",
                "echo '--- Kong Declarative Route Config ---'",
                "ls -l /etc/supabase/kong_tenants/*.yml 2>/dev/null || echo 'No config'",
                "echo ''",
                "echo '--- Tenant Database List ---'",
                "su - postgres -c \"psql -tAc \\\"SELECT datname FROM pg_database WHERE datname LIKE 'supa_%'\\\"\" 2>/dev/null || echo 'Cannot query'",
            ];

            if (project_ref) {
                checks.push(
                    `echo ''`,
                    `echo '--- Tenant ${project_ref} Details ---'`,
                    `systemctl status supacloud-pgrst@${project_ref} --no-pager 2>/dev/null || echo 'PostgREST service not found'`,
                    `systemctl status supacloud-gotrue@${project_ref} --no-pager 2>/dev/null || echo 'GoTrue service not found'`,
                    `echo ''`,
                    `cat /etc/supabase/tenants/${project_ref}.env /etc/supabase/tenants/${project_ref}_gotrue.env 2>/dev/null | grep -v PASSWORD | grep -v SECRET | grep -v URL || echo 'Config not found'`,
                    `echo ''`,
                    `echo '--- authenticator Permissions ---'`,
                    `su - postgres -c "psql -tAc \\"SELECT has_database_privilege('authenticator', 'supa_${project_ref}', 'CONNECT')\\"" 2>/dev/null || echo 'Cannot check'`,
                );
            }

            const result = await ssh.exec(checks.join("\n"), 30_000);
            return {
                content: [{ type: "text", text: result.stdout || result.stderr }],
            };
        }
    );

    // ── Tenant data migration ──
    server.tool(
        "migrate_tenant_data",
        "Migrate data between tenant databases via pg_dump/pg_restore",
        {
            source_ref: z.string().describe("Source tenant project ID"),
            target_ref: z.string().describe("Target tenant project ID"),
            schemas: z.string().default("public,auth,storage").describe("Schemas to migrate, comma separated"),
            data_only: z.boolean().default(false).describe("Migrate data only (no structure)"),
        },
        async ({ source_ref, target_ref, schemas, data_only }) => {
            const schemaArgs = schemas.split(",").map(s => `-n ${s.trim()}`).join(" ");
            const dataFlag = data_only ? "--data-only" : "";
            const cmd = [
                `echo 'Migrating data: supa_${source_ref} → supa_${target_ref}'`,
                `echo 'Schemas: ${schemas}'`,
                `echo ''`,
                // Disk space check
                `avail=$(df -k /tmp | awk 'NR==2 {print $4}')`,
                `if [ "$avail" -lt 5242880 ]; then echo 'ERROR: /tmp free space < 5GB, please clean up and retry'; exit 1; fi`,
                // dump
                `pg_dump -h localhost -U postgres -d supa_${source_ref} ${schemaArgs} ${dataFlag} -Fc -f /tmp/migrate_${source_ref}_to_${target_ref}.dump 2>&1`,
                `echo '✅ Dump completed'`,
                // restore
                `pg_restore -h localhost -U postgres -d supa_${target_ref} --no-owner --no-acl /tmp/migrate_${source_ref}_to_${target_ref}.dump 2>&1 || true`,
                `echo '✅ Restore completed'`,
                // cleanup
                `rm -f /tmp/migrate_${source_ref}_to_${target_ref}.dump`,
                `echo '✅ Temp files cleaned'`,
            ].join("\n");

            const result = await ssh.exec(cmd, 600_000); // 10 min timeout
            return {
                content: [
                    {
                        type: "text",
                        text: result.success
                            ? `✅ Data migration completed\n\n${result.stdout}`
                            : `❌ Migration had errors\n\n${result.stdout}\n\nstderr:\n${result.stderr.slice(-1000)}`,
                    },
                ],
            };
        }
    );
}
