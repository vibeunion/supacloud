import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type { SshResult, SshTransport } from "../transports/ssh";
import {
    buildUpgradeLockScript,
    SUPACLOUD_UPGRADE_LOCK_PATH,
} from "../../../../management-api/src/upgrade-lock";
import {
    cleanupLocalUpgradeBundle,
    githubCliArchiveIdentity,
    prepareLocalUpgradeBundle,
    STRICT_GITHUB_CAPABILITY_FLAGS,
    type PreparedLocalUpgradeBundle,
    type UpgradeArchitecture,
} from "./local-upgrade-bundle";

export { buildUpgradeLockScript, SUPACLOUD_UPGRADE_LOCK_PATH };

export type LocalUpgradeTransferRequest = {
    managementVersion: string;
    edgeRuntimeVersion: string;
};

export type RemoteUpgradePaths = {
    drop: string;
    log: string;
    stage: string;
    status: string;
    unit: string;
};

type RemoteUpgradeState = {
    dropExists: boolean;
    logExists: boolean;
    serviceState: string;
    stageExists: boolean;
    stageIsDirectory: boolean;
    status: string;
    statusExists: boolean;
    unitExists: boolean;
    unitLoadState: string;
};

export type RemoteUpgradePreflight = {
    architecture: UpgradeArchitecture;
    verifierProvisioning: "installed" | "bundled";
};

const REMOTE_STAGE_ROOT = "/var/lib/supacloud/upgrade-staging";
const REMOTE_RUN_ROOT = "/var/lib/supacloud/upgrade-runs";
const REMOTE_LOG_ROOT = "/var/log/supacloud";
const POLL_INTERVAL_MS = 2_000;
const STATE_READ_ATTEMPTS = 3;
const REMOTE_STATE_READ_TIMEOUT_MS = 15_000;
const UPGRADE_OBSERVATION_TIMEOUT_MS = 30 * 60_000;

class RemoteUpgradeReconciliationError extends AggregateError {}

function quoteShell(shellText: string): string {
    return `'${shellText.split("'").join("'\\''")}'`;
}

function rootCommand(script: string): string {
    return [
        "if [ \"$(id -u)\" -eq 0 ]; then",
        `  /bin/bash -c ${quoteShell(script)}`,
        "else",
        "  sudo -n true",
        `  sudo -n /bin/bash -c ${quoteShell(script)}`,
        "fi",
    ].join("\n");
}

function trustedInstalledGithubFunction(): string {
    return [
        "trusted_installed_gh() {",
        "  local verifier=$1 mode",
        "  test -f \"$verifier\" && test ! -L \"$verifier\" && test -x \"$verifier\" || { echo 'Installed GitHub verifier is not a regular executable file' >&2; return 1; }",
        "  test \"$(stat -c '%u:%g' \"$verifier\")\" = '0:0' || { echo 'Installed GitHub verifier is not owned by root:root' >&2; return 1; }",
        "  mode=$(stat -c '%a' \"$verifier\")",
        "  case \"$mode\" in [0-7]|[0-7][0-7]|[0-7][0-7][0-7]) ;; *) echo 'Installed GitHub verifier has special permission bits' >&2; return 1 ;; esac",
        "  (( (8#$mode & 0022) == 0 )) || { echo 'Installed GitHub verifier is group/other writable' >&2; return 1; }",
        "}",
    ].join("\n");
}

function remotePaths(runId: string): RemoteUpgradePaths {
    return {
        drop: `/tmp/.supacloud-upgrade-upload-${runId}`,
        stage: `${REMOTE_STAGE_ROOT}/${runId}`,
        status: `${REMOTE_RUN_ROOT}/${runId}.status`,
        log: `${REMOTE_LOG_ROOT}/upgrade-${runId}.log`,
        unit: `supacloud-upgrade-${runId}.service`,
    };
}

export function parseRemotePreflight(output: string): RemoteUpgradePreflight {
    const architecture = output.match(/^ARCH=(amd64|arm64)$/m)?.[1];
    const verifierProvisioning = output.match(/^VERIFIER=(installed|bundled)$/m)?.[1];
    if (!architecture || !verifierProvisioning) {
        throw new Error("Remote upgrade preflight did not return its architecture and verifier capability");
    }
    return {
        architecture: architecture as UpgradeArchitecture,
        verifierProvisioning: verifierProvisioning as RemoteUpgradePreflight["verifierProvisioning"],
    };
}

