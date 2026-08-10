import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildOfficialUpgradeCommand, buildRootUpgradeScript, registerSshTools } from "./ssh-tools";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";
import {
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME,
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL,
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256,
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SIZE,
} from "../../../../management-api/src/sigstore-trusted-root";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

class FakeSsh {
    readonly commands: string[] = [];
    readonly timeouts: Array<number | undefined> = [];
    readonly uploads: Array<{ remotePath: string; content: string; mode: number }> = [];
    tenantInspectOutput = "";
    migrationFails = false;
    installEarlyFails = false;
    bootstrapDepsFail = false;
    bootstrapCloneFail = false;
    upgradeExecThrows = false;
    upgradeExecRejection: { value: unknown } | undefined;
    upgradeExecFails = false;
    cleanupExecFails = false;
    cleanupExecRejection: { value: unknown } | undefined;
    uploadThrows = false;
    partialUploadThrows = false;
    pingResult = true;
    diagnosticExecFails = false;
    diagnosticFailureStdout = "";
    diagnosticFailureStderr = "diagnostic failed";

    async ping(): Promise<boolean> {
        return this.pingResult;
    }

    async exec(command: string, timeoutMs?: number): Promise<{ success: boolean; stdout: string; stderr: string; code: number }> {
        this.commands.push(command);
        this.timeouts.push(timeoutMs);
        if (this.upgradeExecThrows && command.includes("UPGRADE_RUNNER")) {
            throw new Error("connection dropped");
        }
        if (this.upgradeExecRejection && command.includes("UPGRADE_RUNNER")) {
            throw this.upgradeExecRejection.value;
        }
        if (this.upgradeExecFails && command.includes("UPGRADE_RUNNER")) {
            return { success: false, stdout: "", stderr: "transaction failed", code: 42 };
        }
        if (this.cleanupExecFails && command.includes("sudo -n rm -rf -- '/tmp/.supacloud-release-assets-")) {
            return { success: false, stdout: "", stderr: "permission denied", code: 1 };
        }
        if (this.cleanupExecRejection && command.includes("sudo -n rm -rf -- '/tmp/.supacloud-release-assets-")) {
            throw this.cleanupExecRejection.value;
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
        if (this.diagnosticExecFails && command === "hostname") {
            return {
                success: false,
                stdout: this.diagnosticFailureStdout,
                stderr: this.diagnosticFailureStderr,
                code: 3,
            };
        }
        return { success: true, stdout: "SSH_SESSION_OK\n", stderr: "", code: 0 };
    }

    async uploadText(remotePath: string, content: string, mode = 0o600): Promise<void> {
        if (this.uploadThrows) throw new Error("upload failed");
        this.uploads.push({ remotePath, content, mode });
        if (this.partialUploadThrows) throw new Error("partial upload failed");
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

const UPGRADE_SIGNALS = ["HUP", "INT", "TERM"] as const;
const RELEASE_ASSETS_SCRIPT = join(import.meta.dir, "../../../../../scripts/lib/release_assets.sh");

function writeExecutableShell(filePath: string, shellSource: string): void {
    writeFileSync(filePath, shellSource);
    chmodSync(filePath, 0o755);
}

function writeFakeGh(filePath: string, version: string): void {
    writeExecutableShell(filePath, [
        "#!/bin/sh",
        `if [ \"$1\" = \"--version\" ]; then echo \"gh version ${version}\"; exit 0; fi`,
        "if [ \"$1 $2 $3\" = \"attestation verify --help\" ]; then echo '--bundle --signer-workflow --source-ref --custom-trusted-root --deny-self-hosted-runners'; exit 0; fi",
        "exit 1",
        "",
    ].join("\n"));
}

function linkHostCommand(commandDir: string, commandName: string): void {
    const commandPath = Bun.which(commandName);
    if (!commandPath) throw new Error(`Required test command is unavailable: ${commandName}`);
    symlinkSync(commandPath, join(commandDir, commandName));
}

function rootScriptThroughProxySetup(rootScript: string): string {
    const scriptLines = rootScript.split("\n");
    const proxySetupIndex = scriptLines.findIndex(line => line.includes("SUPACLOUD_GITHUB_PROXY"));
    if (proxySetupIndex < 0) throw new Error("Root upgrade script lacks GitHub proxy setup");
    return scriptLines.slice(0, proxySetupIndex + 1).join("\n");
}

function rootScriptThroughHelperSource(rootScript: string, continuationPath: string): string {
    const scriptLines = rootScript.split("\n");
    const stagedSetupIndex = scriptLines.indexOf("STAGED_MANAGEMENT=''");
    const helperSourceIndex = scriptLines.findIndex(line => line.startsWith("source "));
    if (stagedSetupIndex < 0 || helperSourceIndex < stagedSetupIndex) {
        throw new Error("Root upgrade script lacks staged Management setup");
    }
    return [scriptLines[0], ...scriptLines.slice(stagedSetupIndex, helperSourceIndex + 1),
        `touch '${continuationPath}'`].join("\n");
}

function rootScriptThroughBootstrap(rootScript: string, continuationPath: string): string {
    const scriptLines = rootScript.split("\n");
    const stagedSetupIndex = scriptLines.indexOf("STAGED_MANAGEMENT=''");
    const stagedRunnerIndex = scriptLines.indexOf('  UPGRADE_RUNNER="$STAGED_MANAGEMENT"');
    const bootstrapEndIndex = scriptLines.indexOf("fi", stagedRunnerIndex);
    if (stagedSetupIndex < 0 || stagedRunnerIndex < stagedSetupIndex || bootstrapEndIndex < stagedRunnerIndex) {
        throw new Error("Root upgrade script lacks Management bootstrap boundaries");
    }
    return [scriptLines[0], ...scriptLines.slice(stagedSetupIndex, bootstrapEndIndex + 1),
        `touch '${continuationPath}'`].join("\n");
}

function rootScriptVerifierBootstrap(rootScript: string): string {
    const scriptLines = rootScript.split("\n");
    const securityUnsetIndex = scriptLines.findIndex(line => line.startsWith("unset SUPACLOUD_ALLOW_UNVERIFIED_RELEASE"));
    const proxySetupIndex = scriptLines.findIndex(line => line.includes("SUPACLOUD_GITHUB_PROXY"));
    const helperSourceIndex = scriptLines.findIndex(line => line.startsWith("source "));
    const verifierGateIndex = scriptLines.findIndex(line => line.startsWith("supacloud_attestation_verifier_available ||"));
    if ([securityUnsetIndex, proxySetupIndex, helperSourceIndex, verifierGateIndex].some(index => index < 0)) {
        throw new Error("Root upgrade script lacks verifier bootstrap boundaries");
    }
    return [scriptLines[0], ...scriptLines.slice(securityUnsetIndex, proxySetupIndex + 1),
        ...scriptLines.slice(helperSourceIndex, verifierGateIndex + 1)].join("\n");
}

function trustedRootPreflightScript(rootScript: string): string {
    const scriptLines = rootScript.split("\n");
    const start = scriptLines.findIndex(line => line.startsWith("HELPER_DIRECTORY="));
    const end = scriptLines.findIndex(line => line === "export SUPACLOUD_ATTESTATION_TRUSTED_ROOT=\"$TRUSTED_ROOT\"");
    if (start < 0 || end < start) throw new Error("Root upgrade script lacks trusted-root preflight boundaries");
    return scriptLines.slice(start, end + 1).join("\n");
}

describe("ssh admin tool", () => {
    test("ping fails instead of returning a successful process result", async () => {
        const ssh = new FakeSsh();
        ssh.pingResult = false;

        await expect(captureSshTool(ssh).invoke({ action: "ping" }))
            .rejects.toThrow("SSH ping failed");
    });

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
            "hostname -I",
        ]) {
            const result = await tool.invoke({ action: "exec", command });
            expect(result.content[0]?.text).toContain("exit: 0");
        }
    });

