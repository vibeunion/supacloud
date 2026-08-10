import { describe, expect, test } from "bun:test";

import { registerSshTools } from "./ssh-tools";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

class FakeSsh {
    readonly commands: string[] = [];
    readonly uploads: Array<{ remotePath: string; content: string; mode: number }> = [];
    tenantInspectOutput = "";
    migrationFails = false;
    installEarlyFails = false;
    bootstrapDepsFail = false;
    bootstrapCloneFail = false;
    upgradeExecThrows = false;
    upgradeExecFails = false;
    cleanupExecFails = false;
    uploadThrows = false;

    async ping(): Promise<boolean> {
        return true;
    }

    async exec(command: string): Promise<{ success: boolean; stdout: string; stderr: string; code: number }> {
        this.commands.push(command);
        if (this.upgradeExecThrows && command.includes("UPGRADE_RUNNER")) {
            throw new Error("connection dropped");
        }
        if (this.upgradeExecFails && command.includes("UPGRADE_RUNNER")) {
            return { success: false, stdout: "", stderr: "transaction failed", code: 42 };
        }
        if (this.cleanupExecFails && command.startsWith("rm -f '/tmp/.supacloud-release-assets-")) {
            return { success: false, stdout: "", stderr: "permission denied", code: 1 };
        }
        if (command.includes("BOOTSTRAP_DEPS_OK")) {
            if (this.bootstrapDepsFail) {
                return { success: false, stdout: "", stderr: "package install failed", code: 1 };
            }
            return { success: true, stdout: "BOOTSTRAP_DEPS_OK\n", stderr: "", code: 0 };
        }
        if (command.includes("BOOTSTRAP_OK")) {
            if (this.bootstrapCloneFail) {
                return { success: false, stdout: "", stderr: "official GitHub clone failed", code: 1 };
            }
            return { success: true, stdout: "BOOTSTRAP_OK\n", stderr: "", code: 0 };
        }
        if (command.includes("INSTALL_STARTED")) {
            if (this.installEarlyFails) {
                return { success: false, stdout: "INSTALL_FAILED code=42\n", stderr: "bootstrap failed", code: 1 };
            }
            return { success: true, stdout: "INSTALL_STARTED pid=42\n", stderr: "", code: 0 };
        }
        if (command.includes("/etc/supabase/tenants/") && !command.includes("pg_dump")) {
            return { success: true, stdout: this.tenantInspectOutput, stderr: "", code: 0 };
        }
        if (command.includes("pg_dump")) {
            return this.migrationFails
                ? { success: false, stdout: "", stderr: "restore failed", code: 1 }
                : { success: true, stdout: "Migration complete\n", stderr: "", code: 0 };
        }
        return { success: true, stdout: "SSH_SESSION_OK\n", stderr: "", code: 0 };
    }

    async uploadText(remotePath: string, content: string, mode = 0o600): Promise<void> {
        if (this.uploadThrows) throw new Error("upload failed");
        this.uploads.push({ remotePath, content, mode });
    }
}

function captureSshTool(ssh: FakeSsh): {
    parse: (args: Record<string, unknown>) => Record<string, unknown>;
    invoke: (args: Record<string, unknown>) => ReturnType<ToolHandler>;
} {
    let schema: ToolSchema | undefined;
    let handler: ToolHandler | undefined;
    const server = {
        tool: (
            _name: string,
            _description: string,
            toolSchema: ToolSchema,
            toolHandler: ToolHandler,
        ) => {
            schema = toolSchema;
            handler = toolHandler;
        },
    };

    registerSshTools(server, ssh as never);
    if (!schema || !handler) throw new Error("ssh tool was not registered");
    const registeredSchema = schema;
    return {
        parse: (args) => parseToolArguments(registeredSchema, args),
        invoke: (args) => handler!(parseToolArguments(registeredSchema, args)),
    };
}