export function buildRemotePreflightScript(): string {
    const capabilityFlags = STRICT_GITHUB_CAPABILITY_FLAGS.join(" ");
    return [
        "set -euo pipefail",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "export PATH",
        trustedInstalledGithubFunction(),
        "test -d /run/systemd/system || { echo 'systemd is not the active init system' >&2; exit 1; }",
        "for tool in systemctl systemd-run sha256sum stat realpath tar file find sort awk grep timeout flock; do command -v \"$tool\" >/dev/null 2>&1 || { echo \"Required local-upgrade tool is missing: $tool\" >&2; exit 127; }; done",
        "systemd-run --help | grep -Eq -- '(^|[[:space:]])--collect([=[:space:]]|$)' || { echo 'systemd-run --collect is required' >&2; exit 1; }",
        "test -d /run/lock || { echo '/run/lock is unavailable' >&2; exit 1; }",
        "test -d /var/lib/supacloud || { echo '/var/lib/supacloud is unavailable' >&2; exit 1; }",
        "test -f /etc/supabase/management-api.env || { echo 'EDGE_RUNTIME_MODE is unavailable' >&2; exit 1; }",
        "EDGE_MODE=$(awk -F= '$1 == \"EDGE_RUNTIME_MODE\" { value=$2 } END { gsub(/^[[:space:]\\\"'\"']+|[[:space:]\\\"'\"']+$/, \"\", value); print value }' /etc/supabase/management-api.env)",
        "test \"$EDGE_MODE\" = external || { echo 'Local component upgrade requires persisted external Edge Runtime mode' >&2; exit 1; }",
        "case \"$(uname -m)\" in x86_64|amd64) echo ARCH=amd64 ;; aarch64|arm64) echo ARCH=arm64 ;; *) echo 'Unsupported remote architecture' >&2; exit 1 ;; esac",
        "VERIFIER=bundled",
        "GH=$(type -P gh || true)",
        "if [ -n \"$GH\" ] && trusted_installed_gh \"$GH\"; then",
        "  if GH_HELP=$(timeout 15s \"$GH\" attestation verify --help 2>&1); then",
        "    GH_CAPABLE=true",
        `    for flag in ${capabilityFlags}; do printf '%s\\n' \"$GH_HELP\" | grep -Eq -- \"(^|[[:space:]])${"$"}{flag}([=[:space:]]|$)\" || GH_CAPABLE=false; done`,
        "    if [ \"$GH_CAPABLE\" = true ]; then VERIFIER=installed; fi",
        "  fi",
        "fi",
        "echo VERIFIER=$VERIFIER",
    ].join("\n");
}

export async function remoteUpgradePreflight(ssh: SshTransport): Promise<RemoteUpgradePreflight> {
    const preflight = await ssh.exec(rootCommand(buildRemotePreflightScript()), 30_000);
    if (!preflight.success) throw remoteFailure("Remote local-upgrade preflight failed", preflight);
    return parseRemotePreflight(preflight.stdout);
}

function requiredRemoteBytes(bundle: PreparedLocalUpgradeBundle): number {
    const transferBytes = [...bundle.files, ...(bundle.verifierArchive ? [bundle.verifierArchive] : [])]
        .reduce((total, upload) => total + upload.size, 0);
    return transferBytes * 3 + 512 * 1024 * 1024;
}

export function buildPrepareDropCommand(paths: RemoteUpgradePaths, bundle: PreparedLocalUpgradeBundle): string {
    const directories = [
        paths.drop,
        `${paths.drop}/bundle`,
        `${paths.drop}/bundle/management-api`,
        `${paths.drop}/bundle/edge-runtime`,
    ];
    if (bundle.verifierArchive) directories.push(`${paths.drop}/verifier`);
    const requiredBytes = requiredRemoteBytes(bundle);
    return [
        "set -euo pipefail",
        "umask 077",
        `test ! -e ${quoteShell(paths.drop)} && test ! -L ${quoteShell(paths.drop)} || { echo 'Remote upload drop already exists' >&2; exit 1; }`,
        "TMP_AVAILABLE_KB=$(df -Pk /tmp | awk 'NR == 2 { print $4 }')",
        "VAR_AVAILABLE_KB=$(df -Pk /var/lib/supacloud | awk 'NR == 2 { print $4 }')",
        `test \"${"$"}TMP_AVAILABLE_KB\" -ge ${Math.ceil(requiredBytes / 1024)} && test \"${"$"}VAR_AVAILABLE_KB\" -ge ${Math.ceil(requiredBytes / 1024)} || { echo 'Insufficient remote disk space for verified upgrade staging' >&2; exit 1; }`,
        `install -d -m 700 ${directories.map(quoteShell).join(" ")}`,
    ].join("\n");
}

async function prepareRemoteDrop(ssh: SshTransport, paths: RemoteUpgradePaths, bundle: PreparedLocalUpgradeBundle): Promise<void> {
    const prepared = await ssh.exec(buildPrepareDropCommand(paths, bundle), 30_000);
    if (!prepared.success) throw remoteFailure("Unable to prepare remote upload drop", prepared);
}

async function uploadBundleFiles(ssh: SshTransport, paths: RemoteUpgradePaths, bundle: PreparedLocalUpgradeBundle): Promise<void> {
    const uploads = [...bundle.files, ...(bundle.verifierArchive ? [bundle.verifierArchive] : [])];
    for (const upload of uploads) {
        await ssh.upload(upload.localPath, `${paths.drop}/${upload.relativePath}`, { mode: 0o600, timeoutMs: 10 * 60_000 });
    }
}

function expectedComponentFiles(bundle: PreparedLocalUpgradeBundle): { management: string[]; edge: string[] } {
    return {
        management: [
            "SHA256SUMS",
            "SUPACLOUD-RELEASE.attestation.jsonl",
            "SUPACLOUD-RELEASE.json",
            bundle.managementBinaryName,
            "web-console-build.tar.gz",
        ],
        edge: [
            "SHA256SUMS",
            "SUPACLOUD-RELEASE.attestation.jsonl",
            "SUPACLOUD-RELEASE.json",
            bundle.edgeRuntimeBinaryName,
        ],
    };
}

function shellArray(name: string, entries: string[]): string {
    return `${name}=(${entries.map(quoteShell).join(" ")})`;
}

function finishUpgradeFunction(): string {
    return [
        "finish_upgrade() {",
        "  local code=$?",
        "  trap '' HUP INT TERM",
        "  trap - EXIT",
        "  set +e",
        "  if [ \"$code\" -ne 0 ]; then",
        "    write_status \"FAILED:${code}:TRANSACTION\" || true",
        "    if ! rm -rf -- \"$STAGE\"; then write_status \"FAILED:${code}:TRANSACTION_AND_CLEANUP\" || true; fi",
        "    exit \"$code\"",
        "  fi",
        "  write_status CLEANING || { echo 'Unable to publish cleanup state' >&2; exit 1; }",
        "  if ! rm -rf -- \"$STAGE\"; then",
        "    write_status 'FAILED:1:CLEANUP_AFTER_TRANSACTION' || true",
        "    exit 1",
        "  fi",
        "  write_status SUCCEEDED || exit 1",
        "  exit 0",
        "}",
    ].join("\n");
}

