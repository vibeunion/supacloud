import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
    chmodSync,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildOfficialUpgradeCommand, buildRootUpgradeScript, registerSshTools } from "./ssh-tools";
import { formatCliError } from "../cli";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";
import { SshCommandOutcomeUnknownError, SshTransport } from "../transports/ssh";
import {
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME,
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL,
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256,
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SIZE,
} from "../../../../management-api/src/sigstore-trusted-root";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}>;
type FakeExecResult = { success: boolean; stdout: string; stderr: string; code: number };
type FakeExecPlan = { fragment: string; executions: FakeExecResult[]; calls: number };
type UpgradeTransportOutcome = "late_success" | "stream_error";

const TEST_SSH_HOST_FINGERPRINT = `SHA256:${Buffer.alloc(32, 7).toString("base64").replace(/=+$/, "")}`;

class UpgradeTransportClient extends EventEmitter {
    endCalls = 0;
    terminalCloseEmitted = false;

    constructor(private readonly outcome: UpgradeTransportOutcome) {
        super();
    }

    connect(): this {
        queueMicrotask(() => this.emit("ready"));
        return this;
    }

    exec(_command: string, callback: (error: Error | undefined, stream: EventEmitter & { stderr: EventEmitter }) => void): void {
        const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        stream.stderr = new EventEmitter();
        callback(undefined, stream);
        if (this.outcome === "stream_error") {
            queueMicrotask(() => stream.emit("error", new Error("TOKEN=stream-secret")));
            return;
        }
        setTimeout(() => {
            this.terminalCloseEmitted = true;
            stream.emit("close", 0);
        }, 20);
    }

    end(): void {
        this.endCalls += 1;
    }
}

class FakeSsh {
    readonly commands: string[] = [];
    readonly timeouts: Array<number | undefined> = [];
    readonly uploads: Array<{ remotePath: string; content: string; mode: number }> = [];
    tenantInspectOutput = "";
    migrationFails = false;
    installEarlyFails = false;
    bootstrapDepsFail = false;
    bootstrapCloneFail = false;
    prepareExecOutcomeUnknown = false;
    upgradeTransportOutcome: UpgradeTransportOutcome | undefined;
    upgradeTransportClient: UpgradeTransportClient | undefined;
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
    probeExecRejection: { value: unknown } | undefined;
    readonly matchingExecResults: FakeExecPlan[] = [];

    async ping(): Promise<boolean> {
        return this.pingResult;
    }

