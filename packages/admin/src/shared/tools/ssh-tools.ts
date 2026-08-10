/**
 * SSH — Compound tool (13→1)
 * Install, upgrade, diagnose, exec, tenant mgmt — all via SSH
 */
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { decodedSchema, optional, stringEnum, withDescription } from "../schema";
import type { SshTransport } from "../transports/ssh";
import releaseAssetsScript from "../../../../../scripts/lib/release_assets.sh" with { type: "text" };

const SAFE_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_PROJECT_REF = /^[a-z0-9-]{1,20}$/;
const SAFE_SCHEMA_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const SAFE_RELEASE_TAG = /^[a-zA-Z0-9._-]{1,80}$/;
const SAFE_TIMEOUT_SECONDS = 300;
const SAFE_HOSTNAME = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/;
const SAFE_SYSTEMD_UNIT = /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,127}$/;
const SAFE_DB_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/;
const MINIMUM_COMPONENT_UPGRADE_VERSION = "0.50.27";

function hostnameSchema(fieldName: string) {
    return decodedSchema(Type.String(), Type.String({ minLength: 1, maxLength: 253 }), (value) => {
        const normalized = value.trim();
        if (!SAFE_HOSTNAME.test(normalized)) throw new Error(`Invalid ${fieldName}`);
        return normalized.toLowerCase();
    });
}

function secretSchema(fieldName: string) {
    return decodedSchema(Type.String(), Type.String({ minLength: 12, maxLength: 256 }), (value) => {
        if (value.length < 12) throw new Error(`${fieldName} must contain at least 12 characters`);
        if (value.length > 256) throw new Error(`${fieldName} must contain at most 256 characters`);
        if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
            throw new Error(`Invalid ${fieldName}`);
        }
        return value;
    });
}

function quoteEnvValue(value: string): string {
    return `'${value.split("'").join("'\\''")}'`;
}

const REMOTE_ENV_REDACTION_AWK = "awk -F= 'BEGIN { IGNORECASE=1 } /^[A-Za-z_][A-Za-z0-9_]*=/ { key=$1; if (key ~ /(PASSWORD|PASS|SECRET|TOKEN|KEY|CREDENTIAL|DB_URI|DATABASE_URL|DSN)/) print key \"=[REDACTED]\"; else print; next } { print }'";