function upgradeScriptSetup(paths: RemoteUpgradePaths): string[] {
    const bundleDirectory = `${paths.stage}/bundle`;
    return [
        "#!/usr/bin/env bash", "set -euo pipefail", "umask 077",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "export PATH",
        `STAGE=${quoteShell(paths.stage)}`, `STATUS=${quoteShell(paths.status)}`, `LOG=${quoteShell(paths.log)}`,
        `BUNDLE=${quoteShell(bundleDirectory)}`,
        `MANAGEMENT_DIR=${quoteShell(`${bundleDirectory}/management-api`)}`,
        `EDGE_DIR=${quoteShell(`${bundleDirectory}/edge-runtime`)}`,
        "write_status() { local next=\"${STATUS}.next\"; printf '%s\\n' \"$1\" > \"$next\"; chmod 600 \"$next\"; mv -f \"$next\" \"$STATUS\"; }",
        finishUpgradeFunction(),
        "trap finish_upgrade EXIT", "trap 'exit 129' HUP", "trap 'exit 130' INT", "trap 'exit 143' TERM",
        "exec >>\"$LOG\" 2>&1", "write_status RUNNING",
        buildUpgradeLockScript(SUPACLOUD_UPGRADE_LOCK_PATH),
        "while IFS='=' read -r variable _; do case \"$variable\" in *PROXY*|*Proxy*|*proxy*) unset \"$variable\" ;; esac; done < <(env)",
        "unset SUPACLOUD_ALLOW_UNVERIFIED_RELEASE SUPACLOUD_GITHUB_REPOSITORY SUPACLOUD_RELEASES_API SUPACLOUD_ATTESTATION_SIGNER_WORKFLOW NODE_USE_ENV_PROXY",
    ];
}

function upgradeScriptFilesystemChecks(bundle: PreparedLocalUpgradeBundle): string[] {
    const componentFiles = expectedComponentFiles(bundle);
    const stageEntries = ["bundle", "run.sh", ...(bundle.verifierArchive ? ["verifier"] : [])];
    const checks = [
        shellArray("MANAGEMENT_FILES", componentFiles.management), shellArray("EDGE_FILES", componentFiles.edge),
        "assert_directory() { local path=$1; test -d \"$path\" && test ! -L \"$path\"; test \"$(stat -c '%u:%g' \"$path\")\" = '0:0'; test \"$(stat -c '%a' \"$path\")\" = '700'; }",
        "assert_file() { local path=$1 parent=$2; test -f \"$path\" && test ! -L \"$path\"; test \"$(stat -c '%u:%g:%h' \"$path\")\" = '0:0:1'; test \"$(stat -c '%a' \"$path\")\" = '600'; test \"$(dirname \"$(realpath \"$path\")\")\" = \"$parent\"; }",
        "assert_entries() { local directory=$1; shift; local actual expected; actual=$(find \"$directory\" -mindepth 1 -maxdepth 1 -printf '%f\\n' | LC_ALL=C sort); expected=$(printf '%s\\n' \"$@\" | LC_ALL=C sort); test \"$actual\" = \"$expected\"; }",
        "assert_directory \"$STAGE\"", shellArray("STAGE_FILES", stageEntries),
        "assert_entries \"$STAGE\" \"${STAGE_FILES[@]}\"", "assert_file \"$STAGE/run.sh\" \"$STAGE\"",
        "assert_directory \"$BUNDLE\"",
        "assert_entries \"$BUNDLE\" edge-runtime management-api",
        "assert_directory \"$MANAGEMENT_DIR\"", "assert_directory \"$EDGE_DIR\"",
        "assert_entries \"$MANAGEMENT_DIR\" \"${MANAGEMENT_FILES[@]}\"",
        "assert_entries \"$EDGE_DIR\" \"${EDGE_FILES[@]}\"",
        "for name in \"${MANAGEMENT_FILES[@]}\"; do assert_file \"$MANAGEMENT_DIR/$name\" \"$MANAGEMENT_DIR\"; done",
        "for name in \"${EDGE_FILES[@]}\"; do assert_file \"$EDGE_DIR/$name\" \"$EDGE_DIR\"; done",
    ];
    if (bundle.verifierArchive) {
        const archiveName = basename(bundle.verifierArchive.relativePath);
        checks.push(
            "assert_directory \"$STAGE/verifier\"",
            `assert_entries \"$STAGE/verifier\" ${quoteShell(archiveName)}`,
            `assert_file \"$STAGE/verifier/${archiveName}\" \"$STAGE/verifier\"`,
        );
    }
    return checks;
}

function upgradeScriptTransferVerification(bundle: PreparedLocalUpgradeBundle): string[] {
    const files = [...bundle.files, ...(bundle.verifierArchive ? [bundle.verifierArchive] : [])];
    return [
        "verify_transfer() { local relative=$1 expected_size=$2 expected_sha=$3; local path=$STAGE/$relative; test \"$(stat -c '%s' \"$path\")\" = \"$expected_size\"; test \"$(sha256sum \"$path\" | awk '{print $1}')\" = \"$expected_sha\"; }",
        ...files.map((file) => (
            `verify_transfer ${quoteShell(file.relativePath)} ${file.size} ${quoteShell(file.sha256)}`
        )),
    ];
}

