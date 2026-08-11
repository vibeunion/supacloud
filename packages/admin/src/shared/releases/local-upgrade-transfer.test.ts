import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    adoptRemoteDrop,
    awaitRemoteUpgrade,
    buildAdoptDropScript,
    buildCleanupUnstartedUpgradeScript,
    buildLocalUpgradeRunScript,
    buildPrepareDropCommand,
    buildRemotePreflightScript,
    buildRemoteUpgradePaths,
    buildRemoteStateScript,
    buildUploadDropCleanupFailure,
    buildUpgradeLockScript,
    failureRequiresRemoteReconciliation,
    parseRemotePreflight,
    remoteUpgradePreflight,
    startRemoteUpgrade,
} from "./local-upgrade-transfer";
import { githubCliArchiveIdentity, type LocalUpgradeFile, type PreparedLocalUpgradeBundle } from "./local-upgrade-bundle";

const paths = {
    drop: "/var/tmp/.supacloud-upgrade-upload-11111111-1111-4111-8111-111111111111",
    stage: "/var/lib/supacloud/upgrade-staging/11111111-1111-4111-8111-111111111111",
    status: "/var/lib/supacloud/upgrade-runs/11111111-1111-4111-8111-111111111111.status",
    log: "/var/log/supacloud/upgrade-11111111-1111-4111-8111-111111111111.log",
    unit: "supacloud-upgrade-11111111-1111-4111-8111-111111111111.service",
};

type ScriptedResult = { success: boolean; stdout: string; stderr: string; code: number };
type ScriptedResponse = ScriptedResult | Error;

class ScriptedSsh {
    readonly commands: string[] = [];
    readonly timeouts: number[] = [];

    constructor(private readonly responses: ScriptedResponse[]) {}

    async exec(command: string, timeoutMs: number): Promise<ScriptedResult> {
        this.commands.push(command);
        this.timeouts.push(timeoutMs);
        const response = this.responses.shift();
        if (!response) throw new Error("Unexpected SSH command in lifecycle test");
        if (response instanceof Error) throw response;
        return response;
    }
}

function remoteResult(stdout = "", success = true): ScriptedResult {
    return { success, stdout, stderr: success ? "" : "remote failure", code: success ? 0 : 1 };
}

type RemoteStateFixture = {
    dropExists?: boolean;
    logExists?: boolean;
    serviceState: string;
    stageExists?: boolean;
    stageIsDirectory?: boolean;
    status: string;
    statusExists?: boolean;
    unitExists?: boolean;
    unitLoadState?: string;
};

function remoteState(fixture: RemoteStateFixture): ScriptedResult {
    const statusExists = fixture.statusExists ?? fixture.status.length > 0;
    const logExists = fixture.logExists ?? statusExists;
    const unitExists = fixture.unitExists
        ?? !["inactive", "unknown"].includes(fixture.serviceState);
    const unitLoadState = fixture.unitLoadState ?? (unitExists ? "loaded" : "not-found");
    return remoteResult([
        `STATUS=${fixture.status}`,
        `UNIT=${fixture.serviceState}`,
        `STAGE_EXISTS=${fixture.stageExists ? "yes" : "no"}`,
        `STAGE_DIRECTORY=${fixture.stageIsDirectory ?? fixture.stageExists ? "yes" : "no"}`,
        `DROP_EXISTS=${fixture.dropExists ? "yes" : "no"}`,
        `STATUS_EXISTS=${statusExists ? "yes" : "no"}`,
        `LOG_EXISTS=${logExists ? "yes" : "no"}`,
        `UNIT_EXISTS=${unitExists ? "yes" : "no"}`,
        `UNIT_LOAD=${unitLoadState}`,
        "",
    ].join("\n"));
}

function fixtureFile(relativePath: string, index: number): LocalUpgradeFile {
    return {
        localPath: `/tmp/local-bundle/${relativePath}`,
        relativePath,
        sha256: index.toString(16).padStart(64, "0"),
        size: 1_000 + index,
    };
}

function preparedBundle(architecture: "amd64" | "arm64", verifier: "installed" | "bundled"): PreparedLocalUpgradeBundle {
    const managementBinaryName = `supacloud-linux-${architecture}`;
    const edgeRuntimeBinaryName = `supacloud-edge-runtime-linux-${architecture}`;
    const componentPaths = [
        "bundle/management-api/SUPACLOUD-RELEASE.json",
        "bundle/management-api/SUPACLOUD-RELEASE.attestation.jsonl",
        "bundle/management-api/SHA256SUMS",
        `bundle/management-api/${managementBinaryName}`,
        "bundle/management-api/web-console-build.tar.gz",
        "bundle/edge-runtime/SUPACLOUD-RELEASE.json",
        "bundle/edge-runtime/SUPACLOUD-RELEASE.attestation.jsonl",
        "bundle/edge-runtime/SHA256SUMS",
        `bundle/edge-runtime/${edgeRuntimeBinaryName}`,
    ];
    const identity = githubCliArchiveIdentity(architecture);
    return {
        directory: "/tmp/local-bundle",
        files: componentPaths.map((relativePath, index) => fixtureFile(relativePath, index + 1)),
        verifierArchive: verifier === "bundled" ? {
            localPath: `/tmp/local-bundle/verifier/${identity.archiveName}`,
            relativePath: `verifier/${identity.archiveName}`,
            sha256: identity.sha256,
            size: 10_000,
        } : null,
        managementBinaryName,
        edgeRuntimeBinaryName,
    };
}

function runScript(bundle: PreparedLocalUpgradeBundle, architecture: "amd64" | "arm64"): string {
    return buildLocalUpgradeRunScript(paths, bundle, {
        managementVersion: "0.50.31",
        edgeRuntimeVersion: "0.16.8",
    }, architecture);
}

function shellFunctionDefinition(script: string, functionName: string): string {
    const lines = script.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`${functionName}()`));
    if (start < 0) throw new Error(`Generated script does not define ${functionName}`);
    let braceDepth = 0;
    for (let index = start; index < lines.length; index += 1) {
        const currentLine = lines[index] || "";
        braceDepth += (currentLine.match(/{/g) || []).length - (currentLine.match(/}/g) || []).length;
        if (braceDepth === 0) return lines.slice(start, index + 1).join("\n");
    }
    throw new Error(`Generated shell function ${functionName} is incomplete`);
}