    async exec(command: string, timeoutMs?: number): Promise<{ success: boolean; stdout: string; stderr: string; code: number }> {
        this.commands.push(command);
        this.timeouts.push(timeoutMs);
        const fixedPlan = this.matchingExecResults.find(candidate => command.includes(candidate.fragment));
        if (fixedPlan) {
            const executionIndex = Math.min(fixedPlan.calls, fixedPlan.executions.length - 1);
            fixedPlan.calls += 1;
            return fixedPlan.executions[executionIndex]!;
        }
        if (this.probeExecRejection) throw this.probeExecRejection.value;
        if (this.prepareExecOutcomeUnknown && command.includes("mkdir -m 700 --")) {
            throw new SshCommandOutcomeUnknownError("SSH command timed out after 30000ms; remote outcome is unknown");
        }
        if (this.upgradeTransportOutcome && command.includes("UPGRADE_RUNNER")) {
            const client = new UpgradeTransportClient(this.upgradeTransportOutcome);
            this.upgradeTransportClient = client;
            const transport = new SshTransport({
                host: "server.example.com", port: 22, username: "root",
                hostFingerprint: TEST_SSH_HOST_FINGERPRINT,
            }, { clientFactory: () => client as never });
            try {
                return await transport.exec(command, 5);
            } finally {
                transport.close();
            }
        }
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

function fakeSuccess(stdout: string): FakeExecResult {
    return { success: true, stdout, stderr: "", code: 0 };
}

function addFakeExecution(ssh: FakeSsh, fragment: string, execution: FakeExecResult): void {
    ssh.matchingExecResults.push({ fragment, executions: [execution], calls: 0 });
}

function addFakeExecutionSequence(
    ssh: FakeSsh,
    fragment: string,
    executions: FakeExecResult[],
): FakeExecPlan {
    if (executions.length === 0) throw new Error("Fake execution sequence must not be empty");
    const plan = { fragment, executions, calls: 0 };
    ssh.matchingExecResults.push(plan);
    return plan;
}

function fakeSystemdExecStart(executablePath: string): FakeExecResult {
    return fakeSuccess([
        "LoadState=loaded",
        `ExecStart={ path=${executablePath} ; argv[]=${executablePath} ; ignore_errors=no ; }`,
        "",
    ].join("\n"));
}

function fakeBinaryProbeSuccess(
    fixture: { versionOutput: string; sha256: string },
): FakeExecResult {
    return fakeSuccess([
        `SUPACLOUD_BINARY_HASH_BEFORE=${fixture.sha256}`,
        `SUPACLOUD_BINARY_VERSION_BASE64=${Buffer.from(fixture.versionOutput).toString("base64")}`,
        `SUPACLOUD_BINARY_HASH_AFTER=${fixture.sha256}`,
        "",
    ].join("\n"));
}

function fakeBinaryProbeChanged(
    fixture: { versionOutput: string; hashBefore: string; hashAfter: string },
): FakeExecResult {
    return {
        success: false,
        stdout: [
            `SUPACLOUD_BINARY_HASH_BEFORE=${fixture.hashBefore}`,
            `SUPACLOUD_BINARY_VERSION_BASE64=${Buffer.from(fixture.versionOutput).toString("base64")}`,
            `SUPACLOUD_BINARY_HASH_AFTER=${fixture.hashAfter}`,
            "",
        ].join("\n"),
        stderr: "",
        code: 75,
    };
}

function fakeBinaryProbeAfterHashFailure(versionOutput: string, hashBefore: string): FakeExecResult {
    return {
        success: false,
        stdout: [
            `SUPACLOUD_BINARY_HASH_BEFORE=${hashBefore}`,
            `SUPACLOUD_BINARY_VERSION_BASE64=${Buffer.from(versionOutput).toString("base64")}`,
            "",
        ].join("\n"),
        stderr: "sha256sum failed",
        code: 72,
    };
}

function fixedBinaryProbeFragment(executablePath: string): string {
    return `exec {BINARY_FD}<'${executablePath}'`;
}

function fakeWebConsoleProbe(
    markerOutput: string,
    treeSha256: string,
    changes: { root?: string; rootId?: string; marker?: string; tree?: string } = {},
): FakeExecResult {
    const rootBefore = "/opt/supacloud/web-console/releases/0.28.8-123-456";
    const rootIdBefore = "1:2";
    const markerBefore = Buffer.from(markerOutput).toString("base64");
    return fakeSuccess([
        `SUPACLOUD_WEB_ROOT_REAL_BEFORE=${rootBefore}`,
        `SUPACLOUD_WEB_ROOT_ID_BEFORE=${rootIdBefore}`,
        `SUPACLOUD_WEB_MARKER_BASE64_BEFORE=${markerBefore}`,
        `SUPACLOUD_WEB_TREE_SHA256_BEFORE=${treeSha256}`,
        `SUPACLOUD_WEB_TREE_SHA256_AFTER=${changes.tree ?? treeSha256}`,
        `SUPACLOUD_WEB_MARKER_BASE64_AFTER=${Buffer.from(changes.marker ?? markerOutput).toString("base64")}`,
        `SUPACLOUD_WEB_ROOT_REAL_AFTER=${changes.root ?? rootBefore}`,
        `SUPACLOUD_WEB_ROOT_ID_AFTER=${changes.rootId ?? rootIdBefore}`,
        "",
    ].join("\n"));
}

function addBinaryVersionFixture(
    ssh: FakeSsh,
    fixture: { unit: string; executablePath: string; versionOutput: string; sha256: string },
): void {
    const { unit, executablePath, versionOutput, sha256 } = fixture;
    addFakeExecution(ssh, `-- ${unit}`, fakeSystemdExecStart(executablePath));
    addFakeExecution(ssh, fixedBinaryProbeFragment(executablePath), fakeBinaryProbeSuccess({
        versionOutput: `${versionOutput}\n`,
        sha256,
    }));
}

function addPlatformVersionFixture(ssh: FakeSsh): void {
    addBinaryVersionFixture(ssh, {
        unit: "supacloud.service", executablePath: "/usr/local/bin/supacloud",
        versionOutput: '{"level":"INFO","message":"SupaCloud Version: 0.50.34"}', sha256: "1".repeat(64),
    });
    addBinaryVersionFixture(ssh, {
        unit: "supacloud-edge-runtime.service", executablePath: "/usr/local/bin/supacloud-edge-runtime",
        versionOutput: "supacloud-edge-runtime 0.16.9", sha256: "2".repeat(64),
    });
    addBinaryVersionFixture(ssh, {
        unit: "supacloud-caddy.service", executablePath: "/usr/local/bin/supacloud-caddy",
        versionOutput: "v2.11.4", sha256: "3".repeat(64),
    });
    addFakeExecution(ssh, "ROOT='/opt/supacloud/web-console/current'", fakeWebConsoleProbe(
        '{"schema_version":1,"component":"web-console","version":"0.28.8","future":true}\n',
        "4".repeat(64),
    ));
}

async function generatedPlatformProbeCommand(commandFragment: string): Promise<string> {
    const ssh = new FakeSsh();
    addPlatformVersionFixture(ssh);
    await captureSshTool(ssh).invoke({ action: "versions" });
    const command = ssh.commands.find(candidate => candidate.includes(commandFragment));
    if (!command) throw new Error(`Generated platform probe is missing: ${commandFragment}`);
    return command;
}

function bash32CompatibleDynamicFdSyntax(command: string): string {
    if (process.platform !== "darwin") return command;
    return command
        .replaceAll("exec {BINARY_FD}<", "exec 9<")
        .replaceAll("{BINARY_FD}<&-", "9<&-");
}

function localManagementProbeCommand(probeCommand: string, executablePath: string): string {
    if (process.platform !== "darwin") return probeCommand;
    if (executablePath.includes("'")) throw new Error("Local probe path must not contain a single quote");
    return bash32CompatibleDynamicFdSyntax(probeCommand)
        .replace("PINNED_EXECUTABLE=/proc/$$/fd/$BINARY_FD", `PINNED_EXECUTABLE='${executablePath}.pinned'`)
        .replaceAll("stat -Lc '%d:%i' --", "stat -f '%d:%i'");
}

function prepareLocalPinnedExecutable(executablePath: string): void {
    if (process.platform === "darwin") linkSync(executablePath, `${executablePath}.pinned`);
}

function uniqueTaggedOutputValue(output: string, label: string): string {
    const matches = output.split(/\r?\n/).filter(line => line.startsWith(label));
    if (matches.length !== 1) throw new Error(`Expected one tagged output line: ${label}`);
    return matches[0]!.slice(label.length);
}

function binaryProbeOutputEvidence(output: string): {
    hashBefore: string;
    versionOutput: string;
    hashAfter: string;
} {
    const encodedVersion = uniqueTaggedOutputValue(output, "SUPACLOUD_BINARY_VERSION_BASE64=");
    return {
        hashBefore: uniqueTaggedOutputValue(output, "SUPACLOUD_BINARY_HASH_BEFORE="),
        versionOutput: Buffer.from(encodedVersion, "base64").toString(),
        hashAfter: uniqueTaggedOutputValue(output, "SUPACLOUD_BINARY_HASH_AFTER="),
    };
}

type BinaryProbeRaceFixture = {
    fixtureRoot: string;
    executablePath: string;
    commandDir: string;
    realSha256sum: string;
    originalSha256: string;
    originalIdentity: string;
};

function unsafePathBinaryProbeCommand(executablePath: string): string {
    if (executablePath.includes("'")) throw new Error("Local probe path must not contain a single quote");
    const executable = `'${executablePath}'`;
    return [
        "set -o pipefail",
        `HASH_BEFORE=$(sha256sum -- ${executable} | awk '{print $1}') || exit 70`,
        `printf 'SUPACLOUD_BINARY_HASH_BEFORE=%s\\n' "$HASH_BEFORE"`,
        `VERSION_BASE64=$(${executable} --version 2>&1 | head -c 2049 | base64 | tr -d '\\n') || exit 71`,
        `printf 'SUPACLOUD_BINARY_VERSION_BASE64=%s\\n' "$VERSION_BASE64"`,
        `HASH_AFTER=$(sha256sum -- ${executable} | awk '{print $1}') || exit 72`,
        `printf 'SUPACLOUD_BINARY_HASH_AFTER=%s\\n' "$HASH_AFTER"`,
        `[ "$HASH_BEFORE" = "$HASH_AFTER" ] || exit 75`,
    ].join("\n");
}

function writeHashSwapCommand(commandPath: string): void {
    writeExecutableShell(commandPath, [
        "#!/bin/bash",
        "set -eu",
        "CALL_COUNT=0",
        "if [ -f \"$PROBE_SWAP_STATE\" ]; then read -r CALL_COUNT < \"$PROBE_SWAP_STATE\"; fi",
        "if [ \"$CALL_COUNT\" = 0 ]; then",
        "  \"$PROBE_REAL_SHA256SUM\" \"$@\"",
        "  mv \"$PROBE_TARGET\" \"${PROBE_TARGET}.saved\"",
        "  mv \"${PROBE_TARGET}.replacement\" \"$PROBE_TARGET\"",
        "  printf '1\\n' > \"$PROBE_SWAP_STATE\"",
        "  exit 0",
        "fi",
        "[ \"$CALL_COUNT\" = 1 ] || exit 64",
        "if [ \"$PROBE_REPLACEMENT_OUTCOME\" = restore_original ]; then",
        "  mv \"$PROBE_TARGET\" \"${PROBE_TARGET}.after\"",
        "  mv \"${PROBE_TARGET}.saved\" \"$PROBE_TARGET\"",
        "fi",
        "printf '2\\n' > \"$PROBE_SWAP_STATE\"",
        "exec \"$PROBE_REAL_SHA256SUM\" \"$@\"",
        "",
    ].join("\n"));
}

function fileIdentity(filePath: string): string {
    const metadata = statSync(filePath);
    return `${metadata.dev}:${metadata.ino}`;
}

function createBinaryProbeRaceFixture(): BinaryProbeRaceFixture {
    const realSha256sum = Bun.which("sha256sum");
    if (!realSha256sum) throw new Error("Required test command is unavailable: sha256sum");
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-binary-probe-aba-")));
    const executablePath = join(fixtureRoot, "supacloud");
    const commandDir = join(fixtureRoot, "commands");
    const originalSource = "#!/bin/sh\nprintf 'SupaCloud Version: 0.50.34\\n'\n";
    mkdirSync(commandDir);
    writeExecutableShell(executablePath, originalSource);
    writeExecutableShell(`${executablePath}.replacement`, "#!/bin/sh\nprintf 'SupaCloud Version: 0.50.35\\n'\n");
    writeHashSwapCommand(join(commandDir, "sha256sum"));
    return {
        fixtureRoot,
        executablePath,
        commandDir,
        realSha256sum,
        originalSha256: createHash("sha256").update(originalSource).digest("hex"),
        originalIdentity: fileIdentity(executablePath),
    };
}

function executeBinaryProbeRace(
    fixture: BinaryProbeRaceFixture,
    probeCommand: string,
    replacementOutcome: "restore_original" | "keep_replacement",
): FakeExecResult {
    const execution = Bun.spawnSync(["bash", "-c", probeCommand], {
        env: {
            ...process.env,
            PATH: `${fixture.commandDir}:${process.env.PATH ?? ""}`,
            PROBE_REAL_SHA256SUM: fixture.realSha256sum,
            PROBE_REPLACEMENT_OUTCOME: replacementOutcome,
            PROBE_SWAP_STATE: join(fixture.fixtureRoot, "hash-calls"),
            PROBE_TARGET: fixture.executablePath,
        },
    });
    return {
        success: execution.exitCode === 0,
        stdout: execution.stdout.toString(),
        stderr: execution.stderr.toString(),
        code: execution.exitCode,
    };
}

async function fixedLocalManagementProbe(executablePath: string): Promise<string> {
    const generatedProbe = await generatedPlatformProbeCommand(
        fixedBinaryProbeFragment("/usr/local/bin/supacloud"),
    );
    prepareLocalPinnedExecutable(executablePath);
    return localManagementProbeCommand(
        generatedProbe.replaceAll("'/usr/local/bin/supacloud'", `'${executablePath}'`),
        executablePath,
    );
}

async function managementEvidenceForProbe(execution: FakeExecResult): Promise<{
    status: string;
    version: string | null;
    sha256: string | null;
    error: string | null;
}> {
    const ssh = new FakeSsh();
    addFakeExecution(ssh, fixedBinaryProbeFragment("/usr/local/bin/supacloud"), execution);
    addPlatformVersionFixture(ssh);
    const response = await captureSshTool(ssh).invoke({ action: "versions" });
    return JSON.parse(response.content[0]?.text ?? "").components.management_api;
}

const UPGRADE_SIGNALS = ["HUP", "INT", "TERM"] as const;
const RELEASE_ASSETS_SCRIPT = join(import.meta.dir, "../../../../../scripts/lib/release_assets.sh");

function writeExecutableShell(filePath: string, shellSource: string): void {
    writeFileSync(filePath, shellSource);
    chmodSync(filePath, 0o755);
}

function writeDarwinStatCompatibility(commandDir: string): void {
    if (process.platform !== "darwin") return;
    writeExecutableShell(join(commandDir, "stat"), [
        "#!/bin/sh",
        "if [ \"$1\" = '-c' ] && [ \"$3\" = '--' ]; then",
        "  case \"$2\" in",
        "    '%d:%i') exec /usr/bin/stat -f '%d:%i' \"$4\" ;;",
        "    '%s') exec /usr/bin/stat -f '%z' \"$4\" ;;",
        "  esac",
        "fi",
        "exit 64",
        "",
    ].join("\n"));
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
    const stagedRunnerIndex = scriptLines.indexOf('UPGRADE_RUNNER="$STAGED_MANAGEMENT"');
    if (stagedSetupIndex < 0 || stagedRunnerIndex < stagedSetupIndex) {
        throw new Error("Root upgrade script lacks Management bootstrap boundaries");
    }
    return [scriptLines[0], ...scriptLines.slice(stagedSetupIndex, stagedRunnerIndex + 1),
        `touch '${continuationPath}'`].join("\n");
}

function remoteManagementCapabilityProbe(rootScript: string): string {
    const scriptLines = rootScript.split("\n");
    const versionProbeIndex = scriptLines.findIndex(line => line.startsWith("STAGED_VERSION="));
    const launcherGateIndex = scriptLines.findIndex(line => line.startsWith('[[ "$POSTGREST_LAUNCHER_OUTPUT"'));
    if (versionProbeIndex < 0 || launcherGateIndex < versionProbeIndex) {
        throw new Error("Root upgrade script lacks Management capability boundaries");
    }
    return [
        "set -euo pipefail",
        "supacloud_version_at_least() { return 0; }",
        'STAGED_MANAGEMENT="$RUNNER_PATH"',
        "TARGET_MANAGEMENT_VERSION=0.60.1",
        ...scriptLines.slice(versionProbeIndex, launcherGateIndex + 1),
    ].join("\n");
}

function writeTestTimeoutCommand(commandDirectory: string): void {
    writeExecutableShell(join(commandDirectory, "timeout"), [
        "#!/usr/bin/env bun",
        "const [duration, executable, ...args] = process.argv.slice(2);",
        "if (duration !== '5s' || !executable) process.exit(64);",
        "const child = Bun.spawn([executable, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });",
        "let timedOut = false;",
        "const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 1000);",
        "const exitCode = await child.exited;",
        "clearTimeout(timer);",
        "process.exit(timedOut ? 124 : exitCode);",
        "",
    ].join("\n"));
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
            { action: "upgrade", artifact_transport: "local", version: "01.50.30", edge_runtime_version: "0.16.8" },
            { action: "upgrade", artifact_transport: "local", version: "0.50.30\n", edge_runtime_version: "0.16.8" },
        ]) {
            const ssh = new FakeSsh();
            await expect(captureSshTool(ssh).invoke(args)).rejects.toThrow();
            expect(ssh.uploads).toHaveLength(0);
            expect(ssh.commands).toHaveLength(0);
        }
    });

    test("remote Management upgrades reject explicit non-stable versions before remote access", async () => {
        for (const version of ["latest", "01.50.30", "0.50.30-rc.1", "0.50.30+build.4", "0.50.30\n"]) {
            const ssh = new FakeSsh();
            await expect(captureSshTool(ssh).invoke({ action: "upgrade", version }))
                .rejects.toThrow();
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

    test("remote artifact transport uses the host-wide lock and exact target runner", () => {
        const rootScript = buildRootUpgradeScript({
            helperPath: "/tmp/release-assets.sh",
            version: "0.60.1",
        });

        expect(rootScript).toContain("/run/lock/supacloud-upgrade.lock");
        expect(rootScript).toContain("flock -E 75 -n 9");
        expect(rootScript).toContain("Another SupaCloud upgrade is already running");
        expect(rootScript).toContain("supacloud_fetch_component_release management-api '0.60.1'");
        expect(rootScript).toContain('UPGRADE_RUNNER="$STAGED_MANAGEMENT"');
        expect(rootScript).toContain('timeout 5s "$STAGED_MANAGEMENT" --version');
        expect(rootScript).toContain('timeout 5s "$STAGED_MANAGEMENT" --systemd-unit-helper-sha256');
        expect(rootScript).toContain('timeout 5s "$STAGED_MANAGEMENT" --postgrest-launcher-sha256');
        expect(rootScript).toContain("chown timeout; do command -v");
        expect(rootScript).not.toContain('UPGRADE_RUNNER=\'/usr/local/bin/supacloud\'');
    });

    test("remote target-runner capability gate rejects invalid and hanging binaries", () => {
        const fixtureDirectory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-remote-capability-")));
        const commandDirectory = join(fixtureDirectory, "commands");
        const runnerPath = join(fixtureDirectory, "management-runner");
        const probe = remoteManagementCapabilityProbe(buildRootUpgradeScript({
            helperPath: "/tmp/release-assets.sh",
            version: "0.60.1",
        }));
        mkdirSync(commandDirectory);
        writeTestTimeoutCommand(commandDirectory);

        const executeProbe = (launcherCommand: string) => {
            writeExecutableShell(runnerPath, [
                "#!/bin/sh",
                "case \"${1:-}\" in",
                "  --version) printf 'SupaCloud Version: 0.60.1\\n' ;;",
                `  --systemd-unit-helper-sha256) printf 'SupaCloud systemd-unit helper SHA-256: ${"a".repeat(64)}\\n' ;;`,
                `  --postgrest-launcher-sha256) ${launcherCommand} ;;`,
                "  *) exit 2 ;;",
                "esac",
                "",
            ].join("\n"));
            return Bun.spawnSync(["bash", "-c", probe], {
                env: {
                    ...process.env,
                    PATH: `${commandDirectory}:${process.env.PATH ?? ""}`,
                    RUNNER_PATH: runnerPath,
                },
            });
        };

        try {
            expect(executeProbe("exit 2").exitCode).not.toBe(0);
            const malformed = executeProbe("printf 'unexpected launcher identity\\n'");
            expect(malformed.exitCode).not.toBe(0);
            expect(malformed.stderr.toString()).toContain("lacks target-bound PostgREST launcher delivery");
            expect(executeProbe("exec sleep 30").exitCode).toBe(124);
            expect(executeProbe(
                `printf 'SupaCloud PostgREST launcher SHA-256: ${"b".repeat(64)}\\n'`,
            ).exitCode).toBe(0);
        } finally {
            rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    }, { timeout: 20_000 });

    test("remote latest resolution pins the transaction to the bootstrap target version", () => {
        const directory = mkdtempSync(join(tmpdir(), "supacloud-admin-target-version-"));
        const runner = join(directory, "target-runner");
        try {
            writeFileSync(runner, "#!/bin/sh\nprintf '%s' \"$SUPACLOUD_UPGRADE_TAG\"\n", { mode: 0o755 });
            chmodSync(runner, 0o755);
            const rootScript = buildRootUpgradeScript({ helperPath: "/tmp/release-assets.sh" });
            const transaction = rootScript.trim().split("\n").at(-1);
            if (!transaction) throw new Error("Generated upgrade script has no transaction command");
            const execution = Bun.spawnSync(["bash", "-c", [
                "set -euo pipefail",
                "TARGET_MANAGEMENT_VERSION=0.60.1",
                `UPGRADE_RUNNER=${JSON.stringify(runner)}`,
                "SUPACLOUD_UPGRADE_TAG=0.60.2",
                transaction,
            ].join("\n")]);

            expect(rootScript).toContain("supacloud_fetch_component_release management-api 'latest'");
            expect(transaction).toContain('SUPACLOUD_UPGRADE_TAG="$TARGET_MANAGEMENT_VERSION"');
            expect(execution.exitCode).toBe(0);
            expect(execution.stdout.toString()).toBe("0.60.1");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("remote component preflight preserves the full Edge Runtime mode and rejects suffixes", () => {
        const fixtureDir = mkdtempSync(join(tmpdir(), "supacloud-admin-edge-mode-"));
        const envFile = join(fixtureDir, "management-api.env");
        const rootScript = buildRootUpgradeScript({
            edgeRuntimeVersion: "0.17.1",
            helperPath: "/tmp/release-assets.sh",
        });
        const edgeModeAssignment = rootScript.split("\n").find(line => line.startsWith("EDGE_RUNTIME_MODE_VALUE="));
        if (!edgeModeAssignment) throw new Error("Generated upgrade script does not read EDGE_RUNTIME_MODE");
        const edgeModeGate = rootScript.split("\n").find(line => line.startsWith('test "$EDGE_RUNTIME_MODE_VALUE" = external'));
        if (!edgeModeGate) throw new Error("Generated upgrade script does not enforce exact external mode");
        const fixtureEdgeModeAssignment = edgeModeAssignment.replace("/etc/supabase/management-api.env", '"$ENV_FILE"');
        expect(fixtureEdgeModeAssignment).toContain(String.raw`\042\047`);
        expect(fixtureEdgeModeAssignment).not.toContain(String.raw`\"`);
        try {
            for (const configuredValue of ["external", '"external"', "'external'", "  external  "]) {
                writeFileSync(envFile, `EDGE_RUNTIME_MODE=${configuredValue}\n`);
                const execution = Bun.spawnSync(["bash", "-c", [
                    "set -euo pipefail", fixtureEdgeModeAssignment, edgeModeGate,
                    "printf '%s' \"$EDGE_RUNTIME_MODE_VALUE\"",
                ].join("\n")], { env: { ...process.env, ENV_FILE: envFile } });
                expect(execution.exitCode).toBe(0);
                expect(execution.stdout.toString()).toBe("external");
                expect(execution.stderr.toString()).toBe("");
            }
            writeFileSync(envFile, "EDGE_RUNTIME_MODE=external=embedded\n");
            const fullRhsProbe = Bun.spawnSync(["bash", "-c", [
                "set -euo pipefail", fixtureEdgeModeAssignment, "printf '%s' \"$EDGE_RUNTIME_MODE_VALUE\"",
            ].join("\n")], { env: { ...process.env, ENV_FILE: envFile } });
            expect(fullRhsProbe.exitCode).toBe(0);
            expect(fullRhsProbe.stdout.toString()).toBe("external=embedded");
            const suffixRejection = Bun.spawnSync(["bash", "-c", [
                "set -euo pipefail", fixtureEdgeModeAssignment, edgeModeGate,
            ].join("\n")], { env: { ...process.env, ENV_FILE: envFile } });
            expect(suffixRejection.exitCode).not.toBe(0);
            expect(suffixRejection.stderr.toString()).toContain("supports persisted external mode only");
        } finally {
            rmSync(fixtureDir, { recursive: true, force: true });
        }
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
            { action: "upgrade", version: "01.50.27", edge_runtime_version: "0.16.7" },
            { action: "upgrade", version: "0.50.27", edge_runtime_version: "0.16.7\n" },
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

    test("proxy upgrade budget adds 30-minute observation to bounded dual-route downloads", async () => {
        const ssh = new FakeSsh();
        await captureSshTool(ssh).invoke({
            action: "upgrade",
            version: "0.50.29",
            github_proxy: "https://proxy.example.test/",
        });

        expect(ssh.timeouts).toEqual([30_000, (30 + 22) * 60_000, 30_000]);
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

        await tool.invoke({ action: "upgrade", version: "0.60.1", edge_runtime_version: "0.16.7" });

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
        expect(command).not.toContain("/usr/local/bin/supacloud --version");
        expect(command).toContain("0.60.1");
        expect(command).toContain("supacloud_fetch_component_release");
        expect(command).toContain("supacloud_download_release_asset");
        expect(command).toContain('chmod 0755 "$STAGED_MANAGEMENT"');
        expect(command).toContain('"$STAGED_MANAGEMENT" --systemd-unit-helper-sha256');
        expect(command).toContain('"$STAGED_MANAGEMENT" --postgrest-launcher-sha256');
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
            version: "0.60.1",
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
        expect(ssh.timeouts).toEqual([30_000, (30 + 12) * 60_000, 30_000]);
    });

    test("timeout preserves reconciliation evidence while the remote upgrade completes later", async () => {
        const ssh = new FakeSsh();
        ssh.upgradeTransportOutcome = "late_success";
        let failure: unknown;

        try {
            await captureSshTool(ssh).invoke({
                action: "upgrade",
                version: "0.54.0",
                edge_runtime_version: "0.17.1",
            });
        } catch (error: unknown) {
            failure = error;
        }
        await new Promise(resolve => setTimeout(resolve, 25));

        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as { code?: string }).code).toBe("OUTCOME_UNKNOWN");
        const diagnostic = formatCliError(failure);
        const helperPath = ssh.uploads[0]?.remotePath ?? "";
        expect(diagnostic).toContain("OUTCOME_UNKNOWN");
        expect(diagnostic).toContain(`helper=${helperPath}`);
        expect(diagnostic).toContain(`trusted_root=${dirname(helperPath)}/${SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME}`);
        expect(diagnostic).toContain("do not retry blindly");
        expect(diagnostic.length).toBeLessThan(1_000);
        expect(ssh.upgradeTransportClient?.terminalCloseEmitted).toBe(true);
        expect(ssh.upgradeTransportClient?.endCalls).toBe(1);
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.some(command => command.includes("sudo -n rm -rf --"))).toBe(false);
    });

    test("post-dispatch stream errors preserve helpers without reflecting transport secrets", async () => {
        const ssh = new FakeSsh();
        ssh.upgradeTransportOutcome = "stream_error";
        let failure: unknown;

        try {
            await captureSshTool(ssh).invoke({ action: "upgrade", version: "0.54.0" });
        } catch (error: unknown) {
            failure = error;
        }

        expect((failure as { code?: string }).code).toBe("OUTCOME_UNKNOWN");
        const diagnostic = formatCliError(failure);
        expect(diagnostic).toContain("client cleanup was suppressed");
        expect(diagnostic).not.toContain("stream-secret");
        expect(diagnostic.length).toBeLessThan(1_000);
        expect(ssh.upgradeTransportClient?.endCalls).toBe(1);
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.some(command => command.includes("sudo -n rm -rf --"))).toBe(false);
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

    test("known helper setup failure still cleans the owned generated path", async () => {
        const ssh = new FakeSsh();
        addFakeExecution(ssh, "mkdir -m 700 --", {
            success: false, stdout: "", stderr: "mkdir returned failure", code: 23,
        });

        await expect(captureSshTool(ssh).invoke({ action: "upgrade", version: "0.54.0" }))
            .rejects.toThrow("Failed to prepare remote upgrade helper directory");
        expect(ssh.uploads).toHaveLength(0);
        expect(ssh.commands).toHaveLength(2);
        const helperDirectory = ssh.commands[0]?.match(/mkdir -m 700 -- '([^']+)'/)?.[1] ?? "";
        expect(ssh.commands[1]).toContain(`rm -rf -- '${helperDirectory}'`);
    });

    test("unknown helper setup reconciles its path after attempting cleanup", async () => {
        const ssh = new FakeSsh();
        ssh.prepareExecOutcomeUnknown = true;
        let failure: unknown;

        try {
            await captureSshTool(ssh).invoke({ action: "upgrade", version: "0.54.0" });
        } catch (error: unknown) {
            failure = error;
        }

        const diagnostic = formatCliError(failure);
        const helperDirectory = ssh.commands[0]?.match(/mkdir -m 700 -- '([^']+)'/)?.[1] ?? "";
        expect((failure as { code?: string }).code).toBe("OUTCOME_UNKNOWN");
        expect(diagnostic).toContain("Remote helper setup ended without terminal status");
        expect(diagnostic).toContain("upgrade command was not dispatched");
        expect(diagnostic).toContain(`helper=${helperDirectory}/release_assets.sh`);
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands[1]).toContain(`rm -rf -- '${helperDirectory}'`);
    });

    test("unknown helper setup preserves cleanup failure and reconciliation paths", async () => {
        const ssh = new FakeSsh();
        ssh.prepareExecOutcomeUnknown = true;
        ssh.cleanupExecFails = true;
        let failure: unknown;

        try {
            await captureSshTool(ssh).invoke({ action: "upgrade", version: "0.54.0" });
        } catch (error: unknown) {
            failure = error;
        }

        const diagnostic = formatCliError(failure);
        expect((failure as { code?: string }).code).toBe("OUTCOME_UNKNOWN");
        expect(diagnostic).toContain("helper cleanup did not complete");
        expect(diagnostic).toContain("Failed to remove remote upgrade helper");
        expect(diagnostic).toContain("helper=/tmp/.supacloud-release-assets-");
        expect((failure as AggregateError).errors).toHaveLength(2);
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

    test("successful upgrade preserves its terminal result when helper cleanup is unknown", async () => {
        const ssh = new FakeSsh();
        ssh.cleanupExecRejection = {
            value: new SshCommandOutcomeUnknownError("SSH command timed out after 30000ms; remote outcome is unknown"),
        };
        let failure: unknown;

        try {
            await captureSshTool(ssh).invoke({ action: "upgrade", version: "0.54.0" });
        } catch (error: unknown) {
            failure = error;
        }

        const diagnostic = formatCliError(failure);
        const helperPath = ssh.uploads[0]?.remotePath ?? "";
        expect((failure as { code?: string }).code).toBe("OUTCOME_UNKNOWN");
        expect(diagnostic).toContain("Remote upgrade succeeded, but helper cleanup outcome is unknown");
        expect(diagnostic).toContain(`helper=${helperPath}`);
        expect(diagnostic).not.toContain("Remote upgrade transport ended after dispatch");
    });

    test("failed upgrade preserves its terminal failure when helper cleanup is unknown", async () => {
        const ssh = new FakeSsh();
        ssh.upgradeExecFails = true;
        ssh.cleanupExecRejection = {
            value: new SshCommandOutcomeUnknownError("SSH command stream failed after dispatch; remote outcome is unknown"),
        };
        let failure: unknown;

        try {
            await captureSshTool(ssh).invoke({ action: "upgrade", version: "0.54.0" });
        } catch (error: unknown) {
            failure = error;
        }

        const diagnostic = formatCliError(failure);
        expect((failure as { code?: string }).code).toBe("OUTCOME_UNKNOWN");
        expect(diagnostic).toContain("Remote upgrade failed with a terminal result");
        expect(diagnostic).toContain("Remote upgrade failed (exit 42): transaction failed");
        expect(diagnostic).toContain(`helper=${ssh.uploads[0]?.remotePath ?? ""}`);
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
        expect(cloneCommand).toContain("https://github.com/vibeunion/supacloud.git");
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
        const directIndex = cloneCommand.indexOf("https://github.com/vibeunion/supacloud.git");
        const proxyIndex = cloneCommand.indexOf("https://proxy.example.com/https://github.com/vibeunion/supacloud.git");
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

    test("versions returns stable evidence for canonical platform paths", async () => {
        const ssh = new FakeSsh();
        addPlatformVersionFixture(ssh);

        const response = await captureSshTool(ssh).invoke({ action: "versions" });
        const report = JSON.parse(response.content[0]?.text ?? "") as any;

        expect(response.isError).not.toBe(true);
        expect(report.schema_version).toBe(1);
        expect(Object.keys(report.components)).toEqual([
            "management_api", "edge_runtime", "caddy", "web_console",
        ]);
        expect(report.components.management_api).toEqual({
            status: "ok",
            version: "0.50.34",
            sha256: "1".repeat(64),
            path: "/usr/local/bin/supacloud",
            source: "systemd:supacloud.service:ExecStart",
            error: null,
        });
        expect(report.components.edge_runtime.version).toBe("0.16.9");
        expect(report.components.caddy.version).toBe("2.11.4");
        expect(report.components.web_console).toEqual({
            status: "ok",
            version: "0.28.8",
            tree_sha256: "4".repeat(64),
            path: "/opt/supacloud/web-console/current",
            source: "component_marker_and_tree_sha256",
            error: null,
        });
        const managementProbe = ssh.commands.find(command => (
            command.includes(fixedBinaryProbeFragment("/usr/local/bin/supacloud"))
        )) ?? "";
        const hashBeforeIndex = managementProbe.indexOf("HASH_BEFORE=$(sha256sum");
        const versionIndex = managementProbe.indexOf("VERSION_BASE64=$(");
        const hashAfterIndex = managementProbe.indexOf("HASH_AFTER=$(sha256sum");
        expect(hashBeforeIndex).toBeGreaterThanOrEqual(0);
        expect(versionIndex).toBeGreaterThan(hashBeforeIndex);
        expect(hashAfterIndex).toBeGreaterThan(versionIndex);
        expect(managementProbe.match(/sha256sum -- "\$PINNED_EXECUTABLE"/g)).toHaveLength(2);
        expect(managementProbe).not.toContain("sha256sum -- '/usr/local/bin/supacloud'");
        expect(managementProbe).toContain('"$PINNED_EXECUTABLE" --version');
        expect(managementProbe).toContain("| head -c 2049 | base64 |");
        const webProbe = ssh.commands.find(command => command.includes("web_tree_sha256()")) ?? "";
        expect(webProbe.indexOf("ROOT_REAL_BEFORE=")).toBeLessThan(webProbe.indexOf("TREE_BEFORE="));
        expect(webProbe.indexOf("TREE_BEFORE=")).toBeLessThan(webProbe.indexOf("TREE_AFTER="));
        expect(webProbe.indexOf("TREE_AFTER=")).toBeLessThan(webProbe.indexOf("ROOT_REAL_AFTER="));
        expect(webProbe.match(/head -c 4097 --/g)).toHaveLength(2);
        for (const command of ssh.commands) {
            const syntaxCommand = bash32CompatibleDynamicFdSyntax(command);
            expect(Bun.spawnSync(["bash", "-n", "-c", syntaxCommand]).exitCode).toBe(0);
        }
    });

    test("the fixed Web Console probe executes a real stable release tree", async () => {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-web-probe-")));
        const releaseRoot = join(fixtureRoot, "releases", "0.28.8-test");
        const commandDir = join(fixtureRoot, "commands");
        try {
            mkdirSync(releaseRoot, { recursive: true });
            mkdirSync(commandDir, { recursive: true });
            writeDarwinStatCompatibility(commandDir);
            const markerSource = '{"schema_version":1,"component":"web-console","version":"0.28.8"}\n';
            const indexSource = "<!doctype html><title>SupaCloud</title>\n";
            writeFileSync(join(releaseRoot, ".supacloud-component.json"), markerSource);
            writeFileSync(join(releaseRoot, "index.html"), indexSource);
            symlinkSync(releaseRoot, join(fixtureRoot, "current"));

            const generatedProbe = await generatedPlatformProbeCommand("web_tree_sha256()");
            const localProbe = generatedProbe.replaceAll("/opt/supacloud/web-console", fixtureRoot);
            const execution = Bun.spawnSync(["bash", "-c", localProbe], {
                env: { ...process.env, PATH: `${commandDir}:${process.env.PATH ?? ""}` },
            });

            expect(execution.exitCode).toBe(0);
            expect(execution.stderr.toString()).toBe("");
            const normalizedOutput = execution.stdout.toString().replaceAll(
                fixtureRoot,
                "/opt/supacloud/web-console",
            );
            const parserSsh = new FakeSsh();
            addFakeExecution(
                parserSsh,
                "ROOT='/opt/supacloud/web-console/current'",
                fakeSuccess(normalizedOutput),
            );
            addPlatformVersionFixture(parserSsh);

            const response = await captureSshTool(parserSsh).invoke({ action: "versions" });
            const webConsole = JSON.parse(response.content[0]?.text ?? "").components.web_console;

            expect(webConsole).toMatchObject({
                status: "ok",
                version: "0.28.8",
                error: null,
            });
            const markerSha256 = createHash("sha256").update(markerSource).digest("hex");
            const indexSha256 = createHash("sha256").update(indexSource).digest("hex");
            const treeInput = [
                `${markerSha256}  ./.supacloud-component.json`,
                `${indexSha256}  ./index.html`,
                "",
            ].join("\n");
            expect(webConsole.tree_sha256).toBe(createHash("sha256").update(treeInput).digest("hex"));
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("the fixed Web Console probe rejects linked and special-file markers", async () => {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-web-invalid-marker-")));
        const commandDir = join(fixtureRoot, "commands");
        try {
            mkdirSync(commandDir, { recursive: true });
            writeDarwinStatCompatibility(commandDir);
            const generatedProbe = await generatedPlatformProbeCommand("web_tree_sha256()");
            const spawnProbe = (webRoot: string) => Bun.spawnSync([
                "bash",
                "-c",
                generatedProbe.replaceAll("/opt/supacloud/web-console", webRoot),
            ], {
                env: { ...process.env, PATH: `${commandDir}:${process.env.PATH ?? ""}` },
            });

            const linkedRoot = join(fixtureRoot, "linked");
            const linkedRelease = join(linkedRoot, "releases", "0.28.8-test");
            mkdirSync(linkedRelease, { recursive: true });
            symlinkSync(linkedRelease, join(linkedRoot, "current"));
            const markerTarget = join(linkedRoot, "marker-target.json");
            writeFileSync(markerTarget, '{"schema_version":1,"component":"web-console","version":"0.28.8"}\n');
            symlinkSync(markerTarget, join(linkedRelease, ".supacloud-component.json"));
            expect(spawnProbe(linkedRoot).exitCode).toBe(65);

            const specialRoot = join(fixtureRoot, "special");
            const specialRelease = join(specialRoot, "releases", "0.28.8-test");
            mkdirSync(specialRelease, { recursive: true });
            symlinkSync(specialRelease, join(specialRoot, "current"));
            const fifoPath = join(specialRelease, ".supacloud-component.json");
            const mkfifoPath = Bun.which("mkfifo");
            if (!mkfifoPath) throw new Error("Required test command is unavailable: mkfifo");
            expect(Bun.spawnSync([mkfifoPath, fifoPath]).exitCode).toBe(0);
            expect(spawnProbe(specialRoot).exitCode).toBe(65);
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("versions rejects binary evidence when the executable changes during one probe", async () => {
        const ssh = new FakeSsh();
        addFakeExecution(
            ssh,
            fixedBinaryProbeFragment("/usr/local/bin/supacloud"),
            fakeBinaryProbeChanged({
                versionOutput: "SupaCloud Version: 0.50.34\n",
                hashBefore: "1".repeat(64),
                hashAfter: "9".repeat(64),
            }),
        );
        addPlatformVersionFixture(ssh);

        const response = await captureSshTool(ssh).invoke({ action: "versions" });
        const components = JSON.parse(response.content[0]?.text ?? "").components;

        expect(components.management_api).toMatchObject({
            status: "error",
            version: null,
            sha256: null,
            error: "binary_changed_during_probe",
        });
        expect(components.edge_runtime.status).toBe("ok");
        expect(components.caddy.status).toBe("ok");
        expect(components.web_console.status).toBe("ok");
    });

    test("the legacy path probe can join a replacement version to restored original hashes", () => {
        const fixture = createBinaryProbeRaceFixture();
        try {
            const legacyProbe = unsafePathBinaryProbeCommand(fixture.executablePath);
            const execution = executeBinaryProbeRace(fixture, legacyProbe, "restore_original");

            expect(execution.code).toBe(0);
            expect(execution.stderr).toBe("");
            expect(binaryProbeOutputEvidence(execution.stdout)).toEqual({
                hashBefore: fixture.originalSha256,
                versionOutput: "SupaCloud Version: 0.50.35\n",
                hashAfter: fixture.originalSha256,
            });
            expect(fileIdentity(fixture.executablePath)).toBe(fixture.originalIdentity);
        } finally {
            rmSync(fixture.fixtureRoot, { recursive: true, force: true });
        }
    });

    test("the fixed binary probe pins one executable across an ABA path replacement", async () => {
        const fixture = createBinaryProbeRaceFixture();
        try {
            const fixedProbe = await fixedLocalManagementProbe(fixture.executablePath);
            const execution = executeBinaryProbeRace(fixture, fixedProbe, "restore_original");

            expect(execution.code).toBe(0);
            expect(execution.stderr).toBe("");
            expect(binaryProbeOutputEvidence(execution.stdout)).toEqual({
                hashBefore: fixture.originalSha256,
                versionOutput: "SupaCloud Version: 0.50.34\n",
                hashAfter: fixture.originalSha256,
            });
            expect(fileIdentity(fixture.executablePath)).toBe(fixture.originalIdentity);
            expect(await managementEvidenceForProbe(execution)).toMatchObject({
                status: "ok",
                version: "0.50.34",
                sha256: fixture.originalSha256,
                error: null,
            });
        } finally {
            rmSync(fixture.fixtureRoot, { recursive: true, force: true });
        }
    });

    test("the fixed binary probe rejects a replacement left at the allowed path", async () => {
        const fixture = createBinaryProbeRaceFixture();
        try {
            const fixedProbe = await fixedLocalManagementProbe(fixture.executablePath);
            const execution = executeBinaryProbeRace(fixture, fixedProbe, "keep_replacement");

            expect(execution.code).toBe(75);
            expect(execution.stderr).toBe("");
            expect(binaryProbeOutputEvidence(execution.stdout)).toEqual({
                hashBefore: fixture.originalSha256,
                versionOutput: "SupaCloud Version: 0.50.34\n",
                hashAfter: fixture.originalSha256,
            });
            expect(fileIdentity(fixture.executablePath)).not.toBe(fixture.originalIdentity);
            expect(await managementEvidenceForProbe(execution)).toMatchObject({
                status: "error",
                version: null,
                sha256: null,
                error: "binary_changed_during_probe",
            });
        } finally {
            rmSync(fixture.fixtureRoot, { recursive: true, force: true });
        }
    });

    test("the fixed binary probe exits 75 when version execution replaces its file", async () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), "supacloud-binary-probe-race-"));
        const executablePath = join(fixtureRoot, "supacloud");
        try {
            expect(executablePath).not.toContain("'");
            writeExecutableShell(executablePath, [
                "#!/bin/bash",
                "printf 'SupaCloud Version: 0.50.34\\n'",
                `ORIGINAL_PATH='${executablePath}'`,
                "NEXT_PATH=\"${ORIGINAL_PATH}.next\"",
                "printf '%s\\n' '#!/bin/sh' \"printf 'SupaCloud Version: 0.50.35\\\\n'\" > \"$NEXT_PATH\"",
                "chmod 0755 \"$NEXT_PATH\"",
                "mv -f \"$NEXT_PATH\" \"$ORIGINAL_PATH\"",
                "",
            ].join("\n"));
            prepareLocalPinnedExecutable(executablePath);
            const ssh = new FakeSsh();
            addPlatformVersionFixture(ssh);
            await captureSshTool(ssh).invoke({ action: "versions" });
            const fixedProbe = ssh.commands.find(command => (
                command.includes(fixedBinaryProbeFragment("/usr/local/bin/supacloud"))
            )) ?? "";
            const localProbe = localManagementProbeCommand(
                fixedProbe.replaceAll("'/usr/local/bin/supacloud'", `'${executablePath}'`),
                executablePath,
            );

            const execution = Bun.spawnSync(["bash", "-c", localProbe]);
            expect(execution.exitCode).toBe(75);
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("versions clears binary evidence when systemd ExecStart changes after the probe", async () => {
        const ssh = new FakeSsh();
        const systemdPlan = addFakeExecutionSequence(ssh, "-- supacloud.service", [
            fakeSystemdExecStart("/usr/local/bin/supacloud"),
            fakeSystemdExecStart("/opt/supacloud/bin/supacloud"),
        ]);
        addFakeExecution(
            ssh,
            fixedBinaryProbeFragment("/usr/local/bin/supacloud"),
            fakeBinaryProbeSuccess({ versionOutput: "SupaCloud Version: 0.50.34\n", sha256: "1".repeat(64) }),
        );
        addPlatformVersionFixture(ssh);

        const response = await captureSshTool(ssh).invoke({ action: "versions" });
        const management = JSON.parse(response.content[0]?.text ?? "").components.management_api;

        expect(systemdPlan.calls).toBe(2);
        expect(management).toMatchObject({
            status: "error",
            version: null,
            sha256: null,
            path: "/usr/local/bin/supacloud",
            error: "exec_start_changed_during_probe",
        });
    });

    test("versions rejects each Web Console snapshot change without cross-generation evidence", async () => {
        const stableMarker = '{"schema_version":1,"component":"web-console","version":"0.28.8"}\n';
        const changes = [
            {
                fixture: { root: "/opt/supacloud/web-console/releases/0.28.9-789-012" },
                error: "web_console_root_changed_during_probe",
            },
            {
                fixture: { marker: '{"schema_version":1,"component":"web-console","version":"0.28.9"}\n' },
                error: "marker_changed_during_probe",
            },
            { fixture: { tree: "8".repeat(64) }, error: "tree_sha256_changed_during_probe" },
        ];

        for (const change of changes) {
            const ssh = new FakeSsh();
            addFakeExecution(
                ssh,
                "ROOT='/opt/supacloud/web-console/current'",
                fakeWebConsoleProbe(stableMarker, "4".repeat(64), change.fixture),
            );
            addPlatformVersionFixture(ssh);

            const response = await captureSshTool(ssh).invoke({ action: "versions" });
            const webConsole = JSON.parse(response.content[0]?.text ?? "").components.web_console;

            expect(webConsole).toMatchObject({
                status: "error",
                version: null,
                tree_sha256: null,
                error: change.error,
            });
        }
    });

    test("versions accepts 2048 binary-version bytes and rejects 2049", async () => {
        const versionPrefix = "SupaCloud Version: 0.50.34";
        for (const outputBytes of [2048, 2049]) {
            const versionOutput = `${versionPrefix}${" ".repeat(outputBytes - versionPrefix.length)}`;
            expect(Buffer.byteLength(versionOutput)).toBe(outputBytes);
            const ssh = new FakeSsh();
            addFakeExecution(
                ssh,
                fixedBinaryProbeFragment("/usr/local/bin/supacloud"),
                fakeBinaryProbeSuccess({ versionOutput, sha256: "1".repeat(64) }),
            );
            addPlatformVersionFixture(ssh);

            const response = await captureSshTool(ssh).invoke({ action: "versions" });
            const management = JSON.parse(response.content[0]?.text ?? "").components.management_api;

            expect(management.status).toBe(outputBytes === 2048 ? "ok" : "error");
            expect(management.version).toBe(outputBytes === 2048 ? "0.50.34" : null);
        }
    });

    test("versions fails closed for malformed binary tagged output", async () => {
        const hash = "1".repeat(64);
        const versionBase64 = Buffer.from("SupaCloud Version: 0.50.34\n").toString("base64");
        const validLines = [
            `SUPACLOUD_BINARY_HASH_BEFORE=${hash}`,
            `SUPACLOUD_BINARY_VERSION_BASE64=${versionBase64}`,
            `SUPACLOUD_BINARY_HASH_AFTER=${hash}`,
        ];
        const hashLines = (invalidHash: string) => [
            `SUPACLOUD_BINARY_HASH_BEFORE=${invalidHash}`,
            validLines[1]!,
            `SUPACLOUD_BINARY_HASH_AFTER=${invalidHash}`,
        ];
        const invalidUtf8 = Buffer.from([0xc3, 0x28]).toString("base64");
        const invalidOutputs = [
            { name: "missing label", output: `${validLines[0]}\n${validLines[2]}\n` },
            { name: "duplicate label", output: `${[validLines[0], validLines[1], validLines[1], validLines[2]].join("\n")}\n` },
            { name: "wrong order", output: `${[validLines[1], validLines[0], validLines[2]].join("\n")}\n` },
            { name: "extra label", output: `${[...validLines, "SUPACLOUD_BINARY_EXTRA=1"].join("\n")}\n` },
            { name: "empty base64", output: `${[validLines[0], "SUPACLOUD_BINARY_VERSION_BASE64=", validLines[2]].join("\n")}\n` },
            { name: "invalid base64", output: `${[validLines[0], "SUPACLOUD_BINARY_VERSION_BASE64=%%%%", validLines[2]].join("\n")}\n` },
            { name: "non-canonical base64", output: `${[validLines[0], "SUPACLOUD_BINARY_VERSION_BASE64=Zh==", validLines[2]].join("\n")}\n` },
            { name: "invalid UTF-8", output: `${[validLines[0], `SUPACLOUD_BINARY_VERSION_BASE64=${invalidUtf8}`, validLines[2]].join("\n")}\n` },
            { name: "short hash", output: `${hashLines("1".repeat(63)).join("\n")}\n` },
            { name: "uppercase hash", output: `${hashLines("A".repeat(64)).join("\n")}\n` },
            { name: "leading whitespace hash", output: `${hashLines(` ${hash}`).join("\n")}\n` },
            { name: "trailing whitespace hash", output: `${hashLines(`${hash} `).join("\n")}\n` },
            { name: "carriage return", output: `${validLines.join("\r\n")}\r\n` },
        ];

        for (const invalidOutput of invalidOutputs) {
            const ssh = new FakeSsh();
            addFakeExecution(
                ssh,
                fixedBinaryProbeFragment("/usr/local/bin/supacloud"),
                fakeSuccess(invalidOutput.output),
            );
            addPlatformVersionFixture(ssh);

            const response = await captureSshTool(ssh).invoke({ action: "versions" });
            const management = JSON.parse(response.content[0]?.text ?? "").components.management_api;

            expect({ name: invalidOutput.name, status: management.status }).toEqual({
                name: invalidOutput.name,
                status: "error",
            });
        }
    });

    test("versions accepts 4096 Web marker bytes and rejects 4097", async () => {
        const markerPrefix = '{"schema_version":1,"component":"web-console","version":"0.28.8"}';
        for (const outputBytes of [4096, 4097]) {
            const markerOutput = `${markerPrefix}${" ".repeat(outputBytes - markerPrefix.length)}`;
            expect(Buffer.byteLength(markerOutput)).toBe(outputBytes);
            const ssh = new FakeSsh();
            addFakeExecution(
                ssh,
                "ROOT='/opt/supacloud/web-console/current'",
                fakeWebConsoleProbe(markerOutput, "4".repeat(64)),
            );
            addPlatformVersionFixture(ssh);

            const response = await captureSshTool(ssh).invoke({ action: "versions" });
            const webConsole = JSON.parse(response.content[0]?.text ?? "").components.web_console;

            expect(webConsole.status).toBe(outputBytes === 4096 ? "ok" : "error");
            expect(webConsole.version).toBe(outputBytes === 4096 ? "0.28.8" : null);
        }
    });

    test("versions fails closed for malformed Web Console tagged output", async () => {
        const markerOutput = '{"schema_version":1,"component":"web-console","version":"0.28.8"}\n';
        const validLines = fakeWebConsoleProbe(markerOutput, "4".repeat(64)).stdout.trimEnd().split("\n");
        const webProbeOutputWith = (...replacements: Array<[number, string]>): string => {
            const lines = [...validLines];
            for (const [index, replacement] of replacements) lines[index] = replacement;
            return `${lines.join("\n")}\n`;
        };
        const invalidUtf8 = Buffer.from([0xc3, 0x28]).toString("base64");
        const invalidOutputs = [
            { name: "missing label", output: `${validLines.slice(0, -1).join("\n")}\n` },
            { name: "duplicate label", output: `${[validLines[0], ...validLines].join("\n")}\n` },
            { name: "wrong order", output: webProbeOutputWith([0, validLines[1]!], [1, validLines[0]!]) },
            { name: "extra label", output: `${[...validLines, "SUPACLOUD_WEB_EXTRA=1"].join("\n")}\n` },
            { name: "empty base64", output: webProbeOutputWith([2, "SUPACLOUD_WEB_MARKER_BASE64_BEFORE="]) },
            { name: "invalid base64", output: webProbeOutputWith([2, "SUPACLOUD_WEB_MARKER_BASE64_BEFORE=%%%%"]) },
            { name: "non-canonical base64", output: webProbeOutputWith([2, "SUPACLOUD_WEB_MARKER_BASE64_BEFORE=Zh=="]) },
            { name: "invalid UTF-8", output: webProbeOutputWith([2, `SUPACLOUD_WEB_MARKER_BASE64_BEFORE=${invalidUtf8}`]) },
            {
                name: "short hash",
                output: webProbeOutputWith(
                    [3, `SUPACLOUD_WEB_TREE_SHA256_BEFORE=${"4".repeat(63)}`],
                    [4, `SUPACLOUD_WEB_TREE_SHA256_AFTER=${"4".repeat(63)}`],
                ),
            },
            {
                name: "uppercase hash",
                output: webProbeOutputWith(
                    [3, `SUPACLOUD_WEB_TREE_SHA256_BEFORE=${"A".repeat(64)}`],
                    [4, `SUPACLOUD_WEB_TREE_SHA256_AFTER=${"A".repeat(64)}`],
                ),
            },
            {
                name: "leading whitespace hash",
                output: webProbeOutputWith(
                    [3, `SUPACLOUD_WEB_TREE_SHA256_BEFORE= ${"4".repeat(64)}`],
                    [4, `SUPACLOUD_WEB_TREE_SHA256_AFTER= ${"4".repeat(64)}`],
                ),
            },
            {
                name: "trailing whitespace hash",
                output: webProbeOutputWith(
                    [3, `SUPACLOUD_WEB_TREE_SHA256_BEFORE=${"4".repeat(64)} `],
                    [4, `SUPACLOUD_WEB_TREE_SHA256_AFTER=${"4".repeat(64)} `],
                ),
            },
            {
                name: "invalid root",
                output: webProbeOutputWith(
                    [0, "SUPACLOUD_WEB_ROOT_REAL_BEFORE=/tmp/web-console"],
                    [6, "SUPACLOUD_WEB_ROOT_REAL_AFTER=/tmp/web-console"],
                ),
            },
            {
                name: "parent release segment",
                output: webProbeOutputWith(
                    [0, "SUPACLOUD_WEB_ROOT_REAL_BEFORE=/opt/supacloud/web-console/releases/.."],
                    [6, "SUPACLOUD_WEB_ROOT_REAL_AFTER=/opt/supacloud/web-console/releases/.."],
                ),
            },
            {
                name: "invalid root ID",
                output: webProbeOutputWith(
                    [1, "SUPACLOUD_WEB_ROOT_ID_BEFORE=device:inode"],
                    [7, "SUPACLOUD_WEB_ROOT_ID_AFTER=device:inode"],
                ),
            },
            { name: "carriage return", output: `${validLines.join("\r\n")}\r\n` },
        ];

        for (const invalidOutput of invalidOutputs) {
            const ssh = new FakeSsh();
            addFakeExecution(
                ssh,
                "ROOT='/opt/supacloud/web-console/current'",
                fakeSuccess(invalidOutput.output),
            );
            addPlatformVersionFixture(ssh);

            const response = await captureSshTool(ssh).invoke({ action: "versions" });
            const webConsole = JSON.parse(response.content[0]?.text ?? "").components.web_console;

            expect({ name: invalidOutput.name, status: webConsole.status }).toEqual({
                name: invalidOutput.name,
                status: "error",
            });
        }
    });

    test("versions supports only repository-confirmed opt binary paths", async () => {
        const ssh = new FakeSsh();
        addBinaryVersionFixture(ssh, {
            unit: "supacloud.service", executablePath: "/opt/supacloud/bin/supacloud",
            versionOutput: "SupaCloud Version: 0.50.34", sha256: "a".repeat(64),
        });
        addBinaryVersionFixture(ssh, {
            unit: "supacloud-edge-runtime.service", executablePath: "/opt/supacloud/bin/supacloud-edge-runtime",
            versionOutput: "supacloud-edge-runtime 0.16.9", sha256: "b".repeat(64),
        });
        addBinaryVersionFixture(ssh, {
            unit: "supacloud-caddy.service", executablePath: "/usr/local/bin/supacloud-caddy",
            versionOutput: "v2.11.4", sha256: "c".repeat(64),
        });
        addFakeExecution(ssh, "ROOT='/opt/supacloud/web-console/current'", fakeWebConsoleProbe(
            '{"schema_version":1,"component":"web-console","version":"0.28.8"}',
            "d".repeat(64),
        ));

        const response = await captureSshTool(ssh).invoke({ action: "versions" });
        const components = JSON.parse(response.content[0]?.text ?? "").components;

        expect(components.management_api.path).toBe("/opt/supacloud/bin/supacloud");
        expect(components.edge_runtime.path).toBe("/opt/supacloud/bin/supacloud-edge-runtime");
        expect(components.management_api.status).toBe("ok");
        expect(components.edge_runtime.status).toBe("ok");
    });

    test("versions rejects an unapproved ExecStart without executing it", async () => {
        const ssh = new FakeSsh();
        addFakeExecution(ssh, "-- supacloud.service", fakeSuccess([
            "LoadState=loaded",
            "ExecStart={ path=/tmp/hostile-supacloud ; argv[]=/tmp/hostile-supacloud ; }",
        ].join("\n")));
        addPlatformVersionFixture(ssh);

        const response = await captureSshTool(ssh).invoke({ action: "versions" });
        const management = JSON.parse(response.content[0]?.text ?? "").components.management_api;

        expect(management.status).toBe("error");
        expect(management.error).toBe("exec_start_not_allowed");
        expect(management.path).toBe("/tmp/hostile-supacloud");
        expect(ssh.commands.some(command => command.startsWith("/tmp/hostile-supacloud"))).toBe(false);
    });

    test("versions rejects shell syntax embedded in ExecStart", async () => {
        const ssh = new FakeSsh();
        addFakeExecution(ssh, "-- supacloud.service", fakeSuccess([
            "LoadState=loaded",
            "ExecStart={ path=/usr/local/bin/supacloud$(touch/tmp/owned) ; argv[]=/usr/local/bin/supacloud ; }",
        ].join("\n")));
        addPlatformVersionFixture(ssh);

        const response = await captureSshTool(ssh).invoke({ action: "versions" });
        const management = JSON.parse(response.content[0]?.text ?? "").components.management_api;

        expect(management).toMatchObject({ status: "error", path: null, error: "exec_start_invalid" });
        expect(ssh.commands.join("\n")).not.toContain("touch/tmp/owned");
    });

    test("versions distinguishes missing units from malformed systemd output", async () => {
        const missing = new FakeSsh();
        addFakeExecution(missing, "-- supacloud.service", fakeSuccess("LoadState=not-found\nExecStart=\n"));
        addPlatformVersionFixture(missing);
        const missingResponse = await captureSshTool(missing).invoke({ action: "versions" });
        expect(JSON.parse(missingResponse.content[0]?.text ?? "").components.management_api).toMatchObject({
            status: "unknown", path: null, error: "unit_not_loaded",
        });

        const malformed = new FakeSsh();
        addFakeExecution(malformed, "-- supacloud.service", fakeSuccess(
            "LoadState=loaded\nExecStart={ path=/usr/local/bin/supacloud ; }; { path=/tmp/other ; }\n",
        ));
        addPlatformVersionFixture(malformed);
        const malformedResponse = await captureSshTool(malformed).invoke({ action: "versions" });
        expect(JSON.parse(malformedResponse.content[0]?.text ?? "").components.management_api).toMatchObject({
            status: "error", path: null, error: "exec_start_invalid",
        });
        expect(malformedResponse.isError).toBe(true);
    });

    test("versions marks transport failures as tool errors without reflecting diagnostics", async () => {
        const ssh = new FakeSsh();
        const privateDiagnostic = "SUPACLOUD_API_TOKEN=admin-version-private-sentinel";
        ssh.probeExecRejection = { value: new Error(privateDiagnostic) };

        const response = await captureSshTool(ssh).invoke({ action: "versions" });
        const output = response.content[0]?.text ?? "";
        const components = JSON.parse(output).components;

        expect(response.isError).toBe(true);
        expect(components.management_api.error).toBe("systemd_probe_transport_failed");
        expect(components.edge_runtime.error).toBe("systemd_probe_transport_failed");
        expect(components.caddy.error).toBe("systemd_probe_transport_failed");
        expect(components.web_console.error).toBe("web_console_probe_transport_failed");
        expect(output).not.toContain(privateDiagnostic);
    });

    test("versions keeps unavailable components unknown without reporting a transport failure", async () => {
        const ssh = new FakeSsh();
        addFakeExecution(ssh, "systemctl show", fakeSuccess("LoadState=not-found\nExecStart=\n"));
        addFakeExecution(ssh, "ROOT='/opt/supacloud/web-console/current'", {
            success: false, stdout: "", stderr: "", code: 43,
        });

        const response = await captureSshTool(ssh).invoke({ action: "versions" });
        const components = JSON.parse(response.content[0]?.text ?? "").components;

        expect(response.isError).not.toBe(true);
        expect(components.management_api).toMatchObject({ status: "unknown", error: "unit_not_loaded" });
        expect(components.edge_runtime).toMatchObject({ status: "unknown", error: "unit_not_loaded" });
        expect(components.caddy).toMatchObject({ status: "unknown", error: "unit_not_loaded" });
        expect(components.web_console).toMatchObject({ status: "unknown", error: "web_console_missing" });
    });

    test("versions preserves successful fields when one fixed probe fails", async () => {
        const ssh = new FakeSsh();
        addFakeExecution(
            ssh,
            fixedBinaryProbeFragment("/usr/local/bin/supacloud"),
            fakeBinaryProbeAfterHashFailure("SupaCloud Version: 0.50.34\n", "1".repeat(64)),
        );
        addPlatformVersionFixture(ssh);

        const response = await captureSshTool(ssh).invoke({ action: "versions" });
        const components = JSON.parse(response.content[0]?.text ?? "").components;

        expect(components.management_api).toMatchObject({
            status: "error",
            version: "0.50.34",
            sha256: null,
            error: "sha256_probe_failed",
        });
        expect(components.edge_runtime.status).toBe("ok");
        expect(components.caddy.status).toBe("ok");
        expect(components.web_console.status).toBe("ok");
    });

    test("versions rejects every non-stable or mixed version output", async () => {
        for (const versionOutput of [
            "supacloud-edge-runtime 01.16.9",
            "supacloud-edge-runtime 0.16.9-rc.1",
            "supacloud-edge-runtime 0.16.9+build.4",
            "supacloud-edge-runtime 0.16.9_rc.1",
            "supacloud-edge-runtime 0.16.9~rc1",
            "candidate 0.16.9-rc.1 fallback 0.16.9",
            "candidate 0.16.9+build.4 fallback 0.16.9",
            "candidate 0.16.9_rc.1 fallback 0.16.9",
            "candidate 0.16.9~rc1 fallback 0.16.9",
            "candidate 0.16.9/rc1 fallback 0.16.9",
        ]) {
            const ssh = new FakeSsh();
            addFakeExecution(
                ssh,
                fixedBinaryProbeFragment("/usr/local/bin/supacloud-edge-runtime"),
                fakeBinaryProbeSuccess({ versionOutput: `${versionOutput}\n`, sha256: "2".repeat(64) }),
            );
            addPlatformVersionFixture(ssh);

            const response = await captureSshTool(ssh).invoke({ action: "versions" });
            const edgeRuntime = JSON.parse(response.content[0]?.text ?? "").components.edge_runtime;

            expect(edgeRuntime).toMatchObject({
                status: "error",
                version: null,
                error: "version_output_invalid",
            });
        }
    });

    test("versions distinguishes missing and malformed Web Console markers", async () => {
        const missing = new FakeSsh();
        addFakeExecution(missing, "ROOT='/opt/supacloud/web-console/current'", {
            success: false, stdout: "", stderr: "", code: 44,
        });
        addPlatformVersionFixture(missing);
        const missingResponse = await captureSshTool(missing).invoke({ action: "versions" });
        const missingWeb = JSON.parse(missingResponse.content[0]?.text ?? "").components.web_console;
        expect(missingWeb).toMatchObject({ status: "unknown", version: null, error: "marker_missing" });

        for (const invalidMarker of [
            '{"schema_version":2,"component":"web-console","version":"0.28.8"}',
            '{"schema_version":1,"component":"web-console","version":"01.2.3"}',
            '{"schema_version":1,"component":"web-console","version":"0.28.8-rc.1"}',
            '{"schema_version":1,"component":"web-console","version":"0.28.8+build"}',
            '{"schema_version":1,"component":"web-console","version":"0.28.8\\n"}',
        ]) {
            const invalid = new FakeSsh();
            addFakeExecution(
                invalid,
                "ROOT='/opt/supacloud/web-console/current'",
                fakeWebConsoleProbe(invalidMarker, "4".repeat(64)),
            );
            addPlatformVersionFixture(invalid);

            const invalidResponse = await captureSshTool(invalid).invoke({ action: "versions" });
            const invalidWeb = JSON.parse(invalidResponse.content[0]?.text ?? "").components.web_console;

            expect(invalidWeb).toMatchObject({ status: "error", version: null, error: "marker_invalid" });
        }
    });

    test("diagnose returns bounded Management health bodies without assuming a PostgreSQL socket", async () => {
        const ssh = new FakeSsh();
        addFakeExecution(ssh, "set -o pipefail", fakeSuccess([
            "=== Management API /health ===",
            '{"status":"ok"}',
            "=== Management API /monitor/health ===",
            '{"status":"healthy"}',
        ].join("\n")));
        const tool = captureSshTool(ssh);

        const response = await tool.invoke({ action: "diagnose" });
        const command = ssh.commands.at(-1) ?? "";

        expect(response.content[0]?.text).toContain('{"status":"ok"}');
        expect(response.content[0]?.text).toContain('{"status":"healthy"}');
        expect(command).toContain("set -o pipefail");
        expect(command).toContain("http://127.0.0.1:9090/health");
        expect(command).toContain("http://127.0.0.1:9090/monitor/health");
        expect(command).toContain("--max-time 5 --max-filesize 4096");
        expect(command).toContain("--max-time 15 --max-filesize 16384");
        expect(command).toContain("head -c 4096");
        expect(command).toContain("head -c 16384");
        expect(command).not.toContain("pg_isready");
        expect(command).not.toContain("Not detected");
        expect(command).not.toContain("> /dev/null");
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

    test("upgrade_status rejects missing or invalid transaction_id before SSH", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        await expect(tool.invoke({ action: "upgrade_status" }))
            .rejects.toThrow("'transaction_id' required");
        expect(ssh.commands).toHaveLength(0);

        for (const invalid of ["not-a-uuid", "11111111-1111-1111-8111-111111111111", "550e8400-e29b-41d4-a716-44665544000g"]) {
            await expect(tool.invoke({ action: "upgrade_status", transaction_id: invalid }))
                .rejects.toThrow("Invalid 'transaction_id': must be a valid UUID v4");
            expect(ssh.commands).toHaveLength(0);
        }
    });

    test("upgrade_status schema includes transaction_id and action help", () => {
        const tool = captureSshTool(new FakeSsh());
        const parsed = tool.parse({
            action: "upgrade_status",
            transaction_id: "550E8400-E29B-41D4-A716-446655440000",
        });
        expect(parsed.action).toBe("upgrade_status");
        expect(parsed.transaction_id).toBe("550E8400-E29B-41D4-A716-446655440000");
    });

    test("backup cleanup plan is read-only and pins the managed backup root", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        await tool.invoke({
            action: "backup_cleanup_plan",
            before: "2026-09-03",
            keep_latest: 2,
        });

        expect(ssh.commands).toHaveLength(1);
        const command = ssh.commands[0]!;
        expect(command).toContain("ROOT='/opt/supacloud/backups'");
        expect(command).toContain("sort -t $'\\t' -k1,1r");
        expect(command).toContain("NR > keep");
        expect(command).toContain("committed|rolled_back");
        expect(command).not.toContain("find -P -- \\\"$path\\\" -xdev -depth -delete");
    });

    test("backup cleanup apply requires an exact plan digest and uses a bounded delete", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        await tool.invoke({
            action: "backup_cleanup_apply",
            before: "2026-09-03",
            keep_latest: 2,
            plan_sha256: "a".repeat(64),
        });

        const command = ssh.commands[0]!;
        expect(command).toContain("expected='" + "a".repeat(64) + "'");
        expect(command).toContain("plan_sha256 mismatch; refusing cleanup");
        expect(command).toContain('find -P -- "$path" -xdev -depth -delete');
        expect(command).toContain('case "$path" in "$ROOT"/supacloud-*)');
    });

    test("backup cleanup rejects invalid dates, retention counts, and digests before SSH", async () => {
        const ssh = new FakeSsh();
        const tool = captureSshTool(ssh);

        for (const before of ["2026-02-30", "20260903"]) {
            await expect(tool.invoke({ action: "backup_cleanup_plan", before }))
                .rejects.toThrow("before");
        }
        await expect(tool.invoke({ action: "backup_cleanup_plan", before: "2026-09-03;rm" }))
            .rejects.toThrow("before");
        for (const keep_latest of [0, 101, 1.5]) {
            await expect(tool.invoke({ action: "backup_cleanup_plan", before: "2026-09-03", keep_latest }))
                .rejects.toThrow("keep_latest");
        }
        expect(() => tool.invoke({ action: "backup_cleanup_plan", before: "2026-09-03", keep_latest: "2" }))
            .toThrow("Expected number");
        await expect(tool.invoke({ action: "backup_cleanup_apply", before: "2026-09-03" }))
            .rejects.toThrow("plan_sha256");
        await expect(tool.invoke({
            action: "backup_cleanup_apply",
            before: "2026-09-03",
            plan_sha256: "A".repeat(64),
        })).rejects.toThrow("lowercase SHA-256");
        expect(ssh.commands).toHaveLength(0);
    });

});