function upgradeScriptVerifier(
    paths: RemoteUpgradePaths,
    bundle: PreparedLocalUpgradeBundle,
    architecture: UpgradeArchitecture,
): string[] {
    const setup = bundle.verifierArchive
        ? bundledVerifierSetup(paths, architecture)
        : [
            trustedInstalledGithubFunction(),
            "GH=$(type -P gh)",
            "trusted_installed_gh \"$GH\" || { echo 'Installed GitHub verifier trust check failed' >&2; exit 1; }",
        ];
    const capabilityFlags = STRICT_GITHUB_CAPABILITY_FLAGS.join(" ");
    return [
        ...setup,
        "GH_HELP=$(timeout 15s \"$GH\" attestation verify --help 2>&1) || { echo 'GitHub verifier capability check failed' >&2; exit 1; }",
        `for flag in ${capabilityFlags}; do printf '%s\\n' \"$GH_HELP\" | grep -Eq -- \"(^|[[:space:]])${"$"}{flag}([=[:space:]]|$)\" || { echo \"GitHub verifier lacks $flag\" >&2; exit 1; }; done`,
        "VERIFIER_PATH=$(dirname \"$GH\")",
    ];
}

function bundledVerifierSetup(paths: RemoteUpgradePaths, architecture: UpgradeArchitecture): string[] {
    const verifier = githubCliArchiveIdentity(architecture);
    return [
        `GH_ARCHIVE=${quoteShell(`${paths.stage}/verifier/${verifier.archiveName}`)}`,
        `GH_MEMBER=${quoteShell(verifier.member)}`,
        "test \"$(tar -tzf \"$GH_ARCHIVE\" | grep -Fxc \"$GH_MEMBER\")\" = 1",
        "test \"$(tar -tvzf \"$GH_ARCHIVE\" \"$GH_MEMBER\" | cut -c1)\" = '-'",
        "VERIFIER_ROOT=$(mktemp -d \"${STAGE}/verifier/gh.XXXXXX\")",
        "tar --no-same-owner --same-permissions -xzf \"$GH_ARCHIVE\" -C \"$VERIFIER_ROOT\" \"$GH_MEMBER\"",
        "test \"$(stat -c '%a' \"$VERIFIER_ROOT/$GH_MEMBER\")\" = '755'",
        "install -m 0755 \"$VERIFIER_ROOT/$GH_MEMBER\" \"${STAGE}/verifier/gh\"",
        "rm -rf -- \"$VERIFIER_ROOT\"",
        "GH=${STAGE}/verifier/gh",
        `case \"$(\"$GH\" --version | head -1)\" in 'gh version ${verifier.version}'*) ;; *) echo 'Pinned GitHub verifier version mismatch' >&2; exit 1 ;; esac`,
    ];
}

function upgradeScriptExecution(
    paths: RemoteUpgradePaths,
    bundle: PreparedLocalUpgradeBundle,
    request: LocalUpgradeTransferRequest,
): string[] {
    const runnerAsset = `${paths.stage}/bundle/management-api/${bundle.managementBinaryName}`;
    const runner = `${paths.stage}/runner`;
    return [
        `MANAGEMENT_VERSION=${quoteShell(request.managementVersion)}`,
        `RUNNER_ASSET=${quoteShell(runnerAsset)}`,
        `RUNNER=${quoteShell(runner)}`,
        "file -b \"$RUNNER_ASSET\" | grep -q ELF",
        "install -m 0755 \"$RUNNER_ASSET\" \"$RUNNER\"",
        "test \"$(sha256sum \"$RUNNER\"|awk '{print $1}')\" = \"$(sha256sum \"$RUNNER_ASSET\"|awk '{print $1}')\"",
        "\"$RUNNER\" --version | grep -Eq \"(^|[^0-9])${MANAGEMENT_VERSION//./\\.}([^0-9]|$)\"",
        `env PATH=\"$VERIFIER_PATH:$PATH\" \"$RUNNER\" upgrade --yes --target-version ${quoteShell(request.managementVersion)} --edge-runtime-version ${quoteShell(request.edgeRuntimeVersion)} --asset-bundle-dir \"$BUNDLE\"`,
    ];
}

export function buildLocalUpgradeRunScript(
    paths: RemoteUpgradePaths,
    bundle: PreparedLocalUpgradeBundle,
    request: LocalUpgradeTransferRequest,
    architecture: UpgradeArchitecture,
): string {
    return [
        ...upgradeScriptSetup(paths),
        ...upgradeScriptFilesystemChecks(bundle),
        ...upgradeScriptTransferVerification(bundle),
        ...upgradeScriptVerifier(paths, bundle, architecture),
        ...upgradeScriptExecution(paths, bundle, request),
    ].join("\n");
}

async function uploadRunScript(
    ssh: SshTransport,
    paths: RemoteUpgradePaths,
    bundle: PreparedLocalUpgradeBundle,
    request: LocalUpgradeTransferRequest,
    architecture: UpgradeArchitecture,
): Promise<void> {
    await ssh.uploadText(`${paths.drop}/run.sh`, buildLocalUpgradeRunScript(paths, bundle, request, architecture), 0o600);
}

function failedAdoptionRollbackFunction(): string {
    return [
        "rollback_failed_adoption() {",
        "  local code=$? cleanup_failed=false",
        "  trap '' HUP INT TERM",
        "  trap - EXIT",
        "  if [ \"$ADOPTION_ACTIVE\" != true ]; then exit \"$code\"; fi",
        "  set +e",
        "  rm -rf -- \"$STAGE\" || cleanup_failed=true",
        "  rm -f -- \"$STATUS\" \"${STATUS}.next\" \"$LOG\" || cleanup_failed=true",
        "  if [ \"$cleanup_failed\" = true ]; then echo \"Upgrade adoption failed (exit $code) and rollback did not complete\" >&2; exit 1; fi",
        "  echo \"Upgrade adoption failed (exit $code); transferred state was rolled back\" >&2",
        "  exit \"$code\"",
        "}",
    ].join("\n");
}

