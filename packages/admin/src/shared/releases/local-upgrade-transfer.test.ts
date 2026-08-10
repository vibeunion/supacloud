import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    adoptRemoteDrop,
    awaitRemoteUpgrade,
    buildAdoptDropScript,
    buildCleanupUnstartedUpgradeScript,
    buildLocalUpgradeRunScript,
    buildRemotePreflightScript,
    parseRemotePreflight,
    remoteUpgradePreflight,
    startRemoteUpgrade,
} from "./local-upgrade-transfer";
import { githubCliArchiveIdentity, type LocalUpgradeFile, type PreparedLocalUpgradeBundle } from "./local-upgrade-bundle";

const paths = {
    drop: "/tmp/.supacloud-upgrade-upload-11111111-1111-4111-8111-111111111111",
    stage: "/var/lib/supacloud/upgrade-staging/11111111-1111-4111-8111-111111111111",
    status: "/var/lib/supacloud/upgrade-runs/11111111-1111-4111-8111-111111111111.status",
    log: "/var/log/supacloud/upgrade-11111111-1111-4111-8111-111111111111.log",
    unit: "supacloud-upgrade-11111111-1111-4111-8111-111111111111.service",
};

type ScriptedResult = { success: boolean; stdout: string; stderr: string; code: number };
type ScriptedResponse = Error | ScriptedResult;

class ScriptedSsh {
    readonly commands: string[] = [];

    constructor(private readonly responses: ScriptedResponse[]) {}

    async exec(command: string): Promise<ScriptedResult> {
        this.commands.push(command);
        const response = this.responses.shift();
        if (!response) throw new Error("Unexpected SSH command in lifecycle test");
        if (response instanceof Error) throw response;
        return response;
    }
}