describe("ssh admin tool", () => {
    test("setup verifies the active SSH session without weakening sshd", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        const result = await tool.invoke({ action: "setup" });
        const commands = ssh.commands.join("\n");

        expect(result.content[0]?.text).toContain("SSH session verified");
        expect(commands).not.toContain("sshd_config");
        expect(commands).not.toContain("PermitRootLogin");
        expect(commands).not.toContain("StrictHostKeyChecking=no");
    });

    test("generic exec accepts only structured read-only diagnostics", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        for (const command of [
            "systemctl status supacloud.service --no-pager",
            "journalctl -u supacloud.service -n 100 --no-pager",
            "docker ps -a",
            "podman logs --tail 50 api-1",
            "ps -eo pid,user,comm",
            "ss -tlnp",
            "df -h /",
            "free -h",
            "uname -a",
            "cat /etc/os-release",
            "pg_isready -h localhost -p 5432",
            "hostname -f",
        ]) {
            const result = await tool.invoke({ action: "exec", command });
            expect(result.content[0]?.text).toContain("exit: 0");
        }
    });

    test("generic exec rejects filesystem, network, mutation, and secret-reading escapes", async () => {
        const tool = captureSshTool(new FakeSsh());

        for (const command of [
            "find / -delete",
            "find / -exec id ;",
            "curl file:///etc/shadow",
            "cat /etc/shadow",
            "systemctl restart supacloud.service",
            "journalctl -u supacloud.service --output-fields=MESSAGE",
            "journalctl -u supacloud.service --no-pager",
            "docker logs api-1",
            "podman logs api-1",
            "ps aux",
            "ps -ef",
            "docker logs --tail 50 ../../etc/shadow",
            "df -h /etc",
        ]) {
            await expect(tool.invoke({ action: "exec", command })).rejects.toThrow("outside the allowed read-only diagnostic grammar");
        }
    });

    test("upgrade proxy rejects URL credentials, query strings, and fragments", async () => {
        for (const github_proxy of [
            "http://proxy.example.com/",
            "https://user:password@proxy.example.com/",
            "https://proxy.example.com/?target=evil",
            "https://proxy.example.com/#fragment",
        ]) {
            const ssh = new FakeSsh();
            const tool = captureSshTool(ssh);
            await expect(tool.invoke({ action: "upgrade", github_proxy })).rejects.toThrow("Invalid github_proxy");
            expect(ssh.uploads).toHaveLength(0);
            expect(ssh.commands).toHaveLength(0);
        }
    });

    test("component upgrade validates both exact versions before upload", async () => {
        for (const args of [
            { action: "upgrade", version: "0.50.27;id", edge_runtime_version: "0.16.7" },
            { action: "upgrade", version: "0.50.27", edge_runtime_version: "0.16.7;id" },
            { action: "upgrade", edge_runtime_version: "0.16.7" },
            { action: "upgrade", version: "latest", edge_runtime_version: "0.16.7" },
            { action: "upgrade", version: "0.50.27", edge_runtime_version: "latest" },
        ]) {
            const ssh = new FakeSsh();
            await expect(captureSshTool(ssh).invoke(args)).rejects.toThrow();
            expect(ssh.uploads).toHaveLength(0);
            expect(ssh.commands).toHaveLength(0);
        }
    });

    test("direct proxy mode is represented by an unset helper proxy", async () => {
        const ssh = new FakeSsh();
        await captureSshTool(ssh).invoke({ action: "upgrade", github_proxy: "direct" });
        expect(ssh.commands[0]).toContain("unset SUPACLOUD_GITHUB_PROXY");
        expect(ssh.commands[0]).not.toContain("SUPACLOUD_GITHUB_PROXY='direct'");
    });

    test("component upgrade bootstraps pinned verification and one capable transaction", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        await tool.invoke({ action: "upgrade", version: "0.50.27", edge_runtime_version: "0.16.7" });

        expect(ssh.commands).toHaveLength(2);
        const command = ssh.commands[0] ?? "";
        expect(command).toContain("sudo -n true");
        expect(ssh.uploads).toHaveLength(1);
        expect(ssh.uploads[0]?.remotePath).toMatch(/^\/tmp\/\.supacloud-release-assets-[0-9a-f-]+\.sh$/);
        expect(ssh.uploads[0]?.mode).toBe(0o600);
        expect(ssh.uploads[0]?.content).toContain("supacloud_install_pinned_gh");
        expect(ssh.uploads[0]?.content).toContain('SUPACLOUD_GH_VERSION="${SUPACLOUD_GH_VERSION:-2.96.0}"');
        expect(ssh.uploads[0]?.content).toContain("83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60");
        expect(ssh.uploads[0]?.content).toContain("06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909");
        expect(command).toContain("supacloud_install_pinned_gh");
        expect(command).toContain("/usr/local/bin/supacloud --version");
        expect(command).toContain("0.50.27");
        expect(command).toContain("supacloud_fetch_component_release");
        expect(command).toContain("supacloud_download_release_asset");
        expect(command).toContain('chmod 0755 "$STAGED_MANAGEMENT"');
        expect(command).toContain("SUPACLOUD_EDGE_RUNTIME_UPGRADE_TAG=");
        expect(command).toContain("unset SUPACLOUD_ALLOW_UNVERIFIED_RELEASE");
        expect(command).not.toContain("/opt/supacloud/scripts");
        expect(command).toContain("trap 'rm -f /tmp/.supacloud-release-assets-");
        expect(command).not.toMatch(/\/usr\/local\/bin\/supacloud upgrade --yes/);
        expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
        expect(ssh.commands[1]).toBe(`rm -f '${ssh.uploads[0]?.remotePath}'`);
    });

    test("component upgrade cleans its exact helper path when SSH execution throws", async () => {
        const ssh = new FakeSsh();
        ssh.upgradeExecThrows = true;
        const tool = captureSshTool(ssh);

        await expect(tool.invoke({
            action: "upgrade",
            version: "0.50.27",
            edge_runtime_version: "0.16.7",
        })).rejects.toThrow("connection dropped");

        expect(ssh.uploads).toHaveLength(1);
        expect(ssh.commands.at(-1)).toBe(`rm -f '${ssh.uploads[0]?.remotePath}'`);
    });

    test("failed helper upload does not issue cleanup for a path that was never created", async () => {
        const ssh = new FakeSsh();
        ssh.uploadThrows = true;

        await expect(captureSshTool(ssh).invoke({ action: "upgrade", version: "0.50.27" }))
            .rejects.toThrow("upload failed");
        expect(ssh.uploads).toHaveLength(0);
        expect(ssh.commands).toHaveLength(0);
    });

    test("helper cleanup failures are reported instead of swallowed", async () => {
        const ssh = new FakeSsh();
        ssh.cleanupExecFails = true;

        await expect(captureSshTool(ssh).invoke({ action: "upgrade", version: "0.50.27" }))
            .rejects.toThrow("Failed to remove remote upgrade helper");
    });

    test("remote and helper cleanup failures preserve both diagnostics", async () => {
        const ssh = new FakeSsh();
        ssh.upgradeExecFails = true;
        ssh.cleanupExecFails = true;

        let failure: unknown;
        try {
            await captureSshTool(ssh).invoke({ action: "upgrade", version: "0.50.27" });
        } catch (error: unknown) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(AggregateError);
        const diagnostics = (failure as AggregateError).errors.map(candidate => String(candidate));
        expect(diagnostics.some(message => message.includes("exit 42") && message.includes("transaction failed"))).toBe(true);
        expect(diagnostics.some(message => message.includes("Failed to remove remote upgrade helper"))).toBe(true);
    });

    test("remote upgrade failures reach the CLI error boundary", async () => {
        const ssh = new FakeSsh();
        ssh.upgradeExecFails = true;

        await expect(captureSshTool(ssh).invoke({ action: "upgrade", version: "0.50.27" }))
            .rejects.toThrow("Remote upgrade failed (exit 42): transaction failed");
    });

    test("Management-only upgrade reports that Edge Runtime is unchanged", async () => {
        const tool = captureSshTool(new FakeSsh());
        const result = await tool.invoke({ action: "upgrade", version: "0.50.27" });
        expect(result.content[0]?.text).toContain("Edge Runtime was not upgraded");
    });

    test("install rejects unsafe hostnames and control characters in secrets", () => {
        const tool = captureSshTool(new FakeSsh());

        expect(() => tool.parse({
            action: "install",
            public_domain: "api.example.com\nENVEOF\nid",
        })).toThrow("Invalid public_domain");
        expect(() => tool.parse({
            action: "install",
            public_domain: "api.example.com",
            postgres_password: "safe-prefix\nleaked",
        })).toThrow("Invalid postgres_password");
    });

    test("install exposes only storage backends implemented by install.sh", () => {
        const tool = captureSshTool(new FakeSsh());

        for (const storage_type of ["minio", "juicefs"]) {
            expect(tool.parse({
                action: "install",
                public_domain: "api.example.com",
                storage_type,
            }).storage_type).toBe(storage_type);
        }
        for (const storage_type of ["garage", "rustfs", "external"]) {
            expect(() => tool.parse({
                action: "install",
                public_domain: "api.example.com",
                storage_type,
            })).toThrow();
        }
    });

    test("install bootstraps the minimal Git and curl dependencies before cloning", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        await tool.invoke({
            action: "install",
            public_domain: "api.example.com",
        });

        const dependencyIndex = ssh.commands.findIndex(command => command.includes("BOOTSTRAP_DEPS_OK"));
        const cloneIndex = ssh.commands.findIndex(command => command.includes("BOOTSTRAP_OK"));
        expect(dependencyIndex).toBeGreaterThanOrEqual(0);
        expect(cloneIndex).toBeGreaterThan(dependencyIndex);
        const dependencyCommand = ssh.commands[dependencyIndex] ?? "";
        expect(dependencyCommand).toContain("command -v git");
        expect(dependencyCommand).toContain("command -v curl");
        expect(dependencyCommand).toContain("apt-get install -y git curl ca-certificates");
        expect(dependencyCommand).toContain("dnf install -y git curl ca-certificates");
        expect(dependencyCommand).toContain("yum install -y git curl ca-certificates");
    });

    test("install fails closed before cloning when bootstrap dependencies cannot be prepared", async () => {
        const ssh = new FakeSsh();
        ssh.bootstrapDepsFail = true;
        const tool = captureSshTool(ssh);

        const result = await tool.invoke({
            action: "install",
            public_domain: "api.example.com",
        });

        expect(result.content[0]?.text).toContain("Bootstrap dependency preparation failed");
        expect(ssh.commands.some(command => command.includes("BOOTSTRAP_OK"))).toBe(false);
        expect(ssh.uploads).toHaveLength(0);
    });

    test("install uploads protected input and starts the trusted setup Release path", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        const result = await tool.invoke({
            action: "install",
            public_domain: "api.example.com",
            studio_domain: "studio.example.com",
            postgres_password: "correct-horse-battery-staple",
            dashboard_password: "another-long-secret",
        });

        expect(result.content[0]?.text).toContain("Installation started");
        expect(result.content[0]?.text).toMatch(/Log: \/var\/log\/supacloud\/install-[0-9a-f-]+\.log/);
        expect(ssh.uploads).toHaveLength(1);
        expect(ssh.uploads[0]?.remotePath).toMatch(/^\/etc\/supabase\/\.install-input-[0-9a-f-]+\.env$/);
        expect(ssh.uploads[0]?.mode).toBe(0o600);
        expect(ssh.uploads[0]?.content).toContain("POSTGRES_PASSWORD='correct-horse-battery-staple'");
        expect(ssh.uploads[0]?.content).not.toContain("EDGE_RUNTIME=");
        expect(ssh.uploads[0]?.content).not.toContain("S3_STORAGE_TYPE=");

        const commands = ssh.commands.join("\n");
        expect(commands).not.toContain("correct-horse-battery-staple");
        expect(commands).not.toContain("cat > /opt/supacloud/config.env");
        expect(commands).toContain("install -d -m 700 /etc/supabase /var/log/supacloud");
        expect(commands).toMatch(/chmod 600 '\/var\/log\/supacloud\/install-[0-9a-f-]+\.log' '\/var\/log\/supacloud\/install-[0-9a-f-]+\.status'/);
        expect(commands).not.toContain("/tmp/supacloud-install.log");
        expect(commands).not.toContain("supacloud_atomic_merge_env /etc/supabase/install.env");
        expect(commands).not.toContain("source /opt/supacloud/scripts/lib/install_config.sh");
        expect(commands).toContain("rm -f");
        expect(commands).toMatch(/\/etc\/supabase\/\.install-input-[0-9a-f-]+\.env/);
        expect(commands).not.toContain("supacloud_atomic_merge_env /opt/supacloud/config.env");
        const cloneCommand = ssh.commands.find(command => command.includes("BOOTSTRAP_OK")) ?? "";
        expect(cloneCommand).toContain("https://github.com/zuohuadong/supacloud.git");
        expect(cloneCommand).not.toContain("ghproxy.net");
        expect(cloneCommand).toMatch(/\/opt\/\.supacloud-bootstrap-[0-9a-f-]+/);
        expect(cloneCommand).toContain("remote set-url origin");
        expect(cloneCommand).toContain("BOOTSTRAP_OK");

        const launchCommand = ssh.commands.find(command => command.includes("INSTALL_STARTED"));
        expect(launchCommand).toBeDefined();
        expect(launchCommand).toContain("SUPACLOUD_SETUP_ARTIFACT_MODE=release");
        expect(launchCommand).toContain("SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS=true");
        expect(launchCommand).toMatch(/SUPACLOUD_INSTALL_DIR=.*\/opt\/supacloud/);
        expect(launchCommand).toContain("SUPACLOUD_SETUP_INPUT_FILE=");
        expect(launchCommand).toMatch(/\/etc\/supabase\/\.install-input-[0-9a-f-]+\.env/);
        expect(launchCommand).toMatch(/\/opt\/\.supacloud-bootstrap-[0-9a-f-]+\/setup\.sh/);
        expect(launchCommand).not.toContain("/opt/supacloud/install.sh");
        expect(launchCommand).not.toContain("SUPACLOUD_SETUP_ARTIFACT_MODE=local");
        expect(launchCommand).toContain("INSTALL_STATE");
        expect(launchCommand).toContain("FAILED:*");
        const syntax = Bun.spawnSync(["bash", "-n", "-c", launchCommand!]);
        expect(syntax.exitCode).toBe(0);
        const encodedScriptStart = launchCommand!.indexOf("nohup bash -c ") + "nohup bash -c ".length;
        const encodedScriptEnd = launchCommand!.indexOf(" > '/var/log/supacloud/install-", encodedScriptStart);
        expect(encodedScriptEnd).toBeGreaterThan(encodedScriptStart);
        const encodedScript = launchCommand!.slice(encodedScriptStart, encodedScriptEnd);
        const decodedScript = Bun.spawnSync(["bash", "-c", `printf '%s' ${encodedScript}`]);
        expect(decodedScript.exitCode).toBe(0);
        const innerSyntax = Bun.spawnSync(["bash", "-n", "-c", decodedScript.stdout.toString()]);
        expect(innerSyntax.exitCode).toBe(0);
    });

    test("install never wraps root bootstrap source with a proxy and forwards HTTPS proxy only to verified assets", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        await tool.invoke({
            action: "install",
            public_domain: "api.example.com",
            github_proxy: "https://proxy.example.com/",
        });

        const cloneCommand = ssh.commands.find(command => command.includes("BOOTSTRAP_OK")) ?? "";
        const directIndex = cloneCommand.indexOf("https://github.com/zuohuadong/supacloud.git");
        const proxyIndex = cloneCommand.indexOf("https://proxy.example.com/https://github.com/zuohuadong/supacloud.git");
        expect(directIndex).toBeGreaterThanOrEqual(0);
        expect(proxyIndex).toBe(-1);
        expect(cloneCommand).toContain("remote set-url origin");
        const launchCommand = ssh.commands.find(command => command.includes("INSTALL_STARTED")) ?? "";
        expect(launchCommand).toContain("SUPACLOUD_GITHUB_PROXY=");
        expect(launchCommand).toContain("https://proxy.example.com/");
    });

    test("install fails closed when the official GitHub bootstrap source is unavailable", async () => {
        const ssh = new FakeSsh();
        ssh.bootstrapCloneFail = true;
        const tool = captureSshTool(ssh);

        const result = await tool.invoke({
            action: "install",
            public_domain: "api.example.com",
            github_proxy: "https://proxy.example.com/",
        });

        const output = result.content[0]?.text ?? "";
        const cloneCommand = ssh.commands.find(command => command.includes("BOOTSTRAP_OK")) ?? "";
        expect(output).toContain("Trusted bootstrap clone failed");
        expect(cloneCommand).not.toContain("https://proxy.example.com/");
        expect(ssh.uploads).toHaveLength(0);
        expect(ssh.commands.some(command => command.includes("INSTALL_STARTED"))).toBe(false);
    });

    test("install reports an immediate background setup failure instead of trusting kill -0", async () => {
        const ssh = new FakeSsh();
        ssh.installEarlyFails = true;
        const tool = captureSshTool(ssh);

        const result = await tool.invoke({
            action: "install",
            public_domain: "api.example.com",
        });
        const output = result.content[0]?.text ?? "";
        const launchCommand = ssh.commands.find(command => command.includes("INSTALL_STARTED")) ?? "";

        expect(output).toContain("Start failed");
        expect(output).not.toContain("Installation started");
        expect(launchCommand).toContain("INSTALL_STATE");
        expect(launchCommand).toContain("INSTALL_FAILED code=");
    });

    test("troubleshoot tails the newest unique protected install log", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        await tool.invoke({ action: "troubleshoot", focus: "logs" });
        const command = ssh.commands.at(-1) ?? "";

        expect(command).toContain("/var/log/supacloud");
        expect(command).toContain("install-*.log");
        expect(command).toContain("sort -nr");
        expect(command).not.toContain("/var/log/supacloud-install.log");
        expect(command).not.toContain("/tmp/supacloud-install.log");
    });

    test("diagnose probes the unauthenticated Management API health endpoint", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        await tool.invoke({ action: "diagnose" });
        const command = ssh.commands.at(-1) ?? "";

        expect(command).toContain("http://localhost:9090/health");
        expect(command).not.toContain("http://localhost:9090/v1/projects");
    });

    test("tenant inspection redacts credentials even if the remote output contains them", async () => {
        const ssh = new FakeSsh();
        ssh.tenantInspectOutput = [
            "PGRST_SERVER_PORT=3101",
            "PGRST_JWT_SECRET=raw-jwt-secret",
            "PGRST_DB_URI=postgres://user:database-password@localhost/db",
            "API_EXTERNAL_URL=https://api.example.com",
        ].join("\n");
        const tool = captureSshTool(ssh);

        const result = await tool.invoke({ action: "tenant_inspect", project_ref: "abc123" });
        const output = result.content[0]?.text ?? "";

        expect(output).toContain("PGRST_SERVER_PORT=3101");
        expect(output).toContain("PGRST_JWT_SECRET=[REDACTED]");
        expect(output).toContain("PGRST_DB_URI=[REDACTED]");
        expect(output).not.toContain("raw-jwt-secret");
        expect(output).not.toContain("database-password");
    });

    test("tenant diagnosis uses the complete redaction path before returning output", async () => {
        const ssh = new FakeSsh();
        ssh.tenantInspectOutput = [
            "PGRST_SERVER_PORT=3101",
            "PGRST_JWT_SECRET=raw-jwt-secret",
            "postgres://authenticator:database/pa:ssword@localhost/tenant",
            "GOTRUE_DB_DATABASE_URL=postgres://admin:another-password@localhost/tenant",
        ].join("\n");
        const tool = captureSshTool(ssh);

        const result = await tool.invoke({ action: "tenant_diagnose", project_ref: "abc123" });
        const output = result.content[0]?.text ?? "";
        const command = ssh.commands.at(-1) ?? "";

        expect(command).toContain("awk -F=");
        expect(command).not.toContain("grep -v PASSWORD");
        expect(command).not.toContain("ps aux");
        expect(output).toContain("PGRST_SERVER_PORT=3101");
        expect(output).toContain("PGRST_JWT_SECRET=[REDACTED]");
        expect(output).not.toContain("raw-jwt-secret");
        expect(output).not.toContain("database/pa:ssword");
        expect(output).not.toContain("another-password");
    });

    test("tenant migration uses a unique protected dump and propagates restore failures", async () => {
        const ssh = new FakeSsh();
        ssh.migrationFails = true;
        const tool = captureSshTool(ssh);

        const result = await tool.invoke({
            action: "tenant_migrate",
            source_ref: "source1",
            target_ref: "target1",
            schemas: "public,auth",
        });
        const command = ssh.commands.find(candidate => candidate.includes("pg_dump")) ?? "";
        const output = result.content[0]?.text ?? "";

        expect(command).toContain("set -euo pipefail");
        expect(command).toContain("mktemp -d");
        expect(command).toContain("--exit-on-error");
        expect(command).not.toContain("/tmp/migrate.dump");
        expect(command).not.toContain("|| true");
        expect(output).toContain("Migration failed");
        expect(output).not.toContain("Migration done");
    });

    test("tenant migration rejects schema lists containing shell metacharacters or newlines", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        for (const schemas of ["public\nreboot\npublic", "public;drop", "public$(id)", "pub lic", "public,'auth"]) {
            await expect(tool.invoke({
                action: "tenant_migrate",
                source_ref: "source1",
                target_ref: "target1",
                schemas,
            })).rejects.toThrow(/Invalid schema identifier/);
        }
        // 注入载荷从未进入远程命令流
        expect(ssh.commands.join("\n")).not.toContain("reboot");
    });

    test("tenant migration quotes validated schema identifiers", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        await tool.invoke({
            action: "tenant_migrate",
            source_ref: "source1",
            target_ref: "target1",
            schemas: "public, auth, tenant_data",
        });
        const command = ssh.commands.find(candidate => candidate.includes("pg_dump")) ?? "";
        expect(command).toContain("-n 'public' -n 'auth' -n 'tenant_data'");
    });
});