    test("generic exec propagates a remote diagnostic failure", async () => {
        const ssh = new FakeSsh();
        ssh.diagnosticExecFails = true;

        await expect(captureSshTool(ssh).invoke({ action: "exec", command: "hostname" }))
            .rejects.toThrow("Remote diagnostic command failed (exit 3): diagnostic failed");
    });

    test("generic exec uses stdout when failure stderr contains only whitespace", async () => {
        const ssh = new FakeSsh();
        ssh.diagnosticExecFails = true;
        ssh.diagnosticFailureStdout = "stdout diagnostic";
        ssh.diagnosticFailureStderr = " \n";

        await expect(captureSshTool(ssh).invoke({ action: "exec", command: "hostname" }))
            .rejects.toThrow("Remote diagnostic command failed (exit 3): stdout diagnostic");
    });

    test("hostname address diagnostics require the exact allowlisted command", async () => {
        const tool = captureSshTool(new FakeSsh());

        for (const command of [
            "hostname -I extra",
            "hostname -Ifoo",
            "hostname -I; id",
            "hostname -I\nid",
        ]) {
            await expect(tool.invoke({ action: "exec", command }))
                .rejects.toThrow("outside the allowed read-only diagnostic grammar");
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

    test("local artifact transport requires two exact versions before remote access", async () => {
        for (const args of [
            { action: "upgrade", artifact_transport: "local" },
            { action: "upgrade", artifact_transport: "local", version: "0.50.30" },
            { action: "upgrade", artifact_transport: "local", version: "latest", edge_runtime_version: "0.16.8" },
        ]) {
            const ssh = new FakeSsh();
            await expect(captureSshTool(ssh).invoke(args)).rejects.toThrow();
            expect(ssh.uploads).toHaveLength(0);
            expect(ssh.commands).toHaveLength(0);
        }
    });

    test("local artifact transport refuses third-party GitHub proxies", async () => {
        const ssh = new FakeSsh();
        await expect(captureSshTool(ssh).invoke({
            action: "upgrade",
            artifact_transport: "local",
            version: "0.50.30",
            edge_runtime_version: "0.16.8",
            github_proxy: "https://proxy.example.com/",
        })).rejects.toThrow("only supports direct GitHub downloads");
        expect(ssh.uploads).toHaveLength(0);
        expect(ssh.commands).toHaveLength(0);
    });

    test("artifact transport schema accepts only local or remote", () => {
        const tool = captureSshTool(new FakeSsh());
        expect(tool.parse({ action: "upgrade", artifact_transport: "local" }).artifact_transport).toBe("local");
        expect(tool.parse({ action: "upgrade", artifact_transport: "remote" }).artifact_transport).toBe("remote");
        expect(() => tool.parse({ action: "upgrade", artifact_transport: "automatic" })).toThrow();
    });

    test("remote artifact transport uses the host-wide upgrade lock", () => {
        const rootScript = buildRootUpgradeScript({ helperPath: "/tmp/release-assets.sh" });

        expect(rootScript).toContain("/run/lock/supacloud-upgrade.lock");
        expect(rootScript).toContain("flock -E 75 -n 9");
        expect(rootScript).toContain("Another SupaCloud upgrade is already running");
    });

    test("remote trusted-root adoption rejects missing, altered, linked, and permissive files", () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), "supacloud-admin-remote-root-"));
        const helperPath = join(fixtureRoot, "release_assets.sh");
        const trustedRootPath = join(fixtureRoot, SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME);
        const symlinkTarget = `${fixtureRoot}.outside.jsonl`;
        writeFileSync(helperPath, "fixture", { mode: 0o600 });
        chmodSync(fixtureRoot, 0o700);
        const preflight = trustedRootPreflightScript(buildRootUpgradeScript({ helperPath }));
        const fixtureCommands = [
            "stat() { case \"$2\" in '%a') if [ \"$3\" = \"$HELPER_PATH\" ]; then printf '600\\n'; elif [ \"$3\" = \"$HELPER_DIRECTORY\" ]; then printf '700\\n'; else printf '%s\\n' \"$ROOT_MODE\"; fi ;; '%h') printf '1\\n' ;; '%s') wc -c < \"$3\" | tr -d '[:space:]' ;; '%u:%g:%a:%h') printf '0:0:%s:1\\n' \"$ROOT_MODE\" ;; *) return 1 ;; esac; }",
            "find() { for entry in \"$1\"/*; do test -e \"$entry\" || test -L \"$entry\" || continue; basename \"$entry\"; done; }",
            "chown() { return 0; }",
        ];
        const runPreflight = (rootMode = "600") => Bun.spawnSync({
            cmd: ["bash", "-c", ["set -euo pipefail", ...fixtureCommands, preflight].join("\n")],
            env: { ...process.env, HELPER_PATH: helperPath, ROOT_MODE: rootMode },
        }).exitCode;
        try {
            expect(runPreflight()).not.toBe(0);

            writeFileSync(trustedRootPath, SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL, { mode: 0o600 });
            expect(runPreflight()).toBe(0);
            expect(runPreflight("644")).not.toBe(0);

            writeFileSync(trustedRootPath, `${SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL} `);
            expect(runPreflight()).not.toBe(0);

            rmSync(trustedRootPath);
            writeFileSync(symlinkTarget, SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL, { mode: 0o600 });
            symlinkSync(symlinkTarget, trustedRootPath);
            expect(runPreflight()).not.toBe(0);
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
            rmSync(symlinkTarget, { force: true });
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

    test("direct proxy mode clears singular and plural remote proxy fallbacks", async () => {
        const ssh = new FakeSsh();
        await captureSshTool(ssh).invoke({ action: "upgrade", github_proxy: "direct" });
        const upgradeCommand = ssh.commands.find((command) => command.includes("UPGRADE_RUNNER")) ?? "";
        expect(upgradeCommand).toContain("unset SUPACLOUD_GITHUB_PROXY");
        expect(upgradeCommand).toContain("SUPACLOUD_GITHUB_PROXIES");
        expect(upgradeCommand).not.toContain("SUPACLOUD_GITHUB_PROXY='direct'");

        const rootScript = buildRootUpgradeScript({ helperPath: "/tmp/release-assets.sh" });
        const proxyProbe = [rootScriptThroughProxySetup(rootScript),
            "test -z \"${SUPACLOUD_GITHUB_PROXIES+x}\""].join("\n");
        const execution = Bun.spawnSync(["/bin/bash", "-c", proxyProbe], {
            env: { ...process.env, SUPACLOUD_GITHUB_PROXIES: "https://fallback.example.test" },
        });
        expect(execution.exitCode).toBe(0);
    });

    test("explicit upgrade proxy leaves time for direct-first and proxy transfer budgets", async () => {
        const ssh = new FakeSsh();
        await captureSshTool(ssh).invoke({
            action: "upgrade",
            version: "0.50.29",
            github_proxy: "https://proxy.example.test/",
        });

        expect(ssh.timeouts).toEqual([30_000, 1_320_000, 30_000]);
    });

    test("outer upgrade signals remove the helper and stop command continuation", () => {
        for (const upgradeSignal of UPGRADE_SIGNALS) {
            const fixtureDir = mkdtempSync(join(tmpdir(), "supacloud-admin-outer-signal-"));
            const commandDir = join(fixtureDir, "bin");
            const helperPath = join(fixtureDir, "release-assets.sh");
            const continuationPath = join(fixtureDir, "continued");
            mkdirSync(commandDir);
            try {
                writeExecutableShell(join(commandDir, "id"), "#!/bin/sh\nprintf '0\\n'\n");
                writeExecutableShell(join(commandDir, "bash"),
                    `#!/bin/sh\nkill -${upgradeSignal} \"$PPID\"\nexit 0\n`);
                writeFileSync(helperPath, "fixture");
                const command = `${buildOfficialUpgradeCommand({ helperPath })}; touch '${continuationPath}'`;
                const execution = Bun.spawnSync(["/bin/bash", "-c", command], {
                    env: { ...process.env, PATH: `${commandDir}:${process.env.PATH ?? ""}` },
                });
                expect(execution.exitCode).not.toBe(0);
                expect(existsSync(helperPath)).toBe(false);
                expect(existsSync(continuationPath)).toBe(false);
            } finally {
                rmSync(fixtureDir, { recursive: true, force: true });
            }
        }
    }, { timeout: 15_000 });

    test("staged Management signals remove the binary and stop script continuation", () => {
        for (const upgradeSignal of UPGRADE_SIGNALS) {
            const fixtureDir = mkdtempSync(join(tmpdir(), "supacloud-admin-staged-signal-"));
            const helperPath = join(fixtureDir, "release-assets.sh");
            const stagedManagementPath = join(fixtureDir, "staged-management");
            const continuationPath = join(fixtureDir, "continued");
            const helperContinuationPath = join(fixtureDir, "helper-continued");
            try {
                writeFileSync(stagedManagementPath, "fixture");
                writeFileSync(helperPath, [
                    `STAGED_MANAGEMENT='${stagedManagementPath}'`,
                    `kill -${upgradeSignal} \"$$\"`,
                    `touch '${helperContinuationPath}'`,
                ].join("\n"));
                const rootScript = buildRootUpgradeScript({ helperPath });
                const execution = Bun.spawnSync(["/bin/bash", "-c",
                    rootScriptThroughHelperSource(rootScript, continuationPath)]);
                expect(execution.exitCode).not.toBe(0);
                expect(existsSync(stagedManagementPath)).toBe(false);
                expect(existsSync(helperContinuationPath)).toBe(false);
                expect(existsSync(continuationPath)).toBe(false);
            } finally {
                rmSync(fixtureDir, { recursive: true, force: true });
            }
        }
    });

    test("failed Management bootstrap removes the staged binary and stops continuation", async () => {
        const fixtureDir = mkdtempSync(join(tmpdir(), "supacloud-admin-bootstrap-failure-"));
        const helperPath = join(fixtureDir, "release-assets.sh");
        const stagedPathRecord = join(fixtureDir, "staged-path");
        const continuationPath = join(fixtureDir, "continued");
        try {
            writeFileSync(helperPath, [
                "supacloud_attestation_trusted_root_available() { return 0; }",
                "supacloud_attestation_verifier_available() { return 0; }",
                "supacloud_version_at_least() { return 1; }",
                "supacloud_fetch_component_release() { printf '%s\\n' '{}'; }",
                "supacloud_download_release_asset() {",
                "  printf '%s\\n' \"$3\" > \"$STAGED_PATH_RECORD\"",
                "  printf '%s\\n' partial > \"$3\"",
                "  return 28",
                "}",
            ].join("\n"));
            const rootScript = buildRootUpgradeScript({
                version: "0.50.29",
                edgeRuntimeVersion: "0.16.7",
                helperPath,
            });
            const execution = Bun.spawnSync(["/bin/bash", "-c",
                rootScriptThroughBootstrap(rootScript, continuationPath)], {
                env: { ...process.env, STAGED_PATH_RECORD: stagedPathRecord },
            });

            expect(execution.exitCode).not.toBe(0);
            const stagedPath = (await Bun.file(stagedPathRecord).text()).trim();
            expect(existsSync(stagedPath)).toBe(false);
            expect(existsSync(continuationPath)).toBe(false);
        } finally {
            rmSync(fixtureDir, { recursive: true, force: true });
        }
    });

    test("missing and outdated gh are replaced through the pinned verifier bootstrap", async () => {
        for (const initialGhVersion of [null, "2.50.9"] as const) {
            const fixtureDir = mkdtempSync(join(tmpdir(), "supacloud-admin-gh-bootstrap-"));
            const currentBinDir = join(fixtureDir, "current-bin");
            const legacyBinDir = join(fixtureDir, "legacy-bin");
            const commandDir = join(fixtureDir, "command-bin");
            const helperPath = join(fixtureDir, "release-assets-wrapper.sh");
            const installTargetRecord = join(fixtureDir, "install-target");
            const pinnedGhSource = join(fixtureDir, "pinned-gh");
            mkdirSync(currentBinDir);
            mkdirSync(legacyBinDir);
            mkdirSync(commandDir);
            try {
                for (const commandName of ["awk", "dirname", "grep", "head", "install", "jq", "sha256sum", "tr", "wc"]) {
                    linkHostCommand(commandDir, commandName);
                }
                if (initialGhVersion) writeFakeGh(join(legacyBinDir, "gh"), initialGhVersion);
                writeFakeGh(pinnedGhSource, "2.96.0");
                writeFileSync(helperPath, [
                    `source '${RELEASE_ASSETS_SCRIPT}'`,
                    "test -z \"${SUPACLOUD_ALLOW_UNVERIFIED_RELEASE+x}\" || return 91",
                    "supacloud_install_pinned_gh() {",
                    `  printf '%s\\n' \"$1\" > '${installTargetRecord}'`,
                    `  install -m 0755 '${pinnedGhSource}' '${currentBinDir}/gh'`,
                    "}",
                ].join("\n"));
                const rootScript = buildRootUpgradeScript({ helperPath });
                const execution = Bun.spawnSync(["/bin/bash", "-c", rootScriptVerifierBootstrap(rootScript)], {
                    env: {
                        ...process.env,
                        PATH: `${currentBinDir}:${legacyBinDir}:${commandDir}`,
                        SUPACLOUD_ALLOW_UNVERIFIED_RELEASE: "true",
                    },
                });
                expect(execution.exitCode).toBe(0);
                await expect(Bun.file(installTargetRecord).text()).resolves.toBe("/usr/local/bin/gh\n");
            } finally {
                rmSync(fixtureDir, { recursive: true, force: true });
            }
        }
    });

    test("component upgrade bootstraps pinned verification and one capable transaction", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        await tool.invoke({ action: "upgrade", version: "0.50.27", edge_runtime_version: "0.16.7" });

        expect(ssh.commands).toHaveLength(3);
        const command = ssh.commands[1] ?? "";
        expect(command).toContain("sudo -n true");
        expect(ssh.uploads).toHaveLength(2);
        expect(ssh.uploads[0]?.remotePath).toMatch(/^\/tmp\/\.supacloud-release-assets-[0-9a-f-]+\/release_assets\.sh$/);
        expect(ssh.uploads[0]?.mode).toBe(0o600);
        expect(ssh.uploads[0]?.content).toContain("supacloud_install_pinned_gh");
        expect(ssh.uploads[0]?.content).toContain('SUPACLOUD_GH_VERSION="${SUPACLOUD_GH_VERSION:-2.96.0}"');
        expect(ssh.uploads[0]?.content).toContain("83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60");
        expect(ssh.uploads[0]?.content).toContain("06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909");
        expect(ssh.uploads[0]?.content).toContain('bundle_dir=$(mktemp -d "${TMPDIR:-/tmp}/supacloud-attestation.XXXXXX")');
        expect(ssh.uploads[0]?.content).toContain('bundle_file="${bundle_dir}/bundle.jsonl"');
        expect(ssh.uploads[0]?.content).toContain('trap \'rm -rf -- "$bundle_dir"\' EXIT');
        expect(ssh.uploads[0]?.content).toContain('trap \'trap - EXIT HUP INT TERM; rm -rf -- "$bundle_dir"; exit 1\' HUP INT TERM');
        const trustedRootUpload = ssh.uploads[1];
        expect(trustedRootUpload?.remotePath).toBe(
            `${dirname(ssh.uploads[0]?.remotePath ?? "")}/${SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME}`,
        );
        expect(trustedRootUpload?.mode).toBe(0o600);
        expect(Buffer.byteLength(trustedRootUpload?.content ?? "")).toBe(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SIZE);
        expect(createHash("sha256").update(trustedRootUpload?.content ?? "").digest("hex"))
            .toBe(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256);
        expect(command).toContain("supacloud_install_pinned_gh");
        expect(command).toContain("/usr/local/bin/supacloud --version");
        expect(command).toContain("0.50.27");
        expect(command).toContain("supacloud_fetch_component_release");
        expect(command).toContain("supacloud_download_release_asset");
        expect(command).toContain('chmod 0755 "$STAGED_MANAGEMENT"');
        expect(command).toContain("SUPACLOUD_EDGE_RUNTIME_UPGRADE_TAG=");
        expect(command).toContain("unset SUPACLOUD_ALLOW_UNVERIFIED_RELEASE");
        expect(command).toContain("SUPACLOUD_ATTESTATION_TRUSTED_ROOT");
        expect(command).toContain("Pinned trusted root must use mode 0600");
        expect(command).toContain("supacloud_attestation_trusted_root_available");
        expect(command).not.toContain("/opt/supacloud/scripts");
        expect(command).toContain("rm -rf --");
        expect(command).toContain("/tmp/.supacloud-release-assets-");
        expect(command).not.toMatch(/\/usr\/local\/bin\/supacloud upgrade --yes/);
        const rootScript = buildRootUpgradeScript({
            version: "0.50.27",
            edgeRuntimeVersion: "0.16.7",
            helperPath: ssh.uploads[0]?.remotePath ?? "",
        });
        expect(rootScript).toContain("stat -c '%u:%g:%a:%h'");
        expect(Bun.spawnSync(["bash", "-n", "-c", rootScript]).exitCode).toBe(0);
        expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
        expect(ssh.commands[0]).toMatch(/^set -e; umask 077; mkdir -m 700 -- '\/tmp\/\.supacloud-release-assets-[0-9a-f-]+'$/);
        expect(ssh.commands[0]).not.toContain("test ! -e");
        expect(ssh.commands[0]).not.toContain("install -d");
        expect(ssh.commands[2]).toContain(`rm -rf -- '${ssh.uploads[0]?.remotePath.replace(/\/release_assets\.sh$/, "")}'`);
        expect(ssh.commands[2]).toContain("sudo -n rm -rf --");
        expect(ssh.timeouts).toEqual([30_000, 720_000, 30_000]);
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

        expect(ssh.uploads).toHaveLength(2);
        expect(ssh.commands.at(-1)).toContain(`rm -rf -- '${ssh.uploads[0]?.remotePath.replace(/\/release_assets\.sh$/, "")}'`);
    });

    test("stages the sudo helper in a private user directory and cleans that directory with fallback privilege", async () => {
        const ssh = new FakeSsh();

        await captureSshTool(ssh).invoke({ action: "upgrade", version: "0.50.30" });

        const helperPath = ssh.uploads[0]?.remotePath ?? "";
        const helperDirectory = dirname(helperPath);
        expect(helperPath).toBe(`${helperDirectory}/release_assets.sh`);
        expect(ssh.commands[0]).toContain(`mkdir -m 700 -- '${helperDirectory}'`);
        expect(buildRootUpgradeScript({ helperPath })).toContain(`source '${helperPath}'`);
        expect(ssh.commands[1]).toContain(helperDirectory);
        expect(ssh.commands[1]).toContain("rm -rf --");
        expect(ssh.commands[2]).toContain(`rm -rf -- '${helperDirectory}' || sudo -n rm -rf -- '${helperDirectory}'`);
    });

    test("failed helper upload still cleans its generated remote path", async () => {
        const ssh = new FakeSsh();
        ssh.uploadThrows = true;

        await expect(captureSshTool(ssh).invoke({ action: "upgrade", version: "0.50.27" }))
            .rejects.toThrow("upload failed");
        expect(ssh.uploads).toHaveLength(0);
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands[0]).toContain("mkdir -m 700 -- '/tmp/.supacloud-release-assets-");
        expect(ssh.commands[1]).toContain("sudo -n rm -rf -- '/tmp/.supacloud-release-assets-");
    });