export function buildAdoptDropScript(paths: RemoteUpgradePaths): string {
    return [
        "set -euo pipefail",
        "umask 077",
        `DROP=${quoteShell(paths.drop)}`,
        `STAGE=${quoteShell(paths.stage)}`,
        `STATUS=${quoteShell(paths.status)}`,
        `LOG=${quoteShell(paths.log)}`,
        `UNIT=${quoteShell(paths.unit)}`,
        "ADOPTION_ACTIVE=false",
        failedAdoptionRollbackFunction(),
        "trap rollback_failed_adoption EXIT",
        "trap 'exit 129' HUP",
        "trap 'exit 130' INT",
        "trap 'exit 143' TERM",
        `install -d -o root -g root -m 700 ${quoteShell(REMOTE_STAGE_ROOT)} ${quoteShell(REMOTE_RUN_ROOT)} ${quoteShell(REMOTE_LOG_ROOT)}`,
        "if [ -e \"$STAGE\" ] || [ -L \"$STAGE\" ] || [ -e \"$STATUS\" ] || [ -L \"$STATUS\" ] || [ -e \"$LOG\" ] || [ -L \"$LOG\" ]; then",
        "  echo 'Upgrade adoption target already exists' >&2",
        "  exit 1",
        "fi",
        "systemctl status \"$UNIT\" >/dev/null 2>&1 && { echo 'Upgrade unit already exists' >&2; exit 1; } || true",
        "ADOPTION_ACTIVE=true",
        "mv \"$DROP\" \"$STAGE\"",
        "chown -hR root:root \"$STAGE\"",
        ": > \"$STATUS\"; : > \"$LOG\"; chmod 600 \"$STATUS\" \"$LOG\"",
        "printf 'PREPARED\\n' > \"${STATUS}.next\"; chmod 600 \"${STATUS}.next\"; mv -f \"${STATUS}.next\" \"$STATUS\"",
        "ADOPTION_ACTIVE=false",
        "trap - EXIT HUP INT TERM",
    ].join("\n");
}

export async function adoptRemoteDrop(ssh: SshTransport, paths: RemoteUpgradePaths): Promise<void> {
    let adoptionFailure: Error;
    let adoptionOutcomeUncertain = false;
    try {
        const adopted = await ssh.exec(rootCommand(buildAdoptDropScript(paths)), 60_000);
        if (adopted.success) return;
        adoptionFailure = remoteFailure("Unable to adopt the verified upgrade bundle", adopted);
    } catch (error: unknown) {
        adoptionOutcomeUncertain = true;
        adoptionFailure = operationError(error, "Unable to adopt the verified upgrade bundle");
    }
    const state = await observeRemoteState(ssh, paths, {
        failureMessage: "Unable to reconcile the interrupted upgrade adoption",
        precedingFailures: [adoptionFailure],
    });
    if (isFullyPreparedUnstartedState(state)) return;
    if (adoptionOutcomeUncertain) {
        throw remoteReconciliationFailure(
            "Upgrade adoption outcome is still uncertain after SSH interruption", [adoptionFailure], paths,
        );
    }
    const noAdoptedStateRemains = !state.stageExists && !state.statusExists
        && !state.logExists && !state.unitExists;
    if (noAdoptedStateRemains) throw adoptionFailure;
    throw remoteReconciliationFailure(
        "Upgrade adoption stopped in an ambiguous state", [adoptionFailure], paths,
    );
}

function startUnitScript(paths: RemoteUpgradePaths): string {
    return [
        "set -euo pipefail",
        `systemd-run --quiet --collect --unit=${quoteShell(paths.unit)} --property=Type=exec --property=KillMode=control-group --property=TimeoutStopSec=30s /bin/bash ${quoteShell(`${paths.stage}/run.sh`)}`,
        `systemctl is-active --quiet ${quoteShell(paths.unit)}`,
    ].join("\n");
}

export async function startRemoteUpgrade(ssh: SshTransport, paths: RemoteUpgradePaths): Promise<void> {
    let startFailure: Error;
    let startOutcomeUncertain = false;
    try {
        const started = await ssh.exec(rootCommand(startUnitScript(paths)), 30_000);
        if (started.success) return;
        startFailure = remoteFailure("Unable to start the transient upgrade unit", started);
    } catch (error: unknown) {
        startOutcomeUncertain = true;
        startFailure = operationError(error, "Unable to start the transient upgrade unit");
    }
    const state = await observeRemoteState(ssh, paths, {
        failureMessage: "Unable to reconcile the interrupted upgrade start",
        precedingFailures: [startFailure],
    });
    if (unitIsRunning(state.serviceState) || /^(?:RUNNING|CLEANING|SUCCEEDED|FAILED:)/.test(state.status)) return;
    if (startOutcomeUncertain) {
        throw remoteReconciliationFailure(
            "Upgrade start outcome is still uncertain after SSH interruption", [startFailure], paths,
        );
    }
    if (!isFullyPreparedUnstartedState(state)) {
        throw remoteReconciliationFailure("Upgrade start stopped in an ambiguous state", [startFailure], paths);
    }
    try {
        await cleanupUnstartedUpgrade(ssh, paths);
    } catch (cleanupError: unknown) {
        throw remoteReconciliationFailure(
            "Remote upgrade start and cleanup both failed", [startFailure, cleanupError], paths,
        );
    }
    throw startFailure;
}