function redactTenantConfig(value: string): string {
    const redactedLines = value.split(/\r?\n/).map((line) => {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) return line;
        const key = match[1];
        if (!/(?:PASSWORD|PASS|SECRET|TOKEN|KEY|CREDENTIAL|DB_URI|DATABASE_URL|DSN)/i.test(key)) {
            return line;
        }
        return `${key}=[REDACTED]`;
    }).join("\n");

    return redactedLines
        .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASS|SECRET|TOKEN|KEY|CREDENTIAL|DB_URI|DATABASE_URL|DSN)[A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[REDACTED]")
        .replace(/\b(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}

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

function assertExactStableVersion(value: string, fieldName: string): string {
    if (!/^v?\d+\.\d+\.\d+$/.test(value)) {
        throw new Error(`${fieldName} must be an exact stable semantic version`);
    }
    return value;
}

type UpgradeRequest = {
    version?: string;
    edgeRuntimeVersion?: string;
    githubProxy?: string;
    helperPath: string;
};

function upgradeEnvAssignments(request: UpgradeRequest): string {
    return [
        request.version ? `SUPACLOUD_UPGRADE_TAG=${quoteEnvValue(request.version)}` : "",
        request.edgeRuntimeVersion ? `SUPACLOUD_EDGE_RUNTIME_UPGRADE_TAG=${quoteEnvValue(request.edgeRuntimeVersion)}` : "",
        request.githubProxy ? `SUPACLOUD_GITHUB_PROXY=${quoteEnvValue(request.githubProxy)}` : "",
    ].filter(Boolean).join(" ");
}

function componentBootstrapCommands(request: UpgradeRequest): string[] {
    if (!request.edgeRuntimeVersion) return [`UPGRADE_RUNNER=${quoteEnvValue("/usr/local/bin/supacloud")}`];
    const managementVersion = request.version || "latest";
    return [
        `ACTIVE_VERSION=$(/usr/local/bin/supacloud --version 2>&1 | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)`,
        `UPGRADE_RUNNER=${quoteEnvValue("/usr/local/bin/supacloud")}`,
        `if ! supacloud_version_at_least "$ACTIVE_VERSION" ${quoteEnvValue(MINIMUM_COMPONENT_UPGRADE_VERSION)}; then`,
        `  case "$(uname -m)" in x86_64|amd64) MANAGEMENT_ASSET=supacloud-linux-amd64 ;; aarch64|arm64) MANAGEMENT_ASSET=supacloud-linux-arm64 ;; *) echo 'Unsupported Management architecture' >&2; exit 1 ;; esac`,
        `  STAGED_MANAGEMENT=$(mktemp /tmp/supacloud-management-upgrade.XXXXXX)`,
        `  MANAGEMENT_RELEASE=$(supacloud_fetch_component_release management-api ${quoteEnvValue(managementVersion)} "$MANAGEMENT_ASSET" web-console-build.tar.gz)`,
        `  supacloud_download_release_asset "$MANAGEMENT_RELEASE" "$MANAGEMENT_ASSET" "$STAGED_MANAGEMENT" binary`,
        `  chmod 0755 "$STAGED_MANAGEMENT"`,
        `  STAGED_VERSION=$("$STAGED_MANAGEMENT" --version 2>&1 | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)`,
        `  supacloud_version_at_least "$STAGED_VERSION" ${quoteEnvValue(MINIMUM_COMPONENT_UPGRADE_VERSION)} || { echo 'Target Management release lacks Edge Runtime transaction capability' >&2; exit 1; }`,
        `  UPGRADE_RUNNER="$STAGED_MANAGEMENT"`,
        "fi",
    ];
}

function componentPreflightCommands(request: UpgradeRequest): string[] {
    return request.edgeRuntimeVersion ? [
        "test -f /etc/supabase/management-api.env || { echo 'EDGE_RUNTIME_MODE is unavailable; component upgrade requires external mode' >&2; exit 1; }",
        "EDGE_RUNTIME_MODE_VALUE=$(awk -F= '$1 == \"EDGE_RUNTIME_MODE\" { value=$2 } END { gsub(/^[[:space:]\\\"'\"']+|[[:space:]\\\"'\"']+$/, \"\", value); print value }' /etc/supabase/management-api.env)",
        "test \"$EDGE_RUNTIME_MODE_VALUE\" = external || { echo 'Edge Runtime component upgrade supports persisted external mode only' >&2; exit 1; }",
    ] : [];
}

export function buildRootUpgradeScript(request: UpgradeRequest): string {
    const envAssignments = upgradeEnvAssignments(request);
    return [
        "set -euo pipefail",
        "umask 077",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "export PATH",
        "unset SUPACLOUD_ALLOW_UNVERIFIED_RELEASE SUPACLOUD_GITHUB_REPOSITORY SUPACLOUD_RELEASES_API SUPACLOUD_ATTESTATION_SIGNER_WORKFLOW SUPACLOUD_GH_VERSION SUPACLOUD_GH_MIN_VERSION SUPACLOUD_GH_AMD64_SHA256 SUPACLOUD_GH_ARM64_SHA256 GH_PROXY",
        request.githubProxy ? `export SUPACLOUD_GITHUB_PROXY=${quoteEnvValue(request.githubProxy)}` : "unset SUPACLOUD_GITHUB_PROXY",
        "for tool in curl jq file sha256sum tar; do command -v \"$tool\" >/dev/null 2>&1 || { echo \"Required upgrade tool is missing: $tool\" >&2; exit 127; }; done",
        "test -x /usr/local/bin/supacloud || { echo 'SupaCloud binary not found at /usr/local/bin/supacloud; run ssh install first.' >&2; exit 127; }",
        ...componentPreflightCommands(request),
        "STAGED_MANAGEMENT=''",
        "trap 'test -z \"$STAGED_MANAGEMENT\" || rm -f \"$STAGED_MANAGEMENT\"' EXIT HUP INT TERM",
        `source ${quoteEnvValue(request.helperPath)}`,
        "if ! supacloud_attestation_verifier_available; then supacloud_install_pinned_gh /usr/local/bin/gh; fi",
        "supacloud_attestation_verifier_available || { echo 'Pinned GitHub attestation verifier is unavailable' >&2; exit 1; }",
        ...componentBootstrapCommands(request),
        `${envAssignments ? `env ${envAssignments} ` : ""}"$UPGRADE_RUNNER" upgrade --yes`,
    ].join("\n");
}

export function buildOfficialUpgradeCommand(request: UpgradeRequest): string {
    const rootScript = buildRootUpgradeScript(request);
    return `set -e; trap 'rm -f ${request.helperPath}' EXIT HUP INT TERM; ` +
        "if [ \"$(id -u)\" -eq 0 ]; then " +
        `bash -c ${quoteEnvValue(rootScript)}; ` +
        "else sudo -n true; " +
        `sudo -n bash -c ${quoteEnvValue(rootScript)}; fi`;
}

async function removeRemoteUpgradeHelper(ssh: SshTransport, helperPath: string): Promise<void> {
    const cleanup = await ssh.exec(`rm -f ${quoteEnvValue(helperPath)}`);
    if (!cleanup.success) {
        throw new Error(`Failed to remove remote upgrade helper (exit ${cleanup.code}): ${cleanup.stderr.slice(-300)}`);
    }
}

type OfficialUpgradeExecution = Awaited<ReturnType<SshTransport["exec"]>>;

function remoteUpgradeFailure(execution: OfficialUpgradeExecution): Error {
    const diagnostic = execution.stderr.trim() || execution.stdout.trim() || "no remote diagnostic";
    return new Error(`Remote upgrade failed (exit ${execution.code}): ${diagnostic.slice(-500)}`);
}

function officialUpgradeOutcome(
    execution: OfficialUpgradeExecution | undefined,
    executionError: unknown,
    cleanupError: unknown,
): OfficialUpgradeExecution {
    if (executionError && cleanupError) {
        throw new AggregateError([executionError, cleanupError], "Upgrade execution failed and helper cleanup did not complete");
    }
    if (executionError) throw executionError;
    if (!execution) throw new Error("Upgrade execution did not return a result");
    if (cleanupError && !execution.success) {
        throw new AggregateError(
            [remoteUpgradeFailure(execution), cleanupError],
            "Remote upgrade failed and helper cleanup did not complete",
        );
    }
    if (cleanupError) throw cleanupError;
    if (!execution.success) throw remoteUpgradeFailure(execution);
    return execution;
}

async function executeOfficialUpgrade(
    ssh: SshTransport,
    helperPath: string,
    command: string,
): Promise<Awaited<ReturnType<SshTransport["exec"]>>> {
    let execution: OfficialUpgradeExecution | undefined;
    let executionError: unknown;
    try {
        await ssh.uploadText(helperPath, releaseAssetsScript, 0o600);
        execution = await ssh.exec(command, 600_000);
    } catch (error: unknown) {
        executionError = error;
    }

    let cleanupError: unknown;
    try {
        await removeRemoteUpgradeHelper(ssh, helperPath);
    } catch (error: unknown) {
        cleanupError = error;
    }
    return officialUpgradeOutcome(execution, executionError, cleanupError);
}

function assertSafeGithubProxy(value: string): string {
    const trimmed = value.trim();
    if (/[\s\n\r;&|`$<>{}\[\]()*!?\\'\"]/.test(trimmed)) {
        throw new Error("Invalid github_proxy");
    }
    if (trimmed.toLowerCase() === "direct" || trimmed.toLowerCase() === "none") {
        return trimmed;
    }

    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") {
        throw new Error("Invalid github_proxy protocol: HTTPS is required");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error("Invalid github_proxy: credentials, query strings, and fragments are not allowed");
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
    const reject = (): never => {
        throw new Error("Command is outside the allowed read-only diagnostic grammar");
    };
    if (!/^[\x20-\x7e]+$/.test(trimmed) || /[\n\r;&|`$<>\\'\"()[\]{}*?!~#]/.test(trimmed)) reject();

    const tokens = trimmed.split(/\s+/);
    const commandName = tokens[0];

    if (commandName === "systemctl") {
        const action = tokens[1];
        if (["list-units", "list-unit-files"].includes(action)) {
            if (tokens.length === 2 || (tokens.length === 3 && tokens[2] === "--no-pager")) return trimmed;
            reject();
        }
        if (["status", "is-active", "is-enabled"].includes(action) && SAFE_SYSTEMD_UNIT.test(tokens[2] || "")) {
            if (tokens.length === 3 || (tokens.length === 4 && tokens[3] === "--no-pager")) return trimmed;
        }
        reject();
    }

    if (commandName === "journalctl") {
        let unit = "";
        let tailCount = "";
        let noPager = false;
        for (let index = 1; index < tokens.length; index += 1) {
            const token = tokens[index];
            if (token === "-u" && !unit) {
                unit = tokens[++index] || "";
                if (!SAFE_SYSTEMD_UNIT.test(unit)) reject();
            } else if (token === "-n" && !tailCount) {
                tailCount = tokens[++index] || "";
                const count = Number(tailCount);
                if (!/^\d+$/.test(tailCount) || count < 1 || count > 1000) reject();
            } else if (token === "--no-pager" && !noPager) {
                noPager = true;
            } else {
                reject();
            }
        }
        if (unit && tailCount && noPager) return trimmed;
        reject();
    }

    if (commandName === "docker" || commandName === "podman") {
        const action = tokens[1];
        if (action === "ps") {
            const flags = tokens.slice(2);
            if (flags.every((flag, index) => ["-a", "--no-trunc"].includes(flag) && flags.indexOf(flag) === index)) {
                return trimmed;
            }
            reject();
        }
        if (action === "logs") {
            let index = 2;
            if (tokens[index] !== "--tail") reject();
            const countToken = tokens[index + 1] || "";
            const count = Number(countToken);
            if (!/^\d+$/.test(countToken) || count < 1 || count > 1000) reject();
            index += 2;
            if (index === tokens.length - 1 && SAFE_CONTAINER_NAME.test(tokens[index] || "")) return trimmed;
            reject();
        }
        reject();
    }

    if (commandName === "ps" && trimmed === "ps -eo pid,user,comm") return trimmed;
    if (commandName === "ss" && ["ss -s", "ss -tlnp", "ss -lntp"].includes(trimmed)) return trimmed;
    if (commandName === "df" && (trimmed === "df -h" || /^df -h (?:\/|\/var|\/tmp)$/.test(trimmed))) return trimmed;
    if (commandName === "free" && ["free", "free -h", "free -m"].includes(trimmed)) return trimmed;
    if (commandName === "uname" && ["uname", "uname -a", "uname -r", "uname -m"].includes(trimmed)) return trimmed;
    if (trimmed === "cat /etc/os-release") return trimmed;
    if (commandName === "hostname" && ["hostname", "hostname -f", "hostname -I"].includes(trimmed)) return trimmed;

    if (commandName === "pg_isready") {
        const seen = new Set<string>();
        for (let index = 1; index < tokens.length; index += 2) {
            const option = tokens[index];
            const optionValue = tokens[index + 1];
            if (!optionValue || seen.has(option)) reject();
            seen.add(option);
            if (option === "-h" && !["localhost", "127.0.0.1", "::1"].includes(optionValue)) reject();
            else if (option === "-p") {
                const port = Number(optionValue);
                if (!/^\d+$/.test(optionValue) || port < 1 || port > 65535) reject();
            } else if (["-U", "-d"].includes(option)) {
                if (!SAFE_DB_IDENTIFIER.test(optionValue)) reject();
            } else if (option !== "-h") {
                reject();
            }
        }
        return trimmed;
    }

    return reject();
}

export function registerSshTools(server: { tool: (...args: any[]) => void }, ssh: SshTransport): void {
    server.tool(
        "ssh",
        `Server management via SSH. Available before & after SupaCloud installation.
Actions: ping, setup, install, upgrade, diagnose, exec, troubleshoot, container_logs, tenant_manage, tenant_list, tenant_inspect, tenant_diagnose, tenant_migrate`,
        {
            action: withDescription(stringEnum([
                "ping", "setup", "install", "upgrade", "diagnose", "exec",
                "troubleshoot", "container_logs",
                "tenant_manage", "tenant_list", "tenant_inspect", "tenant_diagnose", "tenant_migrate",
            ]), "Action to perform"),
            command: optional(Type.String(), "[exec] Restricted shell command to execute"),
            timeout_seconds: optional(Type.Number(), "[exec] Timeout in seconds (default: 60)"),
            public_domain: optional(hostnameSchema("public_domain"), "[install] API domain, e.g. api.example.com"),
            studio_domain: optional(hostnameSchema("studio_domain"), "[install] Studio domain"),
            postgres_password: optional(secretSchema("postgres_password"), "[install] DB password (auto-generated if empty)"),
            dashboard_password: optional(secretSchema("dashboard_password"), "[install] Console password"),
            edge_runtime: optional(stringEnum(["bun"]), "[install] Runtime (default: bun)"),
            storage_type: optional(stringEnum(["juicefs", "minio"]), "[install] Storage backend configurable through Admin"),
            version: optional(Type.String(), "[upgrade] Specific version"),
            edge_runtime_version: optional(Type.String(), "[upgrade] Exact independent Edge Runtime version"),
            github_proxy: optional(Type.String(), "[install/upgrade] Explicit GitHub proxy prefix, or direct/none"),
            focus: optional(stringEnum(["all", "containers", "database", "network", "disk", "logs"]), "[troubleshoot] Focus area"),
            container: optional(Type.String(), "[container_logs] Container name"),
            lines: optional(Type.Number(), "[container_logs] Number of log lines (default: 100)"),
            project_ref: optional(Type.String(), "[tenant_*] Project reference ID"),
            tenant_action: optional(stringEnum(["start", "stop", "restart", "status"]), "[tenant_manage] Action"),
            source_ref: optional(Type.String(), "[tenant_migrate] Source tenant"),
            target_ref: optional(Type.String(), "[tenant_migrate] Target tenant"),
            schemas: optional(Type.String(), "[tenant_migrate] Schemas (default: public,auth,storage)"),
            data_only: optional(Type.Boolean(), "[tenant_migrate] Data only, no structure"),
        },
        async (args: any) => {
            const { action } = args;
            let text: string;

            switch (action) {
                case "ping": {
                    const ok = await ssh.ping();
                    if (!ok) throw new Error("SSH ping failed: server returned an unexpected response");
                    text = "✅ Server reachable";
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
                    const verify = await ssh.exec("echo SSH_SESSION_OK");
                    const ok = verify.success && verify.stdout.includes("SSH_SESSION_OK");
                    text = [ok ? "✅ SSH session verified" : "❌ SSH session verification failed",
                        `Tools: ${baseTools.stdout.trim()}`,
                        `Verify: ${verify.stdout.trim() || verify.stderr.trim()}`].join("\n");
                    break;
                }
                case "install": {
                    if (!args.public_domain) throw new Error("'public_domain' required");
                    const installId = randomUUID();
                    const DIR = "/opt/supacloud";
                    const LOG = `/var/log/supacloud/install-${installId}.log`;
                    const STATUS = `/var/log/supacloud/install-${installId}.status`;
                    const CONFIG = "/etc/supabase/install.env";
                    const INPUT = `/etc/supabase/.install-input-${installId}.env`;
                    const BOOTSTRAP = `/opt/.supacloud-bootstrap-${installId}`;
                    const REPO = "https://github.com/zuohuadong/supacloud.git";
                    const configuredProxy = args.github_proxy ? assertSafeGithubProxy(args.github_proxy) : "direct";
                    const proxyDisabled = ["direct", "none"].includes(configuredProxy.toLowerCase());
                    const proxyPrefix = proxyDisabled ? "" : (configuredProxy.endsWith("/") ? configuredProxy : `${configuredProxy}/`);
                    const bootstrapClone = `git clone --depth 1 --branch main ${quoteEnvValue(REPO)} ${quoteEnvValue(BOOTSTRAP)}`;
                    const bootstrapDeps = await ssh.exec(
                        `set -e; ` +
                        `if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then ` +
                            `if command -v apt-get >/dev/null 2>&1; then ` +
                                `apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates; ` +
                            `elif command -v dnf >/dev/null 2>&1; then ` +
                                `dnf install -y git curl ca-certificates; ` +
                            `elif command -v yum >/dev/null 2>&1; then ` +
                                `yum install -y git curl ca-certificates; ` +
                            `else echo 'No supported package manager can install git and curl' >&2; exit 127; fi; ` +
                        `fi; ` +
                        `command -v git >/dev/null 2>&1; command -v curl >/dev/null 2>&1; ` +
                        `echo BOOTSTRAP_DEPS_OK`,
                        180_000,
                    );
                    if (!bootstrapDeps.success || !bootstrapDeps.stdout.includes("BOOTSTRAP_DEPS_OK")) {
                        text = `❌ Bootstrap dependency preparation failed\n${bootstrapDeps.stderr.slice(-500)}`;
                        break;
                    }
                    const osCheck = await ssh.exec("cat /etc/os-release | grep -E 'NAME|VERSION_ID' | head -4");
                    const clone = await ssh.exec(
                        `set -e; umask 077; rm -rf ${quoteEnvValue(BOOTSTRAP)}; ` +
                        `${bootstrapClone}; ` +
                        `git -C ${quoteEnvValue(BOOTSTRAP)} remote set-url origin ${quoteEnvValue(REPO)}; ` +
                        `test "$(git -C ${quoteEnvValue(BOOTSTRAP)} remote get-url origin)" = ${quoteEnvValue(REPO)}; ` +
                        `test "$(git -C ${quoteEnvValue(BOOTSTRAP)} symbolic-ref --short HEAD)" = main; ` +
                        `test -z "$(git -C ${quoteEnvValue(BOOTSTRAP)} status --porcelain --untracked-files=no)"; ` +
                        `git -C ${quoteEnvValue(BOOTSTRAP)} ls-files --error-unmatch setup.sh scripts/lib/install_config.sh scripts/lib/release_assets.sh >/dev/null; ` +
                        `test -f ${quoteEnvValue(`${BOOTSTRAP}/setup.sh`)}; echo BOOTSTRAP_OK`,
                        120_000,
                    );
                    if (!clone.stdout.includes("BOOTSTRAP_OK")) {
                        await ssh.exec(`rm -rf ${quoteEnvValue(BOOTSTRAP)}`);
                        text = `❌ Trusted bootstrap clone failed\n${clone.stderr.slice(-500)}`;
                        break;
                    }
                    const prepareProtectedPaths = await ssh.exec(
                        `umask 077; install -d -m 700 /etc/supabase /var/log/supacloud; ` +
                        `: > ${quoteEnvValue(LOG)}; : > ${quoteEnvValue(STATUS)}; ` +
                        `chmod 600 ${quoteEnvValue(LOG)} ${quoteEnvValue(STATUS)}`,
                    );
                    if (!prepareProtectedPaths.success) {
                        await ssh.exec(`rm -rf ${quoteEnvValue(BOOTSTRAP)}`);
                        text = `❌ Unable to prepare protected install input and log paths\n${prepareProtectedPaths.stderr.slice(-500)}`;
                        break;
                    }
                    const envLines = [
                        `SUPABASE_PUBLIC_DOMAIN=${quoteEnvValue(args.public_domain)}`,
                        args.studio_domain ? `SUPABASE_STUDIO_DOMAIN=${quoteEnvValue(args.studio_domain)}` : "",
                        args.edge_runtime ? `EDGE_RUNTIME=${quoteEnvValue(args.edge_runtime)}` : "",
                        args.storage_type ? `S3_STORAGE_TYPE=${quoteEnvValue(args.storage_type)}` : "",
                        args.postgres_password ? `POSTGRES_PASSWORD=${quoteEnvValue(args.postgres_password)}` : "",
                        args.dashboard_password ? `DASHBOARD_PASSWORD=${quoteEnvValue(args.dashboard_password)}` : "",
                    ].filter(Boolean).join("\n");
                    try {
                        await ssh.uploadText(INPUT, `${envLines}\n`, 0o600);
                    } catch (error) {
                        await ssh.exec(`rm -f ${quoteEnvValue(INPUT)}; rm -rf ${quoteEnvValue(BOOTSTRAP)}`);
                        throw error;
                    }
                    const setupEnv = [
                        `SUPACLOUD_INSTALL_DIR=${quoteEnvValue(DIR)}`,
                        "SUPACLOUD_SETUP_ARTIFACT_MODE=release",
                        "SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS=true",
                        `SUPACLOUD_SETUP_INPUT_FILE=${quoteEnvValue(INPUT)}`,
                        `SUPACLOUD_INSTALL_CONFIG_FILE=${quoteEnvValue(CONFIG)}`,
                        proxyPrefix ? `SUPACLOUD_GITHUB_PROXY=${quoteEnvValue(configuredProxy)}` : "",
                    ].filter(Boolean).join(" ");
                    const statusNext = `${STATUS}.next`;
                    const backgroundScript = [
                        "set +e",
                        `trap "rm -f ${quoteEnvValue(INPUT)}; rm -rf ${quoteEnvValue(BOOTSTRAP)}" EXIT`,
                        `printf 'RUNNING\\n' > ${quoteEnvValue(statusNext)}`,
                        `chmod 600 ${quoteEnvValue(statusNext)}`,
                        `mv -f ${quoteEnvValue(statusNext)} ${quoteEnvValue(STATUS)}`,
                        `env ${setupEnv} bash ${quoteEnvValue(`${BOOTSTRAP}/setup.sh`)}`,
                        "INSTALL_CODE=$?",
                        `if [ "$INSTALL_CODE" -eq 0 ]; then printf 'SUCCEEDED\\n' > ${quoteEnvValue(statusNext)}; ` +
                            `else printf 'FAILED:%s\\n' "$INSTALL_CODE" > ${quoteEnvValue(statusNext)}; fi`,
                        `chmod 600 ${quoteEnvValue(statusNext)}`,
                        `mv -f ${quoteEnvValue(statusNext)} ${quoteEnvValue(STATUS)}`,
                        "exit \"$INSTALL_CODE\"",
                    ].join("; ");
                    const result = await ssh.exec(
                        `umask 077; nohup bash -c ${quoteEnvValue(backgroundScript)} > ${quoteEnvValue(LOG)} 2>&1 </dev/null & ` +
                        `INSTALL_PID=$!; sleep 5; ` +
                        `INSTALL_STATE=$(sed -n '1p' ${quoteEnvValue(STATUS)} 2>/dev/null || true); ` +
                        `case "$INSTALL_STATE" in ` +
                        `RUNNING) if kill -0 "$INSTALL_PID" 2>/dev/null; then echo "INSTALL_STARTED pid=$INSTALL_PID"; ` +
                            `else wait "$INSTALL_PID" 2>/dev/null; INSTALL_CODE=$?; ` +
                            `echo "INSTALL_FAILED code=$INSTALL_CODE state=$INSTALL_STATE"; exit 1; fi ;; ` +
                        `SUCCEEDED) echo "INSTALL_COMPLETED pid=$INSTALL_PID" ;; ` +
                        `FAILED:*) INSTALL_CODE=$(printf '%s' "$INSTALL_STATE" | cut -d: -f2); ` +
                            `echo "INSTALL_FAILED code=$INSTALL_CODE"; exit 1 ;; ` +
                        `*) echo "INSTALL_FAILED code=unknown state=$INSTALL_STATE"; exit 1 ;; esac`,
                        30_000,
                    );
                    const installAccepted = result.stdout.includes("INSTALL_STARTED") || result.stdout.includes("INSTALL_COMPLETED");
                    text = installAccepted
                        ? `✅ Installation started\nOS: ${osCheck.stdout.trim()}\n${result.stdout.trim()}\nLog: ${LOG}\nStatus: ${STATUS}\n⏱ ~15-30 min`
                        : `❌ Start failed\n${result.stdout.slice(-500)}\n${result.stderr.slice(-500)}`;
                    break;
                }
                case "upgrade": {
                    const version = args.version ? assertSafeReleaseTag(args.version) : undefined;
                    const edgeRuntimeVersion = args.edge_runtime_version
                        ? assertSafeReleaseTag(args.edge_runtime_version)
                        : undefined;
                    if (edgeRuntimeVersion && !version) {
                        throw new Error("'version' is required with 'edge_runtime_version'");
                    }
                    if (edgeRuntimeVersion && version) {
                        assertExactStableVersion(version, "version");
                        assertExactStableVersion(edgeRuntimeVersion, "edge_runtime_version");
                    }
                    const validatedProxy = args.github_proxy ? assertSafeGithubProxy(args.github_proxy) : undefined;
                    const githubProxy = validatedProxy && !["direct", "none"].includes(validatedProxy.toLowerCase())
                        ? validatedProxy
                        : undefined;
                    const helperPath = `/tmp/.supacloud-release-assets-${randomUUID()}.sh`;
                    const cmd = buildOfficialUpgradeCommand({
                        version,
                        edgeRuntimeVersion,
                        githubProxy,
                        helperPath,
                    });
                    const upgradeExecution = await executeOfficialUpgrade(ssh, helperPath, cmd);
                    const edgeBoundary = edgeRuntimeVersion ? "" : "\n⚠️ Edge Runtime was not upgraded; provide --edge_runtime_version for a component transaction.";
                    text = `✅ Upgrade done\n${upgradeExecution.stdout.slice(-300)}${edgeBoundary}`;
                    break;
                }
                case "diagnose": {
                    const cmds = [
                        "echo '=== OS ===' && uname -a",
                        "echo '=== Memory ===' && free -h",
                        "echo '=== Disk ===' && df -h /",
                        "echo '=== Docker ===' && (docker ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || echo 'Not found')",
                        "echo '=== PostgreSQL ===' && (pg_isready 2>/dev/null && echo 'Running' || echo 'Not detected')",
                        "echo '=== Management API ===' && (curl -sf http://localhost:9090/health > /dev/null && echo 'Running' || echo 'Not running')",
                    ];
                    const r = await ssh.exec(cmds.join(" && "));
                    text = r.stdout || r.stderr;
                    break;
                }
                case "exec": {
                    if (!args.command) throw new Error("'command' required");
                    const command = assertSafeExecCommand(args.command);
                    const r = await ssh.exec(command, getExecTimeoutMs(args.timeout_seconds));
                    if (!r.success) {
                        const diagnostic = (r.stderr || r.stdout).trim() || "no remote diagnostic";
                        throw new Error(`Remote diagnostic command failed (exit ${r.code}): ${diagnostic.slice(-500)}`);
                    }
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
                        "(latest_log=$(find /var/log/supacloud -maxdepth 1 -type f -name 'install-*.log' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-); [ -n \"$latest_log\" ] && tail -50 \"$latest_log\" || echo 'Not found')",
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
                    const r = await ssh.exec([
                        "set -eu",
                        "found=0",
                        `for file in /etc/supabase/tenants/${projectRef}.env /etc/supabase/tenants/${projectRef}_gotrue.env; do`,
                        "  [ -f \"$file\" ] || continue",
                        "  found=1",
                        "  printf '\n# %s\n' \"$(basename \"$file\")\"",
                        `  ${REMOTE_ENV_REDACTION_AWK} "$file"`,
                        "done",
                        "[ \"$found\" -eq 1 ] || { echo 'Tenant config not found' >&2; exit 1; }",
                    ].join("\n"), 10_000);
                    const output = redactTenantConfig(r.stdout || r.stderr);
                    text = r.success
                        ? `📄 ${projectRef} tenant config (sensitive values redacted):\n${output}`
                        : `❌ Unable to inspect ${projectRef}:\n${output}`;
                    break;
                }
                case "tenant_diagnose": {
                    const checks = [
                        "echo '══════ Multi-tenant Diagnostic ══════'",
                        "ps -eo pid=,user=,comm= | grep -E 'postgrest|gotrue' | grep -v grep || echo 'No processes'",
                        "systemctl list-units 'supacloud-pgrst@*' 'supacloud-gotrue@*' --no-pager 2>/dev/null || echo 'N/A'",
                        "ls -l /etc/supabase/tenants/*.env 2>/dev/null || echo 'No config'",
                    ];
                    if (args.project_ref) {
                        const projectRef = assertSafeProjectRef(args.project_ref, "project_ref");
                        checks.push(
                            `systemctl status supacloud-pgrst@${projectRef} --no-pager 2>/dev/null || echo 'Not found'`,
                            `for file in /etc/supabase/tenants/${projectRef}.env /etc/supabase/tenants/${projectRef}_gotrue.env; do [ -f "$file" ] && ${REMOTE_ENV_REDACTION_AWK} "$file"; done`,
                        );
                    }
                    const r = await ssh.exec(checks.join("\n"), 30_000);
                    text = redactTenantConfig(r.stdout || r.stderr);
                    break;
                }
                case "tenant_migrate": {
                    if (!args.source_ref || !args.target_ref) throw new Error("'source_ref' and 'target_ref' required");
                    const sourceRef = assertSafeProjectRef(args.source_ref, "source_ref");
                    const targetRef = assertSafeProjectRef(args.target_ref, "target_ref");
                    if (sourceRef === targetRef) throw new Error("source_ref and target_ref must be different");
                    const s = args.schemas || "public,auth,storage";
                    const schemas = s.split(",").map((x: string) => x.trim()).filter(Boolean);
                    if (schemas.length === 0) throw new Error("At least one schema is required");
                    // 逐项按 PostgreSQL 标识符规则校验：\s 允许换行会把 "public\nreboot"
                    // 这类输入拆成独立的远程 shell 命令
                    for (const schema of schemas) {
                        if (!SAFE_SCHEMA_IDENTIFIER.test(schema)) {
                            throw new Error(`Invalid schema identifier: ${JSON.stringify(schema)}`);
                        }
                    }
                    const schemaArgs = schemas.map((schema: string) => `-n '${schema}'`).join(" ");
                    const df = args.data_only ? "--data-only" : "";
                    const cmd = [
                        "set -euo pipefail",
                        "umask 077",
                        "tmp_dir=\"$(mktemp -d /tmp/supacloud-migrate.XXXXXX)\"",
                        "dump_file=\"$tmp_dir/tenant.dump\"",
                        "trap 'rm -rf \"$tmp_dir\"' EXIT HUP INT TERM",
                        `echo 'Migrating: supa_${sourceRef} → supa_${targetRef}'`,
                        `pg_dump -h localhost -U postgres -d supa_${sourceRef} ${schemaArgs} ${df} -Fc -f "$dump_file"`,
                        `pg_restore -h localhost -U postgres -d supa_${targetRef} --no-owner --no-acl --exit-on-error "$dump_file"`,
                        "echo 'Migration complete'",
                    ].join("\n");
                    const r = await ssh.exec(cmd, 600_000);
                    text = r.success
                        ? `✅ Migration done\n${r.stdout}`
                        : `❌ Migration failed (exit ${r.code})\n${r.stdout}\n${r.stderr.slice(-1000)}`;
                    break;
                }
                default:
                    text = `❌ Unknown action: ${action}`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
