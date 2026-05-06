/**
 * SSH — Compound tool (13→1)
 * Install, upgrade, diagnose, exec, tenant mgmt — all via SSH
 */
import { z } from "zod";
import type { SshTransport } from "../transports/ssh";

const SAFE_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_PROJECT_REF = /^[a-z0-9-]{1,20}$/;
const SAFE_RELEASE_TAG = /^[a-zA-Z0-9._-]{1,80}$/;
const SAFE_TIMEOUT_SECONDS = 300;
const ALLOWED_EXEC_PREFIXES = [
    "systemctl ",
    "journalctl ",
    "docker ps",
    "docker logs ",
    "podman ps",
    "podman logs ",
    "ps ",
    "ss ",
    "df ",
    "free ",
    "uname ",
    "cat /etc/os-release",
    "tail ",
    "ls ",
    "du ",
    "pg_isready",
    "curl ",
    "grep ",
    "find ",
    "hostname",
];

function assertSafeProjectRef(value: string, fieldName: string): string {
    if (!SAFE_PROJECT_REF.test(value)) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function assertSafeContainerName(value: string): string {
    if (!SAFE_CONTAINER_NAME.test(value)) {
        throw new Error("Invalid container name");
    }
    return value;
}

function assertSafeReleaseTag(value: string): string {
    if (!SAFE_RELEASE_TAG.test(value)) {
        throw new Error("Invalid release version");
    }
    return value;
}

function assertSafeGithubProxy(value: string): string {
    const trimmed = value.trim();
    if (/[\s\n\r;&|`$<>]/.test(trimmed)) {
        throw new Error("Invalid github_proxy");
    }
    if (trimmed.toLowerCase() === "direct" || trimmed.toLowerCase() === "none") {
        return trimmed;
    }

    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Invalid github_proxy protocol");
    }
    return parsed.toString();
}

function getExecTimeoutMs(timeoutSeconds?: number): number {
    const seconds = timeoutSeconds || 60;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > SAFE_TIMEOUT_SECONDS) {
        throw new Error(`timeout_seconds must be between 1 and ${SAFE_TIMEOUT_SECONDS}`);
    }
    return seconds * 1000;
}

function assertSafeExecCommand(command: string): string {
    const trimmed = command.trim();
    if (!trimmed) {
        throw new Error("'command' required");
    }
    if (/[\n\r;&|`$<>]/.test(trimmed)) {
        throw new Error("Unsafe shell metacharacters are not allowed in exec command");
    }
    if (!ALLOWED_EXEC_PREFIXES.some(prefix => trimmed === prefix.trimEnd() || trimmed.startsWith(prefix))) {
        throw new Error("Command is outside the allowed diagnostic command set");
    }
    return trimmed;
}

export function registerSshTools(server: { tool: (...args: any[]) => void }, ssh: SshTransport): void {
    server.tool(
        "ssh",
        `Server management via SSH. Available before & after SupaCloud installation.
Actions: ping, setup, install, upgrade, diagnose, exec, troubleshoot, container_logs, tenant_manage, tenant_list, tenant_inspect, tenant_diagnose, tenant_migrate`,
        {
            action: z.enum([
                "ping", "setup", "install", "upgrade", "diagnose", "exec",
                "troubleshoot", "container_logs",
                "tenant_manage", "tenant_list", "tenant_inspect", "tenant_diagnose", "tenant_migrate",
            ]).describe("Action to perform"),
            command: z.string().optional().describe("[exec] Restricted shell command to execute"),
            timeout_seconds: z.number().optional().describe("[exec] Timeout in seconds (default: 60)"),
            public_domain: z.string().optional().describe("[install] API domain, e.g. api.example.com"),
            studio_domain: z.string().optional().describe("[install] Studio domain"),
            postgres_password: z.string().optional().describe("[install] DB password (auto-generated if empty)"),
            dashboard_password: z.string().optional().describe("[install] Console password"),
            edge_runtime: z.enum(["bun"]).optional().describe("[install] Runtime (default: bun)"),
            storage_type: z.enum(["juicefs", "garage", "rustfs", "minio", "external"]).optional().describe("[install] Storage backend"),
            version: z.string().optional().describe("[upgrade] Specific version"),
            github_proxy: z.string().optional().describe("[upgrade] GitHub proxy prefix, e.g. https://ghproxy.net/ or direct"),
            focus: z.enum(["all", "containers", "database", "network", "disk", "logs"]).optional().describe("[troubleshoot] Focus area"),
            container: z.string().optional().describe("[container_logs] Container name"),
            lines: z.number().optional().describe("[container_logs] Number of log lines (default: 100)"),
            project_ref: z.string().optional().describe("[tenant_*] Project reference ID"),
            tenant_action: z.enum(["start", "stop", "restart", "status"]).optional().describe("[tenant_manage] Action"),
            source_ref: z.string().optional().describe("[tenant_migrate] Source tenant"),
            target_ref: z.string().optional().describe("[tenant_migrate] Target tenant"),
            schemas: z.string().optional().describe("[tenant_migrate] Schemas (default: public,auth,storage)"),
            data_only: z.boolean().optional().describe("[tenant_migrate] Data only, no structure"),
        },
        async (args: any) => {
            const { action } = args;
            let text: string;

            switch (action) {
                case "ping": {
                    const ok = await ssh.ping();
                    text = ok ? "✅ Server reachable" : "❌ Server unreachable";
                    break;
                }
                case "setup": {
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
                    const sshSetup = await ssh.exec(
                        "mkdir -p ~/.ssh && chmod 700 ~/.ssh && " +
                        "if [ ! -f ~/.ssh/id_ed25519 ]; then ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519; fi && " +
                        "cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && " +
                        "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && " +
                        "sed -i 's/^#\\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config && " +
                        "grep -q '^PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config && " +
                        "systemctl restart sshd || service ssh restart"
                    );
                    await ssh.exec("sleep 2");
                    await ssh.exec("IP=$(hostname -I | cut -d' ' -f1) && ssh-keyscan -H localhost 127.0.0.1 $IP >> ~/.ssh/known_hosts 2>/dev/null && chmod 600 ~/.ssh/known_hosts");
                    const verify = await ssh.exec("ssh -o StrictHostKeyChecking=no root@localhost 'echo SSH_SELF_OK'");
                    const ok = verify.stdout.includes("SSH_SELF_OK");
                    text = [ok ? "✅ SSH configured" : "❌ SSH verification failed",
                        `Tools: ${baseTools.stdout.trim()}`, `SSH: exit ${sshSetup.code}`,
                        `Verify: ${verify.stdout.trim() || verify.stderr.trim()}`].join("\n");
                    break;
                }
                case "install": {
                    if (!args.public_domain) throw new Error("'public_domain' required");
                    const DIR = "/opt/supacloud", LOG = "/tmp/supacloud-install.log";
                    const REPO = "https://github.com/zuohuadong/supacloud.git";
                    const osCheck = await ssh.exec("cat /etc/os-release | grep -E 'NAME|VERSION_ID' | head -4");
                    const clone = await ssh.exec(
                        `if [ -d "${DIR}/.git" ]; then git -C ${DIR} pull --ff-only; else git clone https://ghproxy.net/${REPO} ${DIR} 2>/dev/null || git clone ${REPO} ${DIR}; fi; echo CLONE_OK`, 120_000
                    );
                    if (!clone.stdout.includes("CLONE_OK")) { text = `❌ Clone failed\n${clone.stderr.slice(-500)}`; break; }
                    const envLines = [
                        `SUPABASE_PUBLIC_DOMAIN=${args.public_domain}`,
                        `SUPABASE_STUDIO_DOMAIN=${args.studio_domain ?? args.public_domain}`,
                        `EDGE_RUNTIME=${args.edge_runtime || "bun"}`,
                        `S3_STORAGE_TYPE=${args.storage_type || "juicefs"}`,
                        args.postgres_password ? `POSTGRES_PASSWORD=${args.postgres_password}` : "",
                        args.dashboard_password ? `DASHBOARD_PASSWORD=${args.dashboard_password}` : "",
                    ].filter(Boolean).join("\n");
                    await ssh.exec(`cat > ${DIR}/config.env << 'ENVEOF'\n${envLines}\nENVEOF`);
                    const result = await ssh.exec(`chmod +x ${DIR}/install.sh && nohup bash ${DIR}/install.sh > ${LOG} 2>&1 & && INSTALL_PID=$! && sleep 3 && kill -0 $INSTALL_PID 2>/dev/null && echo "INSTALL_STARTED pid=$INSTALL_PID" || echo 'INSTALL_FAILED'`, 30_000);
                    text = result.stdout.includes("INSTALL_STARTED")
                        ? `✅ Installation started\nOS: ${osCheck.stdout.trim()}\n${result.stdout.trim()}\nLog: ${LOG}\n⏱ ~15-30 min`
                        : `❌ Start failed\n${result.stderr.slice(-500)}`;
                    break;
                }
                case "upgrade": {
                    const envParts = [
                        args.version ? `SUPACLOUD_UPGRADE_TAG=${assertSafeReleaseTag(args.version)}` : "",
                        args.github_proxy ? `SUPACLOUD_GITHUB_PROXY=${assertSafeGithubProxy(args.github_proxy)}` : "",
                    ].filter(Boolean);
                    const envPrefix = envParts.length > 0 ? `${envParts.join(" ")} ` : "";
                    const cmd = "if [ ! -x /usr/local/bin/supacloud ]; then " +
                        "echo 'SupaCloud binary not found at /usr/local/bin/supacloud; run ssh install first.' >&2; exit 127; " +
                        `fi; ${envPrefix}/usr/local/bin/supacloud upgrade --yes`;
                    const r = await ssh.exec(cmd, 600_000);
                    text = r.success ? `✅ Upgrade done\n${r.stdout.slice(-300)}` : `❌ Failed (exit ${r.code})\n${r.stderr.slice(-500)}`;
                    break;
                }
                case "diagnose": {
                    const cmds = [
                        "echo '=== OS ===' && uname -a",
                        "echo '=== Memory ===' && free -h",
                        "echo '=== Disk ===' && df -h /",
                        "echo '=== Docker ===' && (docker ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || echo 'Not found')",
                        "echo '=== PostgreSQL ===' && (pg_isready 2>/dev/null && echo 'Running' || echo 'Not detected')",
                        "echo '=== Management API ===' && (curl -sf http://localhost:9090/v1/projects > /dev/null && echo 'Running' || echo 'Not running')",
                    ];
                    const r = await ssh.exec(cmds.join(" && "));
                    text = r.stdout || r.stderr;
                    break;
                }
                case "exec": {
                    if (!args.command) throw new Error("'command' required");
                    const command = assertSafeExecCommand(args.command);
                    const r = await ssh.exec(command, getExecTimeoutMs(args.timeout_seconds));
                    text = `exit: ${r.code}\n\nstdout:\n${r.stdout.slice(-2000)}\n\nstderr:\n${r.stderr.slice(-500)}`;
                    break;
                }
                case "troubleshoot": {
                    const f = args.focus || "all";
                    const checks: string[] = [
                        "echo '══════ System ══════'", "cat /etc/os-release | head -3", "free -h", "df -h / /var /tmp 2>/dev/null",
                    ];
                    if (f === "all" || f === "containers") checks.push(
                        "echo '══════ Containers ══════'",
                        "(docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo 'Not found')",
                    );
                    if (f === "all" || f === "database") checks.push(
                        "echo '══════ PostgreSQL ══════'",
                        "(pg_isready -h localhost 2>&1 && echo 'Running' || echo 'Not running')",
                    );
                    if (f === "all" || f === "network") checks.push(
                        "echo '══════ Ports ══════'",
                        "ss -tlnp | grep -E ':(80|443|5432|8000|9090|3000) ' 2>/dev/null || echo 'N/A'",
                    );
                    if (f === "all" || f === "logs") checks.push(
                        "echo '══════ Install Log ══════'",
                        "(tail -50 /var/log/supacloud-install.log 2>/dev/null || tail -50 /tmp/supacloud-install.log 2>/dev/null || echo 'Not found')",
                    );
                    if (f === "all" || f === "disk") checks.push(
                        "echo '══════ Large Dirs ══════'",
                        "du -sh /var/lib/postgresql /var/lib/docker 2>/dev/null | sort -rh | head -10",
                    );
                    const r = await ssh.exec(checks.join("\n"), 60_000);
                    text = r.stdout.slice(-3000);
                    break;
                }
                case "container_logs": {
                    if (!args.container) throw new Error("'container' required");
                    const n = args.lines || 100;
                    if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new Error("'lines' must be between 1 and 1000");
                    const container = assertSafeContainerName(args.container);
                    const r = await ssh.exec(`docker logs --tail ${n} ${container} 2>&1 || echo 'Container not found'`, 30_000);
                    text = `📋 ${container} last ${n} lines:\n\n${r.stdout || r.stderr}`;
                    break;
                }
                case "tenant_manage": {
                    if (!args.project_ref || !args.tenant_action) throw new Error("'project_ref' and 'tenant_action' required");
                    const projectRef = assertSafeProjectRef(args.project_ref, "project_ref");
                    const r = await ssh.exec(`bash /opt/supacloud/scripts/lib/tenant_runtime.sh ${args.tenant_action} ${projectRef}`, 60_000);
                    text = `${r.success ? "✅" : "❌"} Tenant ${args.tenant_action} [${projectRef}]\n${r.stdout}`;
                    break;
                }
                case "tenant_list": {
                    const cmd = [
                        "echo '=== Tenant Runtimes ==='",
                        "for f in /etc/supabase/tenants/*.env; do",
                        "  [ -f \"$f\" ] || continue",
                        "  [[ \"$f\" == *_gotrue.env ]] && continue",
                        "  ref=$(basename \"$f\" .env)",
                        "  port=$(grep PGRST_SERVER_PORT \"$f\" | cut -d= -f2 || echo N/A)",
                        "  if systemctl is-active \"supacloud-pgrst@${ref}\" >/dev/null 2>&1; then",
                        "    echo \"  ✅ ${ref}  port=${port}  status=running\"",
                        "  else echo \"  ⏹️ ${ref}  port=${port}  status=stopped\"; fi",
                        "done",
                    ].join("\n");
                    const r = await ssh.exec(cmd, 30_000);
                    text = r.stdout || r.stderr;
                    break;
                }
                case "tenant_inspect": {
                    if (!args.project_ref) throw new Error("'project_ref' required");
                    const projectRef = assertSafeProjectRef(args.project_ref, "project_ref");
                    const r = await ssh.exec(`cat /etc/supabase/tenants/${projectRef}.env 2>/dev/null || echo 'Not found'`, 10_000);
                    text = `📄 ${projectRef} tenant config:\n\n${r.stdout || r.stderr}`;
                    break;
                }
                case "tenant_diagnose": {
                    const checks = [
                        "echo '══════ Multi-tenant Diagnostic ══════'",
                        "ps aux | grep -E 'postgrest|gotrue' | grep -v grep || echo 'No processes'",
                        "systemctl list-units 'supacloud-pgrst@*' 'supacloud-gotrue@*' --no-pager 2>/dev/null || echo 'N/A'",
                        "ls -l /etc/supabase/tenants/*.env 2>/dev/null || echo 'No config'",
                    ];
                    if (args.project_ref) {
                        const projectRef = assertSafeProjectRef(args.project_ref, "project_ref");
                        checks.push(
                            `systemctl status supacloud-pgrst@${projectRef} --no-pager 2>/dev/null || echo 'Not found'`,
                            `cat /etc/supabase/tenants/${projectRef}.env 2>/dev/null | grep -v PASSWORD | grep -v SECRET || echo 'N/A'`,
                        );
                    }
                    const r = await ssh.exec(checks.join("\n"), 30_000);
                    text = r.stdout || r.stderr;
                    break;
                }
                case "tenant_migrate": {
                    if (!args.source_ref || !args.target_ref) throw new Error("'source_ref' and 'target_ref' required");
                    const sourceRef = assertSafeProjectRef(args.source_ref, "source_ref");
                    const targetRef = assertSafeProjectRef(args.target_ref, "target_ref");
                    const s = args.schemas || "public,auth,storage";
                    if (!/^[a-z_,\s]+$/.test(s)) throw new Error("Invalid schemas");
                    const schemaArgs = s.split(",").map((x: string) => x.trim()).filter(Boolean).map((x: string) => `-n ${x}`).join(" ");
                    const df = args.data_only ? "--data-only" : "";
                    const cmd = [
                        `echo 'Migrating: supa_${sourceRef} → supa_${targetRef}'`,
                        `pg_dump -h localhost -U postgres -d supa_${sourceRef} ${schemaArgs} ${df} -Fc -f /tmp/migrate.dump 2>&1`,
                        `pg_restore -h localhost -U postgres -d supa_${targetRef} --no-owner --no-acl /tmp/migrate.dump 2>&1 || true`,
                        `rm -f /tmp/migrate.dump && echo '✅ Done'`,
                    ].join("\n");
                    const r = await ssh.exec(cmd, 600_000);
                    text = r.success ? `✅ Migration done\n${r.stdout}` : `❌ Errors\n${r.stdout}\n${r.stderr.slice(-1000)}`;
                    break;
                }
                default:
                    text = `❌ Unknown action: ${action}`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