export function buildRemoteStateScript(paths: RemoteUpgradePaths): string {
    return [
        "set -euo pipefail",
        `DROP=${quoteShell(paths.drop)}`,
        `LOG=${quoteShell(paths.log)}`,
        `STAGE=${quoteShell(paths.stage)}`,
        `STATUS=${quoteShell(paths.status)}`,
        `UNIT=${quoteShell(paths.unit)}`,
        "printf 'STATUS=%s\\n' \"$(sed -n '1p' \"$STATUS\" 2>/dev/null || true)\"",
        "printf 'UNIT=%s\\n' \"$(systemctl is-active \"$UNIT\" 2>/dev/null || true)\"",
        "if [ -e \"$STAGE\" ] || [ -L \"$STAGE\" ]; then echo STAGE_EXISTS=yes; else echo STAGE_EXISTS=no; fi",
        "if [ -d \"$STAGE\" ] && [ ! -L \"$STAGE\" ]; then echo STAGE_DIRECTORY=yes; else echo STAGE_DIRECTORY=no; fi",
        "if [ -e \"$DROP\" ] || [ -L \"$DROP\" ]; then echo DROP_EXISTS=yes; else echo DROP_EXISTS=no; fi",
        "if [ -e \"$STATUS\" ] || [ -L \"$STATUS\" ]; then echo STATUS_EXISTS=yes; else echo STATUS_EXISTS=no; fi",
        "if [ -e \"$LOG\" ] || [ -L \"$LOG\" ]; then echo LOG_EXISTS=yes; else echo LOG_EXISTS=no; fi",
        "UNIT_LOAD_STATE=$(systemctl show --property=LoadState --value \"$UNIT\" 2>/dev/null || true)",
        "test -n \"$UNIT_LOAD_STATE\" || { echo 'Unable to read remote upgrade unit load state' >&2; exit 1; }",
        "printf 'UNIT_LOAD=%s\\n' \"$UNIT_LOAD_STATE\"",
        "if [ -n \"$UNIT_LOAD_STATE\" ] && [ \"$UNIT_LOAD_STATE\" != not-found ]; then echo UNIT_EXISTS=yes; else echo UNIT_EXISTS=no; fi",
    ].join("\n");
}

function remoteStateValue(output: string, field: string): string {
    const match = output.match(new RegExp(`^${field}=(.*)$`, "m"));
    if (!match) throw new Error(`Remote upgrade state is missing ${field}`);
    return match[1]?.trim() || "";
}

function remoteStatePresence(output: string, field: string): boolean {
    const presence = remoteStateValue(output, field);
    if (presence !== "yes" && presence !== "no") {
        throw new Error(`Remote upgrade state has invalid ${field}`);
    }
    return presence === "yes";
}

async function readRemoteState(
    ssh: SshTransport,
    paths: RemoteUpgradePaths,
    timeoutMs = REMOTE_STATE_READ_TIMEOUT_MS,
): Promise<RemoteUpgradeState> {
    const state = await ssh.exec(rootCommand(buildRemoteStateScript(paths)), timeoutMs);
    if (!state.success) throw remoteFailure("Unable to read remote upgrade state", state);
    return {
        dropExists: remoteStatePresence(state.stdout, "DROP_EXISTS"),
        logExists: remoteStatePresence(state.stdout, "LOG_EXISTS"),
        serviceState: remoteStateValue(state.stdout, "UNIT") || "unknown",
        stageExists: remoteStatePresence(state.stdout, "STAGE_EXISTS"),
        stageIsDirectory: remoteStatePresence(state.stdout, "STAGE_DIRECTORY"),
        status: remoteStateValue(state.stdout, "STATUS"),
        statusExists: remoteStatePresence(state.stdout, "STATUS_EXISTS"),
        unitExists: remoteStatePresence(state.stdout, "UNIT_EXISTS"),
        unitLoadState: remoteStateValue(state.stdout, "UNIT_LOAD"),
    };
}

type RemoteStateObservation = {
    deadline?: number;
    failureMessage: string;
    precedingFailures?: readonly unknown[];
};

function observationDeadlineFailure(paths: RemoteUpgradePaths, failures: readonly unknown[]): Error {
    return remoteReconciliationFailure(
        "Remote upgrade is still nonterminal after the observation deadline",
        failures,
        paths,
    );
}

async function observeRemoteState(
    ssh: SshTransport,
    paths: RemoteUpgradePaths,
    observation: RemoteStateObservation,
): Promise<RemoteUpgradeState> {
    const readFailures: unknown[] = [];
    for (let attempt = 1; attempt <= STATE_READ_ATTEMPTS; attempt += 1) {
        const remainingMs = observation.deadline === undefined
            ? REMOTE_STATE_READ_TIMEOUT_MS
            : observation.deadline - Date.now();
        if (remainingMs <= 0) {
            throw observationDeadlineFailure(paths, readFailures);
        }
        try {
            return await readRemoteState(ssh, paths, Math.min(REMOTE_STATE_READ_TIMEOUT_MS, remainingMs));
        } catch (error: unknown) {
            readFailures.push(error);
            if (attempt < STATE_READ_ATTEMPTS) {
                const retryDelay = observation.deadline === undefined
                    ? POLL_INTERVAL_MS
                    : Math.min(POLL_INTERVAL_MS, observation.deadline - Date.now());
                if (retryDelay <= 0) throw observationDeadlineFailure(paths, readFailures);
                await delay(retryDelay);
            }
        }
    }
    throw remoteReconciliationFailure(
        observation.failureMessage,
        [...(observation.precedingFailures ?? []), ...readFailures],
        paths,
    );
}

