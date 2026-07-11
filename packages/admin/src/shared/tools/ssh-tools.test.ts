import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { registerSshTools } from "./ssh-tools";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

class FakeSsh {
    readonly commands: string[] = [];
    readonly uploads: Array<{ remotePath: string; content: string; mode: number }> = [];
    tenantInspectOutput = "";
    migrationFails = false;
    installEarlyFails = false;
    bootstrapDepsFail = false;
    bootstrapCloneFail = false;

    async ping(): Promise<boolean> {
        return true;
    }

    async exec(command: string): Promise<{ success: boolean; stdout: string; stderr: string; code: number }> {
        this.commands.push(command);
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
        this.uploads.push({ remotePath, content, mode });
    }
}

function captureSshTool(ssh: FakeSsh): {
    parse: (args: Record<string, unknown>) => Record<string, unknown>;
    invoke: (args: Record<string, unknown>) => ReturnType<ToolHandler>;
} {
    let schema: Record<string, z.ZodType> | undefined;
    let handler: ToolHandler | undefined;
    const server = {
        tool: (
            _name: string,
            _description: string,
            toolSchema: Record<string, z.ZodType>,
            toolHandler: ToolHandler,
        ) => {
            schema = toolSchema;
            handler = toolHandler;
        },
    };

    registerSshTools(server, ssh as never);
    if (!schema || !handler) throw new Error("ssh tool was not registered");
    const validator = z.object(schema).strict();

    return {
        parse: (args) => validator.parse(args),
        invoke: (args) => handler!(validator.parse(args)),
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
        const tool = captureSshTool(new FakeSsh());

        for (const github_proxy of [
            "http://proxy.example.com/",
            "https://user:password@proxy.example.com/",
            "https://proxy.example.com/?target=evil",
            "https://proxy.example.com/#fragment",
        ]) {
            await expect(tool.invoke({ action: "upgrade", github_proxy })).rejects.toThrow("Invalid github_proxy");
        }
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
});