function prepareDropFixtureShell(command: string, overrides: string[] = []): string {
    return [
        "stat() {",
        "  if [ \"$3\" = /var/tmp ]; then",
        "    case \"$2\" in %u) printf '%s\\n' \"$UPLOAD_ROOT_UID\" ;; %a) printf '%s\\n' \"$UPLOAD_ROOT_MODE\" ;; esac",
        "    return",
        "  fi",
        "  command stat \"$@\"",
        "}",
        "df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted-on\\n/dev/test 9999999 0 9999999 0%% %s\\n' \"$2\"; }",
        ...overrides,
        command,
    ].join("\n");
}

function prepareDropFixtureEnv(overrides: Record<string, string> = {}): Record<string, string> {
    return { ...process.env, UPLOAD_ROOT_UID: "0", UPLOAD_ROOT_MODE: "1777", ...overrides } as Record<string, string>;
}

describe("local upgrade remote runner", () => {
    test("places SFTP upload drops under the shared sticky temporary root", () => {
        expect(buildRemoteUpgradePaths("11111111-1111-4111-8111-111111111111").drop)
            .toBe(paths.drop);
    });

    test("preflights strict verifier capability without requiring the old jq parser", () => {
        const script = buildRemotePreflightScript();

        expect(Bun.spawnSync(["bash", "-n", "-c", script]).exitCode).toBe(0);
        expect(script).toContain("--deny-self-hosted-runners");
        expect(script).toContain("--custom-trusted-root");
        expect(script).toContain("timeout 15s \"$GH\" attestation verify --help");
        expect(script).toContain("mode=$(stat -c '%a' \"$verifier\")");
        expect(script).toContain("trusted_installed_gh \"$GH\"");
        expect(script).toContain("timeout flock");
        expect(script).toContain("tail -n 0 -- /dev/null");
        expect(script).not.toContain("Required local-upgrade tool is missing: jq");
        expect(parseRemotePreflight("ARCH=arm64\nVERIFIER=installed\n")).toEqual({
            architecture: "arm64",
            verifierProvisioning: "installed",
        });
    });

    test("local-transfer preflight parses quoted Edge Runtime mode without awk escape warnings", () => {
        const fixtureDirectory = mkdtempSync(join(tmpdir(), "supacloud-local-edge-mode-"));
        const envFile = join(fixtureDirectory, "management-api.env");
        const script = buildRemotePreflightScript();
        const edgeModeAssignment = script.split("\n").find(line => line.startsWith("EDGE_MODE="));
        if (!edgeModeAssignment) throw new Error("Generated local-transfer preflight does not read EDGE_RUNTIME_MODE");
        const fixtureEdgeModeAssignment = edgeModeAssignment.replace("/etc/supabase/management-api.env", '"$ENV_FILE"');
        expect(fixtureEdgeModeAssignment).toContain(String.raw`\042\047`);
        expect(fixtureEdgeModeAssignment).not.toContain(String.raw`\"`);
        try {
            for (const configuredValue of ["external", '"external"', "'external'", "  external  "]) {
                writeFileSync(envFile, `EDGE_RUNTIME_MODE=${configuredValue}\n`);
                const execution = Bun.spawnSync(["bash", "-c", [
                    "set -euo pipefail", fixtureEdgeModeAssignment, "printf '%s' \"$EDGE_MODE\"",
                ].join("\n")], { env: { ...process.env, ENV_FILE: envFile } });
                expect(execution.exitCode).toBe(0);
                expect(execution.stdout.toString()).toBe("external");
                expect(execution.stderr.toString()).toBe("");
            }
        } finally {
            rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });

    test("serializes independent run IDs with one host-wide upgrade lock", () => {
        const firstRun = runScript(preparedBundle("amd64", "installed"), "amd64");
        const secondRun = buildLocalUpgradeRunScript({
            ...paths,
            stage: "/var/lib/supacloud/upgrade-staging/22222222-2222-4222-8222-222222222222",
            status: "/var/lib/supacloud/upgrade-runs/22222222-2222-4222-8222-222222222222.status",
            log: "/var/log/supacloud/upgrade-22222222-2222-4222-8222-222222222222.log",
            unit: "supacloud-upgrade-22222222-2222-4222-8222-222222222222.service",
        }, preparedBundle("amd64", "installed"), {
            managementVersion: "0.50.31", edgeRuntimeVersion: "0.16.8",
        }, "amd64");
        expect(firstRun).toContain("/run/lock/supacloud-upgrade.lock");
        expect(secondRun).toContain("/run/lock/supacloud-upgrade.lock");
        if (!Bun.which("flock")) return;

        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-upgrade-lock-")));
        const lockPath = join(fixtureRoot, "upgrade.lock");
        const execution = Bun.spawnSync(["bash", "-c", [
            "umask 077",
            `exec 8>${JSON.stringify(lockPath)}`,
            "flock -n 8",
            "set +e",
            `( ${buildUpgradeLockScript(lockPath)} )`,
            "code=$?",
            "test \"$code\" -eq 75",
        ].join("\n")]);
        try {
            expect(execution.exitCode).toBe(0);
            expect(execution.stderr.toString()).toContain("already running");
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("trusts only root-owned installed verifiers without writable or special permission bits", () => {
        const trustFunction = shellFunctionDefinition(buildRemotePreflightScript(), "trusted_installed_gh");
        const fixtureDirectory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-remote-gh-")));
        const executable = join(fixtureDirectory, "gh");
        const symlink = join(fixtureDirectory, "gh-link");
        writeFileSync(executable, "#!/bin/sh\nexit 0\n");
        chmodSync(executable, 0o755);
        symlinkSync(executable, symlink);
        const gateScript = [
            "stat() { case \"$2\" in '%u:%g') printf '%s\\n' \"$GH_OWNER\" ;; '%a') printf '%s\\n' \"$GH_MODE\" ;; *) return 1 ;; esac; }",
            trustFunction,
            "trusted_installed_gh \"$GH\"",
        ].join("\n");
        const runGate = (gh: string, owner: string, mode: string) => Bun.spawnSync({
            cmd: ["bash", "-c", gateScript],
            env: { ...process.env, GH: gh, GH_OWNER: owner, GH_MODE: mode },
        }).exitCode;
        try {
            expect(runGate(executable, "0:0", "755")).toBe(0);
            expect(runGate(executable, "0:0", "750")).toBe(0);
            expect(runGate(executable, "1000:1000", "755")).not.toBe(0);
            expect(runGate(executable, "0:0", "775")).not.toBe(0);
            expect(runGate(executable, "0:0", "757")).not.toBe(0);
            expect(runGate(executable, "0:0", "4755")).not.toBe(0);
            expect(runGate(symlink, "0:0", "755")).not.toBe(0);
        } finally {
            rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });

    test("executes and parses the remote preflight before preparing artifacts", async () => {
        const ssh = new ScriptedSsh([remoteResult("ARCH=amd64\nVERIFIER=bundled\n")]);

        await expect(remoteUpgradePreflight(ssh as never)).resolves.toEqual({
            architecture: "amd64",
            verifierProvisioning: "bundled",
        });
        expect(ssh.commands).toHaveLength(1);
        expect(ssh.commands[0]).toContain("sudo -n /bin/bash -c");
        expect(ssh.commands[0]).toContain("EDGE_RUNTIME_MODE");

        const failedSsh = new ScriptedSsh([remoteResult("", false)]);
        await expect(remoteUpgradePreflight(failedSsh as never)).rejects.toThrow("preflight failed");
    });

    test("uses a syntax-valid transfer check before the target Management offline verifier", () => {
        const script = runScript(preparedBundle("amd64", "bundled"), "amd64");
        const syntax = Bun.spawnSync(["bash", "-n", "-c", script]);

        expect(syntax.exitCode).toBe(0);
        expect(script).toContain("verify_transfer 'bundle/management-api/SUPACLOUD-RELEASE.json'");
        expect(script).toContain("verify_transfer 'bundle/edge-runtime/supacloud-edge-runtime-linux-amd64'");
        expect(script).toContain("--deny-self-hosted-runners");
        expect(script).toContain("--asset-bundle-dir \"$BUNDLE\"");
        expect(script).toContain("--target-version '0.50.31'");
        expect(script).toContain("--edge-runtime-version '0.16.8'");
        expect(script).toContain("unset SUPACLOUD_ALLOW_UNVERIFIED_RELEASE");
        expect(script).toContain("SUPACLOUD_ATTESTATION_TRUSTED_ROOT");
        expect(script).not.toContain("verify_manifest()");
        expect(script).not.toContain("MANAGEMENT_COMMIT");
        expect(script).not.toContain("jq ");
    });

    test("executes transfer verification with nounset enabled", () => {
        const script = runScript(preparedBundle("amd64", "bundled"), "amd64");
        const verifyTransfer = shellFunctionDefinition(script, "verify_transfer");
        const execution = Bun.spawnSync({
            cmd: ["bash", "-c", [
                "set -euo pipefail",
                "stat() { test \"$3\" = \"$EXPECTED_PATH\"; printf '%s\\n' \"$FILE_SIZE\"; }",
                "sha256sum() { test \"$1\" = \"$EXPECTED_PATH\"; printf '%s  %s\\n' \"$FILE_SHA\" \"$1\"; }",
                verifyTransfer,
                "verify_transfer \"$RELATIVE\" \"$FILE_SIZE\" \"$FILE_SHA\"",
            ].join("\n")],
            env: {
                ...process.env,
                EXPECTED_PATH: "/stage/bundle/management-api/artifact",
                FILE_SHA: "a".repeat(64),
                FILE_SIZE: "1234",
                RELATIVE: "bundle/management-api/artifact",
                STAGE: "/stage",
            },
        });

        expect(execution.exitCode).toBe(0);
        expect(execution.stderr.toString()).toBe("");
    });

    test("keeps the signed bundle immutable and reports cleanup failures as failures", () => {
        const script = runScript(preparedBundle("amd64", "bundled"), "amd64");

        expect(script).toContain("install -m 0755 \"$RUNNER_ASSET\" \"$RUNNER\"");
        expect(script).not.toContain("chmod 0755 \"$RUNNER_ASSET\"");
        expect(script).toContain("stat -c '%u:%g:%h'");
        expect(script).toContain("stat -c '%a' \"$path\")\" = '600'");
        expect(script).toContain("stat -c '%a' \"$path\")\" = '700'");
        expect(script).not.toContain("stat -c '%u:%g:%a'");
        expect(script).toContain("trap finish_upgrade EXIT");
        expect(script).toContain("write_status CLEANING");
        expect(script).toContain("FAILED:1:CLEANUP_AFTER_TRANSACTION");
        expect(script).toContain([
            "write_status CLEANING || { echo 'Unable to publish cleanup state' >&2; exit 1; }",
            "  if ! rm -rf -- \"$STAGE\"; then",
            "    write_status 'FAILED:1:CLEANUP_AFTER_TRANSACTION' || true",
            "    exit 1",
            "  fi",
            "  write_status SUCCEEDED || exit 1",
        ].join("\n"));
        expect(script).not.toContain("RuntimeMaxSec");
        expect(script).not.toContain("curl ");
        expect(script).not.toContain("wget ");
        expect(script).not.toContain("systemctl stop");
    });

    test("rejects special permission bits in the remote staging tree", () => {
        const script = runScript(preparedBundle("amd64", "bundled"), "amd64");
        const modeGateDefinitions = script.split("\n")
            .filter((line) => line.startsWith("assert_directory()") || line.startsWith("assert_file()"))
            .join("\n");
        const fixtureDirectory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-remote-mode-")));
        const fixtureFile = join(fixtureDirectory, "artifact");
        writeFileSync(fixtureFile, "verified");
        const gateScript = [
            "set -e",
            "stat() { case \"$2\" in '%u:%g') printf '0:0\\n' ;; '%u:%g:%h') printf '0:0:1\\n' ;; '%a') if [ \"$3\" = \"$FILE\" ]; then printf '%s\\n' \"$FILE_MODE\"; else printf '%s\\n' \"$DIRECTORY_MODE\"; fi ;; *) return 1 ;; esac; }",
            modeGateDefinitions,
            "assert_directory \"$DIRECTORY\"",
            "assert_file \"$FILE\" \"$DIRECTORY\"",
        ].join("\n");
        const runGate = (directoryMode: string, fileMode: string) => Bun.spawnSync({
            cmd: ["bash", "-c", gateScript],
            env: { ...process.env, DIRECTORY: fixtureDirectory, FILE: fixtureFile, DIRECTORY_MODE: directoryMode, FILE_MODE: fileMode },
        }).exitCode;
        try {
            expect(runGate("700", "600")).toBe(0);
            expect(runGate("1700", "600")).not.toBe(0);
            expect(runGate("700", "4600")).not.toBe(0);
        } finally {
            rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });

    test("publishes terminal status directly from the generated cleanup lifecycle", () => {
        const script = runScript(preparedBundle("amd64", "bundled"), "amd64");
        const lifecycleFunctions = [
            shellFunctionDefinition(script, "write_status"),
            shellFunctionDefinition(script, "finish_upgrade"),
        ].join("\n");
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-lifecycle-")));
        const runLifecycle = (caseName: string, transactionCode: number, cleanupMode: "normal" | "fail") => {
            const stage = join(fixtureRoot, `${caseName}.stage`);
            const status = join(fixtureRoot, `${caseName}.status`);
            mkdirSync(stage, { mode: 0o700 });
            const cleanupOverride = cleanupMode === "fail"
                ? "rm() { if [ \"$1 $2 $3\" = \"-rf -- $STAGE\" ]; then return 1; fi; command rm \"$@\"; }"
                : "";
            const execution = Bun.spawnSync({
                cmd: ["bash", "-c", ["set -euo pipefail", lifecycleFunctions, cleanupOverride,
                    "trap finish_upgrade EXIT", `exit ${transactionCode}`].filter(Boolean).join("\n")],
                env: { ...process.env, STAGE: stage, STATUS: status },
            });
            return { exitCode: execution.exitCode, stageExists: existsSync(stage), status: readFileSync(status, "utf8").trim() };
        };
        try {
            expect(runLifecycle("success", 0, "normal")).toEqual({ exitCode: 0, stageExists: false, status: "SUCCEEDED" });
            expect(runLifecycle("transaction", 9, "normal")).toEqual({ exitCode: 9, stageExists: false, status: "FAILED:9:TRANSACTION" });
            expect(runLifecycle("cleanup", 0, "fail")).toEqual({ exitCode: 1, stageExists: true, status: "FAILED:1:CLEANUP_AFTER_TRANSACTION" });
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("converts TERM into a failed transaction and runs stage cleanup", () => {
        const script = runScript(preparedBundle("amd64", "bundled"), "amd64");
        const lifecycleFunctions = [
            shellFunctionDefinition(script, "write_status"),
            shellFunctionDefinition(script, "finish_upgrade"),
        ].join("\n");
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-runtime-term-")));
        const stage = join(fixtureRoot, "stage");
        const status = join(fixtureRoot, "run.status");
        mkdirSync(stage, { mode: 0o700 });
        const execution = Bun.spawnSync({
            cmd: ["bash", "-c", [
                "set -euo pipefail", lifecycleFunctions,
                "trap finish_upgrade EXIT", "trap 'exit 143' TERM", "kill -TERM $$",
            ].join("\n")],
            env: { ...process.env, STAGE: stage, STATUS: status },
        });
        try {
            expect(execution.exitCode).toBe(143);
            expect(existsSync(stage)).toBe(false);
            expect(readFileSync(status, "utf8").trim()).toBe("FAILED:143:TRANSACTION");
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("ignores a second TERM while the finalizer publishes success", () => {
        const script = runScript(preparedBundle("amd64", "bundled"), "amd64");
        const finishFunction = shellFunctionDefinition(script, "finish_upgrade");
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-finalizer-term-")));
        const stage = join(fixtureRoot, "stage");
        const status = join(fixtureRoot, "run.status");
        mkdirSync(stage, { mode: 0o700 });
        const execution = Bun.spawnSync({
            cmd: ["bash", "-c", [
                "set -euo pipefail",
                "write_status() { printf '%s\\n' \"$1\" > \"$STATUS\"; if [ \"$1\" = SUCCEEDED ]; then kill -TERM \"$$\"; fi; }",
                finishFunction, "trap finish_upgrade EXIT", "trap 'exit 143' TERM", "exit 0",
            ].join("\n")],
            env: { ...process.env, STAGE: stage, STATUS: status },
        });
        try {
            expect(execution.exitCode).toBe(0);
            expect(existsSync(stage)).toBe(false);
            expect(readFileSync(status, "utf8").trim()).toBe("SUCCEEDED");
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("uses a remote verifier when capable and uploads the pinned verifier only when needed", () => {
        const installed = runScript(preparedBundle("amd64", "installed"), "amd64");
        const bundled = runScript(preparedBundle("amd64", "bundled"), "amd64");

        expect(installed).toContain("GH=$(type -P gh)");
        expect(installed).toContain("trusted_installed_gh \"$GH\"");
        expect(installed).toContain("Installed GitHub verifier has special permission bits");
        expect(installed).not.toContain("gh_2.96.0_linux_amd64.tar.gz");
        expect(bundled).toContain("gh_2.96.0_linux_amd64.tar.gz");
        expect(bundled).toContain("83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60");
        expect(bundled).toContain("tar --no-same-owner --same-permissions");
        expect(bundled).toContain("stat -c '%a' \"$VERIFIER_ROOT/$GH_MEMBER\")\" = '755'");
        expect(bundled).not.toContain("--no-same-permissions");
    });

    test("rejects a dangling upload-drop symlink before creating directories", () => {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-prepare-drop-")));
        const fixturePaths = { ...paths, drop: join(fixtureRoot, "drop") };
        symlinkSync(join(fixtureRoot, "missing-drop-target"), fixturePaths.drop);

        const prepareCommand = buildPrepareDropCommand(fixturePaths, preparedBundle("amd64", "installed"));
        const fixtureCommand = prepareDropFixtureShell(prepareCommand);

        const execution = Bun.spawnSync({ cmd: ["bash", "-c", fixtureCommand], env: prepareDropFixtureEnv() });
        try {
            expect(execution.exitCode).not.toBe(0);
            expect(execution.stderr.toString()).toContain("Unable to create exclusive remote upload drop");
            expect(lstatSync(fixturePaths.drop).isSymbolicLink()).toBe(true);
            expect(prepareCommand).toContain("UPLOAD_ROOT='/var/tmp'");
            expect(prepareCommand).toContain("stat -c '%u' \"$UPLOAD_ROOT\"");
            expect(prepareCommand).toContain("8#$UPLOAD_ROOT_MODE & 01000");
            expect(prepareCommand).toContain("df -Pk \"$UPLOAD_ROOT\"");
            expect(prepareCommand).toContain("mkdir -m 700 -- \"$DROP\"");
            expect(prepareCommand).not.toContain(`install -d -m 700 '${fixturePaths.drop}'`);
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("requires a root-owned sticky upload root", () => {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-upload-root-gate-")));
        const fixturePaths = { ...paths, drop: join(fixtureRoot, "drop") };
        const command = prepareDropFixtureShell(
            buildPrepareDropCommand(fixturePaths, preparedBundle("amd64", "installed")),
        );
        try {
            const wrongOwner = Bun.spawnSync({
                cmd: ["bash", "-c", command],
                env: prepareDropFixtureEnv({ UPLOAD_ROOT_UID: "1001" }),
            });
            expect(wrongOwner.exitCode).not.toBe(0);
            expect(wrongOwner.stderr.toString()).toContain("Remote upload root must be owned by root");

            const missingStickyBit = Bun.spawnSync({
                cmd: ["bash", "-c", command],
                env: prepareDropFixtureEnv({ UPLOAD_ROOT_MODE: "0777" }),
            });
            expect(missingStickyBit.exitCode).not.toBe(0);
            expect(missingStickyBit.stderr.toString()).toContain("Remote upload root must set the sticky bit");
            expect(existsSync(fixturePaths.drop)).toBe(false);
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("creates a private drop atomically after the upload-root gate", () => {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-private-drop-")));
        const fixturePaths = { ...paths, drop: join(fixtureRoot, "drop") };
        const command = prepareDropFixtureShell(
            buildPrepareDropCommand(fixturePaths, preparedBundle("amd64", "bundled")),
        );
        const execution = Bun.spawnSync({ cmd: ["bash", "-c", command], env: prepareDropFixtureEnv() });
        try {
            expect(execution.exitCode).toBe(0);
            for (const directory of [
                fixturePaths.drop,
                `${fixturePaths.drop}/bundle`,
                `${fixturePaths.drop}/bundle/management-api`,
                `${fixturePaths.drop}/bundle/edge-runtime`,
                `${fixturePaths.drop}/verifier`,
            ]) {
                expect(lstatSync(directory).mode & 0o777).toBe(0o700);
            }
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("does not follow a symlink injected at atomic drop creation", () => {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-drop-race-")));
        const raceTarget = join(fixtureRoot, "race-target");
        const sentinel = join(raceTarget, "sentinel");
        const fixturePaths = { ...paths, drop: join(fixtureRoot, "drop") };
        mkdirSync(raceTarget, { mode: 0o700 });
        writeFileSync(sentinel, "unchanged\n");
        const command = prepareDropFixtureShell(
            buildPrepareDropCommand(fixturePaths, preparedBundle("amd64", "installed")),
            ["mkdir() { ln -s \"$RACE_TARGET\" \"$DROP\"; command mkdir \"$@\"; }"],
        );
        const execution = Bun.spawnSync({
            cmd: ["bash", "-c", command],
            env: prepareDropFixtureEnv({ RACE_TARGET: raceTarget }),
        });
        try {
            expect(execution.exitCode).not.toBe(0);
            expect(execution.stderr.toString()).toContain("Unable to create exclusive remote upload drop");
            expect(lstatSync(fixturePaths.drop).isSymbolicLink()).toBe(true);
            expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("requires reconciliation when a failed upload drop cannot be cleaned", () => {
        const failure = buildUploadDropCleanupFailure(
            new Error("SFTP upload failed"),
            new Error("remote drop cleanup failed"),
            paths,
        );

        expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
        expect(String(failure)).toContain("do not retry blindly");
        for (const evidencePath of [paths.drop, paths.stage, paths.status, paths.log, paths.unit]) {
            expect(String(failure)).toContain(evidencePath);
        }
        const diagnostics = (failure as AggregateError).errors.map(String).join("\n");
        expect(diagnostics).toContain("SFTP upload failed");
        expect(diagnostics).toContain("remote drop cleanup failed");
    });

    test("rejects dangling adoption targets before moving the upload drop", () => {
        for (const blockedPath of ["stage", "status", "log"] as const) {
            const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), `supacloud-adopt-${blockedPath}-`)));
            const fixturePaths = {
                drop: join(fixtureRoot, "drop"), stage: join(fixtureRoot, "stage"),
                status: join(fixtureRoot, "run.status"), log: join(fixtureRoot, "run.log"),
                unit: "supacloud-upgrade-test.service",
            };
            mkdirSync(fixturePaths.drop, { mode: 0o700 });
            symlinkSync(join(fixtureRoot, `missing-${blockedPath}-target`), fixturePaths[blockedPath]);
            const execution = Bun.spawnSync(["bash", "-c", [
                "install() { return 0; }", "systemctl() { return 1; }",
                buildAdoptDropScript(fixturePaths),
            ].join("\n")]);
            try {
                expect(execution.exitCode).not.toBe(0);
                expect(existsSync(fixturePaths.drop)).toBe(true);
                expect(lstatSync(fixturePaths[blockedPath]).isSymbolicLink()).toBe(true);
            } finally {
                rmSync(fixtureRoot, { recursive: true, force: true });
            }
        }
    });

    test("reports dangling remote evidence without treating a stage symlink as a directory", () => {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-state-symlinks-")));
        const fixturePaths = {
            drop: join(fixtureRoot, "drop"), stage: join(fixtureRoot, "stage"),
            status: join(fixtureRoot, "run.status"), log: join(fixtureRoot, "run.log"),
            unit: "supacloud-upgrade-test.service",
        };
        for (const evidencePath of [fixturePaths.drop, fixturePaths.stage, fixturePaths.status, fixturePaths.log]) {
            symlinkSync(join(fixtureRoot, `missing-${evidencePath.split("/").at(-1)}-target`), evidencePath);
        }
        const execution = Bun.spawnSync(["bash", "-c", [
            "systemctl() { if [ \"$1\" = is-active ]; then echo inactive; return 3; fi; echo loaded; }",
            buildRemoteStateScript(fixturePaths),
        ].join("\n")]);
        try {
            expect(execution.exitCode).toBe(0);
            const output = execution.stdout.toString();
            for (const field of ["STAGE_EXISTS", "DROP_EXISTS", "STATUS_EXISTS", "LOG_EXISTS"]) {
                expect(output).toContain(`${field}=yes`);
            }
            expect(output).toContain("STAGE_DIRECTORY=no");
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("rolls back stage and records when adoption fails after the move", () => {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-adopt-rollback-")));
        const fixturePaths = {
            drop: join(fixtureRoot, "drop"),
            stage: join(fixtureRoot, "stage"),
            status: join(fixtureRoot, "run.status"),
            log: join(fixtureRoot, "run.log"),
            unit: "supacloud-upgrade-test.service",
        };
        mkdirSync(fixturePaths.drop, { mode: 0o700 });
        const execution = Bun.spawnSync(["bash", "-c", [
            "install() { return 0; }",
            "systemctl() { return 1; }",
            "chown() { return 0; }",
            "chmod() { return 42; }",
            buildAdoptDropScript(fixturePaths),
        ].join("\n")]);
        try {
            expect(execution.exitCode).not.toBe(0);
            expect(execution.stderr.toString()).toContain("transferred state was rolled back");
            expect(existsSync(fixturePaths.stage)).toBe(false);
            expect(existsSync(fixturePaths.status)).toBe(false);
            expect(existsSync(fixturePaths.log)).toBe(false);
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("reports both adoption and rollback failure diagnostics", () => {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-adopt-cleanup-")));
        const fixturePaths = {
            drop: join(fixtureRoot, "drop"), stage: join(fixtureRoot, "stage"),
            status: join(fixtureRoot, "run.status"), log: join(fixtureRoot, "run.log"),
            unit: "supacloud-upgrade-test.service",
        };
        mkdirSync(fixturePaths.drop, { mode: 0o700 });
        const execution = Bun.spawnSync({
            cmd: ["bash", "-c", [
                "install() { return 0; }", "systemctl() { return 1; }", "chown() { return 0; }",
                "chmod() { return 42; }",
                "rm() { if [ \"$1 $2 $3\" = \"-rf -- $STAGE\" ]; then return 77; fi; command rm \"$@\"; }",
                buildAdoptDropScript(fixturePaths),
            ].join("\n")],
        });
        try {
            expect(execution.exitCode).not.toBe(0);
            expect(execution.stderr.toString()).toContain("adoption failed");
            expect(execution.stderr.toString()).toContain("rollback did not complete");
            expect(existsSync(fixturePaths.stage)).toBe(true);
            expect(existsSync(fixturePaths.status)).toBe(false);
            expect(existsSync(fixturePaths.log)).toBe(false);
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("rolls back an adopted stage and preserves signal exit codes", () => {
        for (const [signal, expectedCode] of [["HUP", 129], ["INT", 130], ["TERM", 143]] as const) {
            const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), `supacloud-adopt-${signal.toLowerCase()}-`)));
            const fixturePaths = {
                drop: join(fixtureRoot, "drop"), stage: join(fixtureRoot, "stage"),
                status: join(fixtureRoot, "run.status"), log: join(fixtureRoot, "run.log"),
                unit: "supacloud-upgrade-test.service",
            };
            mkdirSync(fixturePaths.drop, { mode: 0o700 });
            const execution = Bun.spawnSync(["bash", "-c", [
                "install() { return 0; }", "systemctl() { return 1; }",
                `chown() { kill -${signal} "$$"; }`,
                buildAdoptDropScript(fixturePaths),
            ].join("\n")]);
            try {
                expect(execution.exitCode).toBe(expectedCode);
                expect(execution.stderr.toString()).toContain(`exit ${expectedCode}`);
                expect(existsSync(fixturePaths.stage)).toBe(false);
                expect(existsSync(fixturePaths.status)).toBe(false);
                expect(existsSync(fixturePaths.log)).toBe(false);
            } finally {
                rmSync(fixtureRoot, { recursive: true, force: true });
            }
        }
    });

    test("continues from PREPARED when the adoption SSH result is ambiguous", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH stream closed after adoption"),
            remoteState({ status: "PREPARED", serviceState: "inactive", stageExists: true }),
        ]);

        await expect(adoptRemoteDrop(ssh as never, paths)).resolves.toBeUndefined();
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands[1]).toContain(paths.stage);
        expect(ssh.commands[1]).toContain(paths.drop);
    });

    test("retains remote evidence when interrupted adoption cannot be reconciled", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH stream closed after adoption"),
            new Error("read-back connection failed"),
            new Error("read-back connection failed"),
            new Error("read-back connection failed"),
        ]);

        const failure = await adoptRemoteDrop(ssh as never, paths).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
        expect(String(failure)).toContain("do not retry blindly");
        for (const retainedPath of [paths.stage, paths.status, paths.log, paths.drop, paths.unit]) {
            expect(String(failure)).toContain(retainedPath);
        }
    });

    test("does not clean a drop after an interrupted adoption reads back pre-operation state", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH stream closed before adoption returned"),
            remoteState({
                status: "",
                serviceState: "inactive",
                dropExists: true,
                statusExists: false,
                logExists: false,
                unitExists: false,
            }),
        ]);

        const failure = await adoptRemoteDrop(ssh as never, paths).catch((error: unknown) => error);
        expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
        expect(String(failure)).toContain("outcome is still uncertain");
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.some((command) => command.includes(`rm -rf -- '${paths.drop}'`))).toBe(false);
    });

    test("requires reconciliation when adoption rollback leaves remote records", async () => {
        const ssh = new ScriptedSsh([
            remoteResult("", false),
            remoteState({
                status: "",
                serviceState: "inactive",
                dropExists: true,
                statusExists: true,
                logExists: false,
                unitExists: false,
            }),
        ]);

        const failure = await adoptRemoteDrop(ssh as never, paths).catch((error: unknown) => error);
        expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
        expect(String(failure)).toContain(paths.status);
        expect(String(failure)).toContain("do not retry blindly");
    });

    test("pins the temporary Linux GitHub verifier by architecture", () => {
        const arm64 = runScript(preparedBundle("arm64", "bundled"), "arm64");

        expect(arm64).toContain("gh_2.96.0_linux_arm64.tar.gz");
        expect(arm64).toContain("06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909");
    });

    test("does not delete an adopted stage while systemd is still activating", async () => {
        const ssh = new ScriptedSsh([
            remoteResult("", false),
            remoteState({
                status: "PREPARED", serviceState: "activating", stageExists: true, unitExists: true,
            }),
        ]);

        await expect(startRemoteUpgrade(ssh as never, paths)).resolves.toBeUndefined();
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.some((command) => command.includes("rm -rf --") && command.includes(paths.stage))).toBe(false);
    });

    test("continues monitoring when start disconnects after the unit begins", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH stream closed after systemd-run"),
            remoteState({ status: "RUNNING", serviceState: "active", stageExists: true }),
        ]);

        await expect(startRemoteUpgrade(ssh as never, paths)).resolves.toBeUndefined();
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.some((command) => command.includes("rm -rf --") && command.includes(paths.stage))).toBe(false);
    });

    test("does not clean PREPARED state while an inactive transient unit still exists", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH stream closed during systemd-run"),
            remoteState({
                status: "PREPARED",
                serviceState: "inactive",
                stageExists: true,
                unitExists: true,
            }),
        ]);

        const failure = await startRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
        expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.some((command) => command.includes("rm -rf --") && command.includes(paths.stage))).toBe(false);
    });

    test("does not clean PREPARED state after an interrupted start remains inactive", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH stream closed before systemd-run returned"),
            remoteState({
                status: "PREPARED",
                serviceState: "inactive",
                stageExists: true,
                unitExists: false,
            }),
        ]);

        const failure = await startRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
        expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
        expect(String(failure)).toContain("outcome is still uncertain");
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.some((command) => command.includes("rm -rf --") && command.includes(paths.stage))).toBe(false);
    });

    test("preserves start and cleanup failures when an unstarted unit cannot be removed", async () => {
        const ssh = new ScriptedSsh([
            remoteResult("", false),
            remoteState({
                status: "PREPARED", serviceState: "inactive", stageExists: true, unitExists: false,
            }),
            remoteResult("", false),
        ]);

        const failure = await startRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        const diagnostics = (failure as AggregateError).errors.map(String).join("\n");
        expect(diagnostics).toContain("Unable to start the transient upgrade unit");
        expect(diagnostics).toContain("Unable to clean an unstarted local upgrade");
        for (const retainedPath of [paths.stage, paths.status, paths.log, paths.drop, paths.unit]) {
            expect(String(failure)).toContain(retainedPath);
        }
    });

    test("reports stage cleanup failure after still removing unstarted records", () => {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-start-cleanup-")));
        const fixturePaths = {
            drop: join(fixtureRoot, "drop"), stage: join(fixtureRoot, "stage"),
            status: join(fixtureRoot, "run.status"), log: join(fixtureRoot, "run.log"),
            unit: "supacloud-upgrade-test.service",
        };
        mkdirSync(fixturePaths.stage, { mode: 0o700 });
        writeFileSync(fixturePaths.status, "PREPARED\n");
        writeFileSync(fixturePaths.log, "start failed\n");
        const execution = Bun.spawnSync(["bash", "-c", [
            "rm() { if [ \"$1 $2 $3\" = \"-rf -- $STAGE_PATH\" ]; then return 77; fi; command rm \"$@\"; }",
            buildCleanupUnstartedUpgradeScript(fixturePaths),
        ].join("\n")], { env: { ...process.env, STAGE_PATH: fixturePaths.stage } });
        try {
            expect(execution.exitCode).not.toBe(0);
            expect(existsSync(fixturePaths.stage)).toBe(true);
            expect(existsSync(fixturePaths.status)).toBe(false);
            expect(existsSync(fixturePaths.log)).toBe(false);
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("reconnects after a transient lifecycle observation failure", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH connection reset while monitoring"),
            remoteState({ status: "SUCCEEDED", serviceState: "inactive", unitExists: false }),
            remoteResult("transaction complete\n"),
            remoteResult(),
        ]);

        await expect(awaitRemoteUpgrade(ssh as never, paths)).resolves.toContain("Upgrade done");
        expect(ssh.commands).toHaveLength(4);
    });

    test("retains status and logs when a successful transaction cannot clean its stage", async () => {
        const ssh = new ScriptedSsh([
            remoteState({
                status: "FAILED:1:CLEANUP_AFTER_TRANSACTION",
                serviceState: "failed",
                stageExists: true,
            }),
            remoteResult("transaction completed; stage cleanup failed\n"),
        ]);

        const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
        expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
        expect(String(failure)).toContain("transaction completed but staging cleanup is incomplete");
        for (const retainedPath of [paths.stage, paths.status, paths.log, paths.drop, paths.unit]) {
            expect(String(failure)).toContain(retainedPath);
        }
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.some((command) => command.includes(`rm -f -- '${paths.status}'`))).toBe(false);
    });

    test("retains evidence when a failed transaction log cannot be read", async () => {
        const ssh = new ScriptedSsh([
            remoteState({
                status: "FAILED:9:TRANSACTION",
                serviceState: "failed",
                stageExists: false,
            }),
            new Error("SSH stream closed while reading the failed transaction log"),
        ]);

        const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
        expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
        expect(String(failure)).toContain("retained log could not be read");
        expect(String(failure)).toContain(paths.status);
        expect(String(failure)).toContain(paths.log);
        expect(String(failure)).toContain("do not retry blindly");
        expect(ssh.commands).toHaveLength(2);
    });

    test("waits for a failed finalizer to stop before validating its stage", async () => {
        const ssh = new ScriptedSsh([
            remoteState({
                status: "FAILED:9:TRANSACTION", serviceState: "active", stageExists: true,
            }),
            remoteState({
                status: "FAILED:9:TRANSACTION", serviceState: "failed", stageExists: false,
            }),
            remoteResult("transaction failed\n"),
            remoteResult(),
        ]);

        const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
        expect(failureRequiresRemoteReconciliation(failure)).toBe(false);
        expect(String(failure)).toContain("FAILED:9:TRANSACTION");
        expect(ssh.commands).toHaveLength(4);
    });

    test("reads and cleans failed transaction evidence after an unambiguous unit stop", async () => {
        for (const [serviceState, unitLoadState, unitExists] of [
            ["failed", "loaded", true],
            ["unknown", "not-found", false],
        ] as const) {
            const ssh = new ScriptedSsh([
                remoteState({ status: "FAILED:9:TRANSACTION", serviceState, unitLoadState, unitExists }),
                remoteResult("transaction failed\n"),
                remoteResult(),
            ]);

            const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
            expect(failureRequiresRemoteReconciliation(failure)).toBe(false);
            expect(String(failure)).toContain("FAILED:9:TRANSACTION");
            expect(ssh.commands).toHaveLength(3);
            expect(ssh.commands[1]).toContain("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
            expect(ssh.commands[1]).toContain('tail -n 80 -- "$LOG"');
            expect(ssh.commands[1]).not.toContain("tail -80 --");
            expect(ssh.commands[2]).toContain("rm -f --");
            expect(ssh.commands[2]).toContain(paths.status);
            expect(ssh.commands[2]).toContain(paths.log);
        }
    });

    test("retains all evidence for ambiguous FAILED unit states", async () => {
        for (const [serviceState, unitLoadState] of [
            ["unknown", "loaded"],
            ["maintenance", "loaded"],
            ["inactive", "unknown"],
        ] as const) {
            const ssh = new ScriptedSsh([
                remoteState({
                    status: "FAILED:9:TRANSACTION",
                    serviceState,
                    unitLoadState,
                }),
            ]);

            const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
            expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
            expect(String(failure)).toContain(`state=${serviceState} load=${unitLoadState}`);
            for (const retainedPath of [paths.stage, paths.status, paths.log, paths.drop, paths.unit]) {
                expect(String(failure)).toContain(retainedPath);
            }
            expect(ssh.commands).toHaveLength(1);
        }
    });

    test("removes terminal records only after a completed unit publishes success", async () => {
        const ssh = new ScriptedSsh([
            remoteState({ status: "SUCCEEDED", serviceState: "inactive", unitExists: false }),
            remoteResult("upgrade committed\n"),
            remoteResult(),
        ]);

        await expect(awaitRemoteUpgrade(ssh as never, paths)).resolves.toContain("Upgrade done");
        expect(ssh.commands).toHaveLength(3);
        expect(ssh.commands[1]).toContain("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        expect(ssh.commands[1]).toContain('tail -n 80 -- "$LOG"');
        expect(ssh.commands[2]).toContain(paths.status);
        expect(ssh.commands[2]).toContain(paths.log);
    });

    test("accepts success after a normal stop or collected transient unit", async () => {
        for (const [serviceState, unitLoadState, unitExists] of [
            ["inactive", "loaded", true],
            ["unknown", "not-found", false],
        ] as const) {
            const ssh = new ScriptedSsh([
                remoteState({ status: "SUCCEEDED", serviceState, unitLoadState, unitExists }),
                remoteResult("upgrade committed\n"),
                remoteResult(),
            ]);

            await expect(awaitRemoteUpgrade(ssh as never, paths)).resolves.toContain("Upgrade done");
            expect(ssh.commands).toHaveLength(3);
        }
    });

    test("requires reconciliation for abnormal or ambiguous SUCCEEDED unit states", async () => {
        for (const [serviceState, unitLoadState] of [
            ["failed", "loaded"],
            ["maintenance", "loaded"],
            ["unknown", "loaded"],
            ["inactive", "unknown"],
        ] as const) {
            const ssh = new ScriptedSsh([
                remoteState({ status: "SUCCEEDED", serviceState, unitLoadState }),
            ]);

            const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
            expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
            expect(String(failure)).toContain(`state=${serviceState} load=${unitLoadState}`);
            expect(String(failure)).toContain("do not retry blindly");
            expect(ssh.commands).toHaveLength(1);
        }
    });

    test("requires reconciliation before reading or deleting incomplete terminal evidence", async () => {
        for (const state of [
            remoteState({ status: "SUCCEEDED", serviceState: "inactive", logExists: false }),
            remoteState({ status: "SUCCEEDED", serviceState: "inactive", stageExists: true }),
            remoteState({ status: "FAILED:9:TRANSACTION", serviceState: "failed", logExists: false }),
            remoteState({ status: "FAILED:9:TRANSACTION", serviceState: "failed", stageExists: true }),
        ]) {
            const ssh = new ScriptedSsh([state]);

            const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
            expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
            expect(String(failure)).toContain("terminal evidence is incomplete or inconsistent");
            expect(String(failure)).toContain("do not retry blindly");
            expect(ssh.commands).toHaveLength(1);
        }
    });

    test("requires reconciliation when successful record cleanup disconnects", async () => {
        const ssh = new ScriptedSsh([
            remoteState({ status: "SUCCEEDED", serviceState: "inactive", unitExists: false }),
            remoteResult("upgrade committed\n"),
            new Error("SSH stream closed during record cleanup"),
        ]);

        const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
        expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
        expect(String(failure)).toContain("cleanup could not be confirmed");
        expect(String(failure)).toContain(paths.status);
        expect(String(failure)).toContain(paths.log);
    });

    test("requires reconciliation when a successful log disappears after state read-back", async () => {
        const ssh = new ScriptedSsh([
            remoteState({ status: "SUCCEEDED", serviceState: "inactive", unitExists: false }),
            remoteResult("", false),
        ]);

        const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
        expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
        expect(String(failure)).toContain("retained log could not be read");
        expect(String(failure)).toContain("do not retry blindly");
        expect(ssh.commands).toHaveLength(2);
    });

    test("stops observing a nonterminal unit without stopping the remote transaction", async () => {
        const now = spyOn(Date, "now")
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(30 * 60_000 - 1_000)
            .mockReturnValue(30 * 60_000);
        const ssh = new ScriptedSsh([
            remoteState({ status: "RUNNING", serviceState: "active", stageExists: true }),
        ]);

        try {
            const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
            expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
            expect(String(failure)).toContain("observation deadline");
            expect(ssh.commands).toHaveLength(1);
            expect(ssh.timeouts).toEqual([1_000]);
            expect(ssh.commands[0]).not.toContain("systemctl stop");
        } finally {
            now.mockRestore();
        }
    });

    test("caps the final poll delay at the remaining observation window", async () => {
        const timeout = spyOn(globalThis, "setTimeout");
        const now = spyOn(Date, "now")
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(30 * 60_000 - 1)
            .mockReturnValueOnce(30 * 60_000 - 1)
            .mockReturnValue(30 * 60_000);
        const ssh = new ScriptedSsh([
            remoteState({ status: "RUNNING", serviceState: "active", stageExists: true }),
        ]);

        try {
            const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
            expect(failureRequiresRemoteReconciliation(failure)).toBe(true);
            expect(String(failure)).toContain("observation deadline");
            expect(ssh.commands).toHaveLength(1);
            expect(timeout.mock.calls.some((call) => call[1] === 1)).toBe(true);
        } finally {
            now.mockRestore();
            timeout.mockRestore();
        }
    });
});