async function remoteLogTail(ssh: SshTransport, paths: RemoteUpgradePaths): Promise<string> {
    const script = [
        `LOG=${quoteShell(paths.log)}`,
        "test -f \"$LOG\" && test ! -L \"$LOG\" || { echo 'Remote upgrade log is not a regular file' >&2; exit 1; }",
        "tail -80 -- \"$LOG\"",
    ].join("\n");
    const output = await ssh.exec(rootCommand(script), 15_000);
    if (!output.success) throw remoteFailure("Unable to read the remote upgrade log", output);
    return output.stdout.slice(-4_000);
}

async function cleanupRemoteRecords(ssh: SshTransport, paths: RemoteUpgradePaths): Promise<void> {
    const cleanup = await ssh.exec(rootCommand(`rm -f -- ${quoteShell(paths.status)} ${quoteShell(paths.log)}`), 15_000);
    if (!cleanup.success) throw remoteFailure("Unable to remove remote upgrade status records", cleanup);
}

export function buildCleanupUnstartedUpgradeScript(paths: RemoteUpgradePaths): string {
    return [
        "set -euo pipefail",
        "cleanup_failed=false",
        `rm -rf -- ${quoteShell(paths.stage)} || cleanup_failed=true`,
        `rm -f -- ${quoteShell(paths.status)} ${quoteShell(paths.log)} || cleanup_failed=true`,
        "test \"$cleanup_failed\" = false",
    ].join("\n");
}

async function cleanupUnstartedUpgrade(ssh: SshTransport, paths: RemoteUpgradePaths): Promise<void> {
    const cleanup = await ssh.exec(rootCommand(buildCleanupUnstartedUpgradeScript(paths)), 15_000);
    if (!cleanup.success) throw remoteFailure("Unable to clean an unstarted local upgrade", cleanup);
}

async function cleanupRemoteDrop(ssh: SshTransport, paths: RemoteUpgradePaths): Promise<void> {
    const cleanup = await ssh.exec(`rm -rf -- ${quoteShell(paths.drop)}`, 15_000);
    if (!cleanup.success) throw remoteFailure("Unable to remove remote upload drop", cleanup);
}

function remoteFailure(message: string, execution: SshResult): Error {
    const diagnostic = execution.stderr.trim() || execution.stdout.trim() || `exit ${execution.code}`;
    return new Error(`${message}: ${diagnostic.slice(-500)}`);
}

function operationError(error: unknown, message: string): Error {
    return error instanceof Error ? error : new Error(`${message}: ${String(error)}`);
}

function remoteEvidence(paths: RemoteUpgradePaths): string {
    return `unit=${paths.unit} stage=${paths.stage} status=${paths.status} log=${paths.log} drop=${paths.drop}`;
}

function remoteReconciliationFailure(
    message: string,
    failures: readonly unknown[],
    paths: RemoteUpgradePaths,
): RemoteUpgradeReconciliationError {
    return new RemoteUpgradeReconciliationError(
        failures.map((failure) => operationError(failure, message)),
        `${message}; reconcile remote evidence at ${remoteEvidence(paths)}; do not retry blindly`,
    );
}