    test("partial helper upload cleans the exact remote path", async () => {
        const ssh = new FakeSsh();
        ssh.partialUploadThrows = true;

        await expect(captureSshTool(ssh).invoke({ action: "upgrade", version: "0.50.27" }))
            .rejects.toThrow("partial upload failed");
        expect(ssh.uploads).toHaveLength(1);
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.at(-1)).toContain(`rm -rf -- '${ssh.uploads[0]?.remotePath.replace(/\/release_assets\.sh$/, "")}'`);
    });

    test("partial upload and helper cleanup failures preserve both diagnostics", async () => {
        const ssh = new FakeSsh();
        ssh.partialUploadThrows = true;
        ssh.cleanupExecFails = true;

        let failure: unknown;
        try {
            await captureSshTool(ssh).invoke({ action: "upgrade", version: "0.50.27" });
        } catch (error: unknown) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(AggregateError);
        const diagnostics = (failure as AggregateError).errors.map(candidate => String(candidate));
        expect(diagnostics.some(message => message.includes("partial upload failed"))).toBe(true);
        expect(diagnostics.some(message => message.includes("Failed to remove remote upgrade helper"))).toBe(true);
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

    test("preserves falsy upgrade and helper cleanup rejections", async () => {
        for (const rejection of [undefined, null, false, 0, ""]) {
            const ssh = new FakeSsh();
            ssh.upgradeExecRejection = { value: rejection };
            let rejected = false;
            try {
                await captureSshTool(ssh).invoke({ action: "upgrade", version: "0.50.27" });
            } catch (error: unknown) {
                rejected = true;
                expect(error).toBe(rejection);
            }
            expect(rejected).toBe(true);
        }

        const cleanupOnly = new FakeSsh();
        cleanupOnly.cleanupExecRejection = { value: 0 };
        let cleanupRejected = false;
        try {
            await captureSshTool(cleanupOnly).invoke({ action: "upgrade", version: "0.50.27" });
        } catch (error: unknown) {
            cleanupRejected = true;
            expect(error).toBe(0);
        }
        expect(cleanupRejected).toBe(true);

        const combined = new FakeSsh();
        combined.upgradeExecRejection = { value: false };
        combined.cleanupExecRejection = { value: 0 };
        let combinedFailure: unknown;
        try {
            await captureSshTool(combined).invoke({ action: "upgrade", version: "0.50.27" });
        } catch (error: unknown) {
            combinedFailure = error;
        }
        expect(combinedFailure).toBeInstanceOf(AggregateError);
        expect((combinedFailure as AggregateError).errors).toEqual([false, 0]);
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
        expect(commands).toContain("packages/management-api/src/assets/sigstore-public-good-trusted-root.jsonl");
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