function remoteResult(stdout = "", success = true): ScriptedResult {
    return { success, stdout, stderr: success ? "" : "remote failure", code: success ? 0 : 1 };
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

describe("local upgrade remote runner", () => {
    test("preflights strict verifier capability without requiring the old jq parser", () => {
        const script = buildRemotePreflightScript();

        expect(Bun.spawnSync(["bash", "-n", "-c", script]).exitCode).toBe(0);
        expect(script).toContain("--deny-self-hosted-runners");
        expect(script).toContain("timeout 15s \"$GH\" attestation verify --help");
        expect(script).toContain("mode=$(stat -c '%a' \"$verifier\")");
        expect(script).toContain("trusted_installed_gh \"$GH\"");
        expect(script).not.toContain("Required local-upgrade tool is missing: jq");
        expect(parseRemotePreflight("ARCH=arm64\nVERIFIER=installed\n")).toEqual({
            architecture: "arm64",
            verifierProvisioning: "installed",
        });
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
        expect(script).not.toContain("verify_manifest()");
        expect(script).not.toContain("MANAGEMENT_COMMIT");
        expect(script).not.toContain("jq ");
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
                `chown() { kill -${signal} \"$$\"; }`,
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

    test("disables adoption rollback after publishing PREPARED", () => {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-adopt-success-")));
        const fixturePaths = {
            drop: join(fixtureRoot, "drop"), stage: join(fixtureRoot, "stage"),
            status: join(fixtureRoot, "run.status"), log: join(fixtureRoot, "run.log"),
            unit: "supacloud-upgrade-test.service",
        };
        mkdirSync(fixturePaths.drop, { mode: 0o700 });
        const execution = Bun.spawnSync(["bash", "-c", [
            "install() { return 0; }", "systemctl() { return 1; }", "chown() { return 0; }",
            buildAdoptDropScript(fixturePaths),
        ].join("\n")]);
        try {
            expect(execution.exitCode).toBe(0);
            expect(existsSync(fixturePaths.drop)).toBe(false);
            expect(existsSync(fixturePaths.stage)).toBe(true);
            expect(readFileSync(fixturePaths.status, "utf8").trim()).toBe("PREPARED");
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("cleans a prepared inactive adoption after its SSH response is lost", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH response lost after remote adoption"),
            remoteResult("STAGE=present\nSTATUS=PREPARED\nUNIT=inactive\nUNIT_LOAD=not-found\n"),
            remoteResult(),
        ]);

        await expect(adoptRemoteDrop(ssh as never, paths)).rejects.toThrow("SSH response lost after remote adoption");
        expect(ssh.commands).toHaveLength(3);
        expect(ssh.commands[2]).toContain(paths.stage);
        expect(ssh.commands[2]).toContain(paths.status);
        expect(ssh.commands[2]).toContain(paths.log);
    });

    test("cleans the upload drop when failed adoption state proves the move did not persist", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH response lost before remote adoption"),
            remoteResult("STAGE=absent\nSTATUS=\nUNIT=inactive\nUNIT_LOAD=not-found\n"),
            remoteResult(),
        ]);

        await expect(adoptRemoteDrop(ssh as never, paths)).rejects.toThrow("SSH response lost before remote adoption");
        expect(ssh.commands).toHaveLength(3);
        expect(ssh.commands[2]).toContain(`rm -rf -- '${paths.drop}'`);
        expect(ssh.commands[2]).not.toContain(paths.stage);
    });

    test("preserves adoption and upload-drop cleanup failures", async () => {
        const ssh = new ScriptedSsh([
            remoteResult("", false),
            remoteResult("STAGE=absent\nSTATUS=\nUNIT=inactive\nUNIT_LOAD=not-found\n"),
            remoteResult("", false),
        ]);

        const failure = await adoptRemoteDrop(ssh as never, paths).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        const diagnostics = (failure as AggregateError).errors.map(String).join("\n");
        expect(diagnostics).toContain("Unable to adopt the verified upgrade bundle");
        expect(diagnostics).toContain("Unable to remove remote upload drop");
        expect((failure as Error).message).toContain(`retained drop=${paths.drop}`);
    });

    test("continues observing when failed adoption reporting finds a running upgrade", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH response lost after remote adoption"),
            remoteResult("STAGE=present\nSTATUS=RUNNING\nUNIT=active\nUNIT_LOAD=loaded\n"),
        ]);

        await expect(adoptRemoteDrop(ssh as never, paths)).resolves.toBe("already-started");
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.slice(1).some((command) => command.includes("rm -rf --"))).toBe(false);
    });

    test("retains all evidence when failed adoption state cannot be read", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH response lost after remote adoption"),
            new Error("SSH reconnect failed"),
        ]);

        const failure = await adoptRemoteDrop(ssh as never, paths).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors.map(String).join("\n")).toContain("SSH response lost after remote adoption");
        expect((failure as AggregateError).errors.map(String).join("\n")).toContain("SSH reconnect failed");
        expect((failure as Error).message).toContain("do not retry blindly");
        for (const retainedPath of [paths.drop, paths.stage, paths.status, paths.log, paths.unit]) {
            expect((failure as Error).message).toContain(retainedPath);
        }
        expect(ssh.commands).toHaveLength(2);
    });

    test("retains all evidence when failed adoption state is ambiguous", async () => {
        const ssh = new ScriptedSsh([
            new Error("SSH response lost after remote adoption"),
            remoteResult("STAGE=unsafe\nSTATUS=\nUNIT=unknown\nUNIT_LOAD=unknown\n"),
        ]);

        const failure = await adoptRemoteDrop(ssh as never, paths).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as Error).message).toContain("observed stage=unsafe status=empty unit=unknown load=unknown");
        expect((failure as Error).message).toContain("do not retry blindly");
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.slice(1).some((command) => command.includes("rm -rf --"))).toBe(false);
    });

    test("pins the temporary Linux GitHub verifier by architecture", () => {
        const arm64 = runScript(preparedBundle("arm64", "bundled"), "arm64");

        expect(arm64).toContain("gh_2.96.0_linux_arm64.tar.gz");
        expect(arm64).toContain("06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909");
    });

    test("does not delete an adopted stage while systemd is still activating", async () => {
        const ssh = new ScriptedSsh([
            remoteResult("", false),
            remoteResult("STATUS=PREPARED\nUNIT=activating\n"),
        ]);

        await expect(startRemoteUpgrade(ssh as never, paths)).resolves.toBeUndefined();
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.some((command) => command.includes("rm -rf --") && command.includes(paths.stage))).toBe(false);
    });

    test("bounds the transient upgrade unit with the established maximum upgrade budget", async () => {
        const ssh = new ScriptedSsh([remoteResult()]);

        await expect(startRemoteUpgrade(ssh as never, paths)).resolves.toBeUndefined();
        expect(ssh.commands[0]).toContain("--property=RuntimeMaxSec=1320s");
        expect(ssh.commands[0]).toContain("--property=TimeoutStopSec=30s");
    });

    test("preserves start and cleanup failures when an unstarted unit cannot be removed", async () => {
        const ssh = new ScriptedSsh([
            remoteResult("", false),
            remoteResult("STATUS=PREPARED\nUNIT=inactive\n"),
            remoteResult("", false),
        ]);

        const failure = await startRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        const diagnostics = (failure as AggregateError).errors.map(String).join("\n");
        expect(diagnostics).toContain("Unable to start the transient upgrade unit");
        expect(diagnostics).toContain("Unable to clean an unstarted local upgrade");
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

    test("retains status and logs when a successful transaction cannot clean its stage", async () => {
        const ssh = new ScriptedSsh([
            remoteResult("STATUS=FAILED:1:CLEANUP_AFTER_TRANSACTION\nUNIT=failed\n"),
            remoteResult("transaction completed; stage cleanup failed\n"),
        ]);

        await expect(awaitRemoteUpgrade(ssh as never, paths)).rejects.toThrow(`retained status=${paths.status}`);
        expect(ssh.commands).toHaveLength(2);
        expect(ssh.commands.some((command) => command.includes(`rm -f -- '${paths.status}'`))).toBe(false);
    });

    test("removes terminal records only after a completed unit publishes success", async () => {
        const ssh = new ScriptedSsh([
            remoteResult("STATUS=SUCCEEDED\nUNIT=inactive\nUNIT_LOAD=loaded\n"),
            remoteResult("upgrade committed\n"),
            remoteResult(),
        ]);

        await expect(awaitRemoteUpgrade(ssh as never, paths)).resolves.toContain("Upgrade done");
        expect(ssh.commands).toHaveLength(3);
        expect(ssh.commands[2]).toContain(paths.status);
        expect(ssh.commands[2]).toContain(paths.log);
    });

    test("accepts success after a transient unit has been collected", async () => {
        const ssh = new ScriptedSsh([
            remoteResult("STATUS=SUCCEEDED\nUNIT=unknown\nUNIT_LOAD=not-found\n"),
            remoteResult("upgrade committed\n"),
            remoteResult(),
        ]);

        await expect(awaitRemoteUpgrade(ssh as never, paths)).resolves.toContain("Upgrade done");
        expect(ssh.commands).toHaveLength(3);
    });

    test("rejects SUCCEEDED when systemd reports an abnormal or ambiguous stop", async () => {
        for (const [serviceState, loadState] of [
            ["failed", "loaded"],
            ["maintenance", "loaded"],
            ["unknown", "loaded"],
            ["inactive", "unknown"],
        ] as const) {
            const ssh = new ScriptedSsh([
                remoteResult(`STATUS=SUCCEEDED\nUNIT=${serviceState}\nUNIT_LOAD=${loadState}\n`),
            ]);

            const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toContain(`state=${serviceState} load=${loadState}`);
            for (const retainedPath of [paths.stage, paths.status, paths.log, paths.unit]) {
                expect((failure as Error).message).toContain(retainedPath);
            }
            expect(ssh.commands).toHaveLength(1);
        }
    });

    test("stops waiting at the total deadline without stopping or cleaning the remote unit", async () => {
        const ssh = new ScriptedSsh([
            remoteResult("STAGE=present\nSTATUS=RUNNING\nUNIT=active\nUNIT_LOAD=loaded\n"),
        ]);
        const originalNow = Date.now;
        const timestamps = [0, 0, 1_365_000];
        Date.now = () => timestamps.shift() ?? 1_365_000;
        try {
            const failure = await awaitRemoteUpgrade(ssh as never, paths).catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toContain("1320-second runtime limit");
            expect((failure as Error).message).toContain("45-second observation grace");
            for (const retainedPath of [paths.stage, paths.status, paths.log, paths.unit]) {
                expect((failure as Error).message).toContain(retainedPath);
            }
            expect(ssh.commands).toHaveLength(1);
            expect(ssh.commands[0]).not.toContain("systemctl stop");
            expect(ssh.commands[0]).not.toContain("rm -rf --");
        } finally {
            Date.now = originalNow;
        }
    });
});