export function failureRequiresRemoteReconciliation(error: unknown): boolean {
    return error instanceof RemoteUpgradeReconciliationError;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unitIsRunning(serviceState: string): boolean {
    return ["active", "activating", "deactivating", "reloading"].includes(serviceState);
}

function isFullyPreparedUnstartedState(state: RemoteUpgradeState): boolean {
    return state.stageExists && state.stageIsDirectory && state.statusExists && state.logExists
        && !state.dropExists && !state.unitExists && state.unitLoadState === "not-found"
        && state.status === "PREPARED";
}

function unitStoppedNormally(state: RemoteUpgradeState): boolean {
    return (state.serviceState === "inactive" && ["loaded", "not-found"].includes(state.unitLoadState))
        || (state.serviceState === "unknown" && state.unitLoadState === "not-found");
}

function assertSuccessfulUnitStoppedNormally(state: RemoteUpgradeState, paths: RemoteUpgradePaths): void {
    if (unitStoppedNormally(state)) return;
    throw remoteReconciliationFailure(
        `Remote upgrade published SUCCEEDED but the unit stopped abnormally or ambiguously `
        + `(state=${state.serviceState} load=${state.unitLoadState})`,
        [],
        paths,
    );
}

function failedUnitReachedTerminalState(state: RemoteUpgradeState): boolean {
    return unitStoppedNormally(state)
        || (state.serviceState === "failed" && state.unitLoadState === "loaded");
}

function assertFailedUnitReachedTerminalState(state: RemoteUpgradeState, paths: RemoteUpgradePaths): void {
    if (failedUnitReachedTerminalState(state)) return;
    throw remoteReconciliationFailure(
        `Remote upgrade published FAILED but the unit state is ambiguous `
        + `(state=${state.serviceState} load=${state.unitLoadState})`,
        [],
        paths,
    );
}

function assertTerminalEvidence(state: RemoteUpgradeState, paths: RemoteUpgradePaths): void {
    if (state.status !== "SUCCEEDED" && !state.status.startsWith("FAILED:")) return;
    const evidenceIssues: string[] = [];
    if (!state.statusExists) evidenceIssues.push("status record is missing");
    if (!state.logExists) evidenceIssues.push("log is missing");
    if (state.dropExists) evidenceIssues.push("upload drop still exists");
    if (state.status === "SUCCEEDED" && state.stageExists) evidenceIssues.push("successful stage still exists");
    if (state.status.startsWith("FAILED:") && !state.status.includes("CLEANUP") && state.stageExists) {
        evidenceIssues.push("failed stage still exists without a cleanup failure status");
    }
    if (evidenceIssues.length === 0) return;
    throw remoteReconciliationFailure(
        `Remote upgrade terminal evidence is incomplete or inconsistent (${evidenceIssues.join(", ")})`,
        [],
        paths,
    );
}

async function completedUpgradeOutput(ssh: SshTransport, paths: RemoteUpgradePaths): Promise<string> {
    let log: string;
    try {
        log = await remoteLogTail(ssh, paths);
    } catch (error: unknown) {
        throw remoteReconciliationFailure(
            "Upgrade succeeded but its retained log could not be read", [error], paths,
        );
    }
    try {
        await cleanupRemoteRecords(ssh, paths);
    } catch (error: unknown) {
        throw remoteReconciliationFailure(
            "Upgrade succeeded but remote evidence cleanup could not be confirmed", [error], paths,
        );
    }
    return `✅ Upgrade done\n${log.slice(-1_500)}`;
}

async function throwRemoteUpgradeFailure(ssh: SshTransport, paths: RemoteUpgradePaths, status: string): Promise<never> {
    let log: string;
    try {
        log = await remoteLogTail(ssh, paths);
    } catch (error: unknown) {
        throw remoteReconciliationFailure(
            "Remote upgrade failed but its retained log could not be read", [error], paths,
        );
    }
    const failure = new Error(`Remote local upgrade failed (${status}): ${log.slice(-1_500)}`);
    if (status.endsWith(":CLEANUP_AFTER_TRANSACTION")) {
        throw remoteReconciliationFailure(
            "Upgrade transaction completed but staging cleanup is incomplete", [failure], paths,
        );
    }
    if (status.includes("CLEANUP")) {
        throw remoteReconciliationFailure(
            "Upgrade transaction and staging cleanup both failed", [failure], paths,
        );
    }
    try {
        await cleanupRemoteRecords(ssh, paths);
    } catch (cleanupError: unknown) {
        throw remoteReconciliationFailure(
            "Remote local upgrade failed and status cleanup did not complete", [failure, cleanupError], paths,
        );
    }
    throw failure;
}

function assertObservableUpgradeState(state: RemoteUpgradeState, unitRunning: boolean, paths: RemoteUpgradePaths): void {
    const knownStatus = ["PREPARED", "RUNNING", "CLEANING", "SUCCEEDED"].includes(state.status)
        || state.status.startsWith("FAILED:");
    if (!unitRunning && !knownStatus) {
        throw remoteReconciliationFailure("Remote upgrade stopped without a terminal status", [], paths);
    }
}

export async function awaitRemoteUpgrade(ssh: SshTransport, paths: RemoteUpgradePaths): Promise<string> {
    const observationDeadline = Date.now() + UPGRADE_OBSERVATION_TIMEOUT_MS;
    let stoppedObservations = 0;
    while (true) {
        const state = await observeRemoteState(ssh, paths, {
            deadline: observationDeadline,
            failureMessage: "Unable to observe the remote upgrade lifecycle",
        });
        const unitRunning = unitIsRunning(state.serviceState);
        if (!unitRunning) assertTerminalEvidence(state, paths);
        if (state.status === "SUCCEEDED" && !unitRunning) {
            assertSuccessfulUnitStoppedNormally(state, paths);
            return await completedUpgradeOutput(ssh, paths);
        }
        if (state.status.startsWith("FAILED:") && !unitRunning) {
            assertFailedUnitReachedTerminalState(state, paths);
            await throwRemoteUpgradeFailure(ssh, paths, state.status);
        }
        if (Date.now() >= observationDeadline) {
            throw observationDeadlineFailure(paths, []);
        }
        assertObservableUpgradeState(state, unitRunning, paths);
        stoppedObservations = unitRunning ? 0 : stoppedObservations + 1;
        if (stoppedObservations >= 3 && ["PREPARED", "RUNNING", "CLEANING"].includes(state.status)) {
            throw remoteReconciliationFailure(
                "Remote upgrade unit stopped before publishing a terminal status", [], paths,
            );
        }
        const remainingObservationMs = observationDeadline - Date.now();
        if (remainingObservationMs <= 0) throw observationDeadlineFailure(paths, []);
        await delay(Math.min(POLL_INTERVAL_MS, remainingObservationMs));
    }
}

export async function executeLocalUpgradeTransfer(ssh: SshTransport, request: LocalUpgradeTransferRequest): Promise<string> {
    const runId = randomUUID();
    const paths = remotePaths(runId);
    const preflight = await remoteUpgradePreflight(ssh);
    const bundle = await prepareLocalUpgradeBundle({ ...preflight, ...request });
    let adopted = false;
    let transferError: unknown;
    try {
        try {
            await prepareRemoteDrop(ssh, paths, bundle);
            await uploadBundleFiles(ssh, paths, bundle);
            await uploadRunScript(ssh, paths, bundle, request, preflight.architecture);
            await adoptRemoteDrop(ssh, paths);
            adopted = true;
            await startRemoteUpgrade(ssh, paths);
            return await awaitRemoteUpgrade(ssh, paths);
        } catch (error: unknown) {
            transferError = error;
            if (!adopted && !failureRequiresRemoteReconciliation(error)) {
                try {
                    await cleanupRemoteDrop(ssh, paths);
                } catch (cleanupError: unknown) {
                    transferError = new AggregateError(
                        [transferError, cleanupError],
                        "Local upgrade failed and upload-drop cleanup did not complete",
                    );
                }
            }
            throw transferError;
        }
    } finally {
        try {
            cleanupLocalUpgradeBundle(bundle);
        } catch (cleanupError: unknown) {
            if (transferError) {
                throw new AggregateError([transferError, cleanupError], "Local upgrade and local bundle cleanup both failed");
            }
            throw new AggregateError([cleanupError], "Remote local upgrade completed but local bundle cleanup did not complete");
        }
    }
}
