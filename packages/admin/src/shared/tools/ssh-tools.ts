/**
 * SSH — Compound tool (13→1)
 * Install, upgrade, diagnose, exec, tenant mgmt — all via SSH
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { Type } from "@sinclair/typebox";
import { decodedSchema, optional, stringEnum, withDescription } from "../schema";
import { redactSshOutput, SshCommandOutcomeUnknownError, type SshTransport } from "../transports/ssh";
import {
    buildUpgradeLockScript,
    executeLocalUpgradeTransfer,
    SUPACLOUD_UPGRADE_LOCK_PATH,
    UPGRADE_OBSERVATION_TIMEOUT_MS,
} from "../releases/local-upgrade-transfer";
import {
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME,
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL,
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256,
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SIZE,
} from "../../../../management-api/src/sigstore-trusted-root";
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
const DIRECT_BOOTSTRAP_TRANSFER_BUDGET_MS = 12 * 60_000;
const PROXIED_BOOTSTRAP_TRANSFER_BUDGET_MS = 22 * 60_000;
const DIRECT_UPGRADE_SSH_TIMEOUT_MS = UPGRADE_OBSERVATION_TIMEOUT_MS
    + DIRECT_BOOTSTRAP_TRANSFER_BUDGET_MS;
const PROXIED_UPGRADE_SSH_TIMEOUT_MS = UPGRADE_OBSERVATION_TIMEOUT_MS
    + PROXIED_BOOTSTRAP_TRANSFER_BUDGET_MS;
const PLATFORM_PROBE_TIMEOUT_MS = 10_000;
const PLATFORM_HASH_TIMEOUT_MS = 30_000;
const WEB_CONSOLE_PROBE_TIMEOUT_MS = 60_000;
const BINARY_VERSION_MAX_BYTES = 2048;
const WEB_CONSOLE_MARKER_MAX_BYTES = 4096;
const WEB_CONSOLE_CURRENT_DIR = "/opt/supacloud/web-console/current";
const STABLE_SEMVER_CORE = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const EXACT_STABLE_SEMVER = new RegExp(`^(?:${STABLE_SEMVER_CORE})(?![\\s\\S])`);
const SEMVER_CORE_TOKEN = /\d+\.\d+\.\d+/;
const VERSION_TOKEN_SEPARATOR = /[\s"'()\[\]{}:,;=]+/;
const BINARY_HASH_BEFORE_FAILED = 70;
const BINARY_VERSION_FAILED = 71;
const BINARY_HASH_AFTER_FAILED = 72;
const PROBE_CHANGED_DURING_READ = 75;
const WEB_CONSOLE_ROOT_MISSING = 43;
const WEB_CONSOLE_MARKER_MISSING = 44;
const WEB_CONSOLE_ROOT_INVALID = 64;
const WEB_CONSOLE_MARKER_INVALID = 65;
const WEB_CONSOLE_TREE_INVALID = 66;
const WEB_CONSOLE_TREE_FAILED = 67;
const BINARY_HASH_BEFORE_LABEL = "SUPACLOUD_BINARY_HASH_BEFORE=";
const BINARY_VERSION_LABEL = "SUPACLOUD_BINARY_VERSION_BASE64=";
const BINARY_HASH_AFTER_LABEL = "SUPACLOUD_BINARY_HASH_AFTER=";
const WEB_ROOT_REAL_BEFORE_LABEL = "SUPACLOUD_WEB_ROOT_REAL_BEFORE=";
const WEB_ROOT_ID_BEFORE_LABEL = "SUPACLOUD_WEB_ROOT_ID_BEFORE=";
const WEB_MARKER_BEFORE_LABEL = "SUPACLOUD_WEB_MARKER_BASE64_BEFORE=";
const WEB_TREE_BEFORE_LABEL = "SUPACLOUD_WEB_TREE_SHA256_BEFORE=";
const WEB_TREE_AFTER_LABEL = "SUPACLOUD_WEB_TREE_SHA256_AFTER=";
const WEB_MARKER_AFTER_LABEL = "SUPACLOUD_WEB_MARKER_BASE64_AFTER=";
const WEB_ROOT_REAL_AFTER_LABEL = "SUPACLOUD_WEB_ROOT_REAL_AFTER=";
const WEB_ROOT_ID_AFTER_LABEL = "SUPACLOUD_WEB_ROOT_ID_AFTER=";

type ComponentProbeStatus = "ok" | "unknown" | "error";

type BinaryComponentEvidence = {
    status: ComponentProbeStatus;
    version: string | null;
    sha256: string | null;
    path: string | null;
    source: string;
    error: string | null;
};

type WebConsoleEvidence = {
    status: ComponentProbeStatus;
    version: string | null;
    tree_sha256: string | null;
    path: string;
    source: "component_marker_and_tree_sha256";
    error: string | null;
};

type FixedBinaryProbe = {
    command: string;
};

type BinaryProbeDefinition = {
    unit: string;
    source: string;
    commands: Readonly<Record<string, FixedBinaryProbe>>;
};

function fixedBinaryProbeCommand(executablePath: string, versionArgument: string): string {
    const executable = quoteEnvValue(executablePath);
    return [
        "set -o pipefail",
        `if exec {BINARY_FD}<${executable}; then :; else exit ${BINARY_HASH_BEFORE_FAILED}; fi`,
        "PINNED_EXECUTABLE=/proc/$$/fd/$BINARY_FD",
        `if PINNED_ID=$(stat -Lc '%d:%i' -- "$PINNED_EXECUTABLE"); then :; else exit ${BINARY_HASH_BEFORE_FAILED}; fi`,
        `if HASH_BEFORE=$(sha256sum -- "$PINNED_EXECUTABLE" | awk '{print $1}'); then :; else exit ${BINARY_HASH_BEFORE_FAILED}; fi`,
        `printf '${BINARY_HASH_BEFORE_LABEL}%s\\n' "$HASH_BEFORE"`,
        `if VERSION_BASE64=$( (exec -a ${executable} "$PINNED_EXECUTABLE" ${versionArgument} {BINARY_FD}<&-) 2>&1 | head -c ${BINARY_VERSION_MAX_BYTES + 1} | base64 | tr -d '\\n'); then :; else exit ${BINARY_VERSION_FAILED}; fi`,
        `printf '${BINARY_VERSION_LABEL}%s\\n' "$VERSION_BASE64"`,
        `if HASH_AFTER=$(sha256sum -- "$PINNED_EXECUTABLE" | awk '{print $1}'); then :; else exit ${BINARY_HASH_AFTER_FAILED}; fi`,
        `printf '${BINARY_HASH_AFTER_LABEL}%s\\n' "$HASH_AFTER"`,
        `[ "$HASH_BEFORE" = "$HASH_AFTER" ] || exit ${PROBE_CHANGED_DURING_READ}`,
        `if CURRENT_ID=$(stat -Lc '%d:%i' -- ${executable}); then :; else exit ${PROBE_CHANGED_DURING_READ}; fi`,
        `[ "$PINNED_ID" = "$CURRENT_ID" ] || exit ${PROBE_CHANGED_DURING_READ}`,
        "exec {BINARY_FD}<&-",
    ].join("\n");
}

const BINARY_PROBES = {
    management_api: {
        unit: "supacloud.service",
        source: "systemd:supacloud.service:ExecStart",
        commands: {
            "/usr/local/bin/supacloud": {
                command: fixedBinaryProbeCommand("/usr/local/bin/supacloud", "--version"),
            },
            "/opt/supacloud/bin/supacloud": {
                command: fixedBinaryProbeCommand("/opt/supacloud/bin/supacloud", "--version"),
            },
        },
    },
    edge_runtime: {
        unit: "supacloud-edge-runtime.service",
        source: "systemd:supacloud-edge-runtime.service:ExecStart",
        commands: {
            "/usr/local/bin/supacloud-edge-runtime": {
                command: fixedBinaryProbeCommand("/usr/local/bin/supacloud-edge-runtime", "--version"),
            },
            "/opt/supacloud/bin/supacloud-edge-runtime": {
                command: fixedBinaryProbeCommand("/opt/supacloud/bin/supacloud-edge-runtime", "--version"),
            },
        },
    },
    caddy: {
        unit: "supacloud-caddy.service",
        source: "systemd:supacloud-caddy.service:ExecStart",
        commands: {
            "/usr/local/bin/supacloud-caddy": {
                command: fixedBinaryProbeCommand("/usr/local/bin/supacloud-caddy", "version"),
            },
        },
    },
} as const satisfies Record<string, BinaryProbeDefinition>;

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
    const normalized = value.startsWith("v") ? value.slice(1) : value;
    if (!EXACT_STABLE_SEMVER.test(normalized)) {
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

function upgradeTransactionEnvAssignments(request: UpgradeRequest): string {
    return [
        'SUPACLOUD_UPGRADE_TAG="$TARGET_MANAGEMENT_VERSION"',
        request.edgeRuntimeVersion ? `SUPACLOUD_EDGE_RUNTIME_UPGRADE_TAG=${quoteEnvValue(request.edgeRuntimeVersion)}` : "",
        request.githubProxy ? `SUPACLOUD_GITHUB_PROXY=${quoteEnvValue(request.githubProxy)}` : "",
    ].filter(Boolean).join(" ");
}

function componentBootstrapCommands(request: UpgradeRequest): string[] {
    const managementVersion = request.version || "latest";
    return [
        `case "$(uname -m)" in x86_64|amd64) MANAGEMENT_ASSET=supacloud-linux-amd64 ;; aarch64|arm64) MANAGEMENT_ASSET=supacloud-linux-arm64 ;; *) echo 'Unsupported Management architecture' >&2; exit 1 ;; esac`,
        `STAGED_MANAGEMENT=$(mktemp /tmp/supacloud-management-upgrade.XXXXXX)`,
        `MANAGEMENT_RELEASE=$(supacloud_fetch_component_release management-api ${quoteEnvValue(managementVersion)} "$MANAGEMENT_ASSET" web-console-build.tar.gz)`,
        `supacloud_download_release_asset "$MANAGEMENT_RELEASE" "$MANAGEMENT_ASSET" "$STAGED_MANAGEMENT" binary`,
        `chmod 0755 "$STAGED_MANAGEMENT"`,
        `TARGET_MANAGEMENT_VERSION=$(jq -er '.tag_name | capture("^management-api-v(?<version>(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*))$").version' <<< "$MANAGEMENT_RELEASE")`,
        `STAGED_VERSION=$(timeout 5s "$STAGED_MANAGEMENT" --version 2>&1 | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)`,
        `test "$STAGED_VERSION" = "$TARGET_MANAGEMENT_VERSION" || { echo 'Target Management binary version does not match its verified release' >&2; exit 1; }`,
        `supacloud_version_at_least "$STAGED_VERSION" ${quoteEnvValue(MINIMUM_COMPONENT_UPGRADE_VERSION)} || { echo 'Target Management release lacks component transaction capability' >&2; exit 1; }`,
        `SYSTEMD_HELPER_OUTPUT=$(timeout 5s "$STAGED_MANAGEMENT" --systemd-unit-helper-sha256 2>&1)`,
        `[[ "$SYSTEMD_HELPER_OUTPUT" =~ ^SupaCloud[[:space:]]systemd-unit[[:space:]]helper[[:space:]]SHA-256:[[:space:]][0-9a-f]{64}$ ]] || { echo 'Target Management release lacks target-bound systemd-unit helper delivery' >&2; exit 1; }`,
        `POSTGREST_LAUNCHER_OUTPUT=$(timeout 5s "$STAGED_MANAGEMENT" --postgrest-launcher-sha256 2>&1)`,
        `[[ "$POSTGREST_LAUNCHER_OUTPUT" =~ ^SupaCloud[[:space:]]PostgREST[[:space:]]launcher[[:space:]]SHA-256:[[:space:]][0-9a-f]{64}$ ]] || { echo 'Target Management release lacks target-bound PostgREST launcher delivery' >&2; exit 1; }`,
        `UPGRADE_RUNNER="$STAGED_MANAGEMENT"`,
    ];
}

function componentPreflightCommands(request: UpgradeRequest): string[] {
    return request.edgeRuntimeVersion ? [
        "test -f /etc/supabase/management-api.env || { echo 'EDGE_RUNTIME_MODE is unavailable; component upgrade requires external mode' >&2; exit 1; }",
        "EDGE_RUNTIME_MODE_VALUE=$(awk -F= '$1 == \"EDGE_RUNTIME_MODE\" { value=substr($0, index($0, \"=\") + 1) } END { gsub(/^[[:space:]\\042\\047]+|[[:space:]\\042\\047]+$/, \"\", value); print value }' /etc/supabase/management-api.env)",
        "test \"$EDGE_RUNTIME_MODE_VALUE\" = external || { echo 'Edge Runtime component upgrade supports persisted external mode only' >&2; exit 1; }",
    ] : [];
}

function signalSafeCleanupTraps(cleanupCommand: string): string[] {
    return [
        `trap ${quoteEnvValue(cleanupCommand)} EXIT`,
        `trap ${quoteEnvValue(`trap - EXIT HUP INT TERM; ${cleanupCommand}; exit 1`)} HUP INT TERM`,
    ];
}

function trustedRootPreflightCommands(helperPath: string): string[] {
    const helperDirectory = dirname(helperPath);
    const trustedRootPath = join(helperDirectory, SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME);
    return [
        `HELPER_DIRECTORY=${quoteEnvValue(helperDirectory)}`,
        `TRUSTED_ROOT=${quoteEnvValue(trustedRootPath)}`,
        "test -d \"$HELPER_DIRECTORY\" && test ! -L \"$HELPER_DIRECTORY\" || { echo 'Upgrade helper directory is not secure' >&2; exit 1; }",
        "test \"$(stat -c '%a' \"$HELPER_DIRECTORY\")\" = 700 || { echo 'Upgrade helper directory must use mode 0700' >&2; exit 1; }",
        `EXPECTED_HELPER_ENTRIES=$(printf '%s\\n' ${quoteEnvValue(basename(helperPath))} ${quoteEnvValue(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME)} | LC_ALL=C sort)`,
        "ACTUAL_HELPER_ENTRIES=$(find \"$HELPER_DIRECTORY\" -mindepth 1 -maxdepth 1 -printf '%f\\n' | LC_ALL=C sort)",
        "test \"$ACTUAL_HELPER_ENTRIES\" = \"$EXPECTED_HELPER_ENTRIES\" || { echo 'Upgrade helper directory does not match its strict file allowlist' >&2; exit 1; }",
        "test -f \"$TRUSTED_ROOT\" && test ! -L \"$TRUSTED_ROOT\" && test \"$(stat -c '%h' \"$TRUSTED_ROOT\")\" = 1 || { echo 'Pinned trusted root must be a direct regular file without links' >&2; exit 1; }",
        "test \"$(stat -c '%a' \"$TRUSTED_ROOT\")\" = 600 || { echo 'Pinned trusted root must use mode 0600' >&2; exit 1; }",
        `test "$(stat -c '%s' "$TRUSTED_ROOT")" = ${SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SIZE} || { echo 'Pinned trusted root size mismatch' >&2; exit 1; }`,
        `test "$(sha256sum "$TRUSTED_ROOT" | awk '{print $1}')" = ${quoteEnvValue(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256)} || { echo 'Pinned trusted root digest mismatch' >&2; exit 1; }`,
        "chown -h root:root \"$TRUSTED_ROOT\"",
        "test \"$(stat -c '%u:%g:%a:%h' \"$TRUSTED_ROOT\")\" = 0:0:600:1 || { echo 'Pinned trusted root ownership or mode changed during adoption' >&2; exit 1; }",
        `test "$(stat -c '%s' "$TRUSTED_ROOT")" = ${SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SIZE} && test "$(sha256sum "$TRUSTED_ROOT" | awk '{print $1}')" = ${quoteEnvValue(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256)} || { echo 'Pinned trusted root changed during adoption' >&2; exit 1; }`,
        "export SUPACLOUD_ATTESTATION_TRUSTED_ROOT=\"$TRUSTED_ROOT\"",
    ];
}

export function buildRootUpgradeScript(request: UpgradeRequest): string {
    const envAssignments = upgradeTransactionEnvAssignments(request);
    return [
        "set -euo pipefail",
        "umask 077",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "export PATH",
        "unset SUPACLOUD_ALLOW_UNVERIFIED_RELEASE SUPACLOUD_GITHUB_REPOSITORY SUPACLOUD_RELEASES_API SUPACLOUD_ATTESTATION_SIGNER_WORKFLOW SUPACLOUD_ATTESTATION_TRUSTED_ROOT SUPACLOUD_GH_VERSION SUPACLOUD_GH_MIN_VERSION SUPACLOUD_GH_AMD64_SHA256 SUPACLOUD_GH_ARM64_SHA256 GH_PROXY",
        request.githubProxy
            ? `export SUPACLOUD_GITHUB_PROXY=${quoteEnvValue(request.githubProxy)}`
            : "unset SUPACLOUD_GITHUB_PROXY SUPACLOUD_GITHUB_PROXIES",
        "for tool in curl jq file sha256sum stat tar flock find sort chown timeout; do command -v \"$tool\" >/dev/null 2>&1 || { echo \"Required upgrade tool is missing: $tool\" >&2; exit 127; }; done",
        "test -d /run/lock || { echo '/run/lock is unavailable' >&2; exit 1; }",
        "test -x /usr/local/bin/supacloud || { echo 'SupaCloud binary not found at /usr/local/bin/supacloud; run ssh install first.' >&2; exit 127; }",
        ...trustedRootPreflightCommands(request.helperPath),
        buildUpgradeLockScript(SUPACLOUD_UPGRADE_LOCK_PATH),
        ...componentPreflightCommands(request),
        "STAGED_MANAGEMENT=''",
        ...signalSafeCleanupTraps('test -z "$STAGED_MANAGEMENT" || rm -f "$STAGED_MANAGEMENT"'),
        `source ${quoteEnvValue(request.helperPath)}`,
        "supacloud_attestation_trusted_root_available || { echo 'Pinned Sigstore trusted root failed helper validation' >&2; exit 1; }",
        "if ! supacloud_attestation_verifier_available; then supacloud_install_pinned_gh /usr/local/bin/gh; fi",
        "supacloud_attestation_verifier_available || { echo 'Pinned GitHub attestation verifier is unavailable' >&2; exit 1; }",
        ...componentBootstrapCommands(request),
        `env ${envAssignments} "$UPGRADE_RUNNER" upgrade --yes`,
    ].join("\n");
}

export function buildOfficialUpgradeCommand(request: UpgradeRequest): string {
    const rootScript = buildRootUpgradeScript(request);
    const cleanupCommand = `rm -rf -- ${quoteEnvValue(dirname(request.helperPath))}`;
    return [
        "set -e",
        ...signalSafeCleanupTraps(cleanupCommand),
        "if [ \"$(id -u)\" -eq 0 ]; then " +
            `bash -c ${quoteEnvValue(rootScript)}; ` +
            "else sudo -n true; " +
            `sudo -n bash -c ${quoteEnvValue(rootScript)}; fi`,
    ].join("; ");
}

async function prepareRemoteUpgradeHelperDirectory(ssh: SshTransport, helperPath: string): Promise<void> {
    const helperDirectory = dirname(helperPath);
    const command = [
        "set -e",
        "umask 077",
        `mkdir -m 700 -- ${quoteEnvValue(helperDirectory)}`,
    ].join("; ");
    const preparation = await ssh.exec(command, 30_000);
    if (!preparation.success) {
        throw new Error(`Failed to prepare remote upgrade helper directory (exit ${preparation.code}): ${preparation.stderr.slice(-300)}`);
    }
}

async function removeRemoteUpgradeHelper(ssh: SshTransport, helperPath: string): Promise<void> {
    const helperDirectory = dirname(helperPath);
    const removeCommand = `rm -rf -- ${quoteEnvValue(helperDirectory)}`;
    const command = [
        "if [ \"$(id -u)\" -eq 0 ]; then",
        `  ${removeCommand}`,
        "else",
        `  ${removeCommand} || sudo -n ${removeCommand}`,
        "fi",
    ].join("\n");
    const cleanup = await ssh.exec(command, 30_000);
    if (!cleanup.success) {
        throw new Error(`Failed to remove remote upgrade helper (exit ${cleanup.code}): ${cleanup.stderr.slice(-300)}`);
    }
}

type OfficialUpgradeExecution = Awaited<ReturnType<SshTransport["exec"]>>;

type OfficialUpgradeOutcomeState = {
    execution: OfficialUpgradeExecution | undefined;
    executionFailed: boolean;
    executionError: unknown;
    cleanupFailed: boolean;
    cleanupError: unknown;
    helperPath: string;
    upgradeExecutionRequested: boolean;
};

class RemoteUpgradeOutcomeUnknownError extends AggregateError {
    readonly code = "OUTCOME_UNKNOWN";
}

function boundedUpgradeError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = redactSshOutput(message)
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, 500);
    return new Error(diagnostic || "Remote operation ended without a diagnostic");
}

function remoteUpgradeEvidence(helperPath: string): string {
    const trustedRootPath = join(dirname(helperPath), SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME);
    return `helper=${helperPath} trusted_root=${trustedRootPath}`;
}

function remoteUpgradeReconciliationFailure(
    message: string,
    failures: readonly unknown[],
    helperPath: string,
): RemoteUpgradeOutcomeUnknownError {
    return new RemoteUpgradeOutcomeUnknownError(
        failures.map(boundedUpgradeError),
        `${message} Reconcile ${remoteUpgradeEvidence(helperPath)}; do not retry blindly`,
    );
}

function remoteUpgradeOutcomeUnknown(
    transportError: SshCommandOutcomeUnknownError,
    helperPath: string,
): RemoteUpgradeOutcomeUnknownError {
    return remoteUpgradeReconciliationFailure(
        "OUTCOME_UNKNOWN: Remote upgrade transport ended after dispatch; client cleanup was suppressed "
            + "because the remote command may still be running. Verify deployed versions before retrying.",
        [transportError],
        helperPath,
    );
}

function remoteUpgradeFailure(execution: OfficialUpgradeExecution): Error {
    const diagnostic = execution.stderr.trim() || execution.stdout.trim() || "no remote diagnostic";
    return new Error(`Remote upgrade failed (exit ${execution.code}): ${diagnostic.slice(-500)}`);
}

function remoteHelperSetupOutcomeUnknown(
    outcome: OfficialUpgradeOutcomeState,
): RemoteUpgradeOutcomeUnknownError {
    const cleanupStatus = outcome.cleanupFailed
        ? "the helper cleanup did not complete"
        : "the cleanup command completed, but setup may finish later";
    const failures = outcome.cleanupFailed
        ? [outcome.executionError, outcome.cleanupError]
        : [outcome.executionError];
    return remoteUpgradeReconciliationFailure(
        `OUTCOME_UNKNOWN: Remote helper setup ended without terminal status; ${cleanupStatus}. `
            + "The upgrade command was not dispatched.",
        failures,
        outcome.helperPath,
    );
}

function completedUpgradeCleanupOutcomeUnknown(
    outcome: OfficialUpgradeOutcomeState,
): RemoteUpgradeOutcomeUnknownError {
    if (!outcome.execution) {
        return remoteUpgradeReconciliationFailure(
            "OUTCOME_UNKNOWN: Upgrade execution returned no result, and helper cleanup outcome is unknown.",
            [outcome.cleanupError], outcome.helperPath,
        );
    }
    const message = outcome.execution.success
        ? "OUTCOME_UNKNOWN: Remote upgrade succeeded, but helper cleanup outcome is unknown."
        : "OUTCOME_UNKNOWN: Remote upgrade failed with a terminal result, and helper cleanup outcome is unknown.";
    const failures = outcome.execution.success
        ? [outcome.cleanupError]
        : [remoteUpgradeFailure(outcome.execution), outcome.cleanupError];
    return remoteUpgradeReconciliationFailure(message, failures, outcome.helperPath);
}

function remoteHelperCleanupOutcomeUnknown(
    outcome: OfficialUpgradeOutcomeState,
): RemoteUpgradeOutcomeUnknownError {
    if (!outcome.upgradeExecutionRequested) {
        return remoteUpgradeReconciliationFailure(
            "OUTCOME_UNKNOWN: Remote helper setup failed, and helper cleanup outcome is unknown. "
                + "The upgrade command was not dispatched.",
            [outcome.executionError, outcome.cleanupError], outcome.helperPath,
        );
    }
    if (outcome.executionFailed) {
        return remoteUpgradeReconciliationFailure(
            "OUTCOME_UNKNOWN: Upgrade execution request failed, and helper cleanup outcome is unknown.",
            [outcome.executionError, outcome.cleanupError], outcome.helperPath,
        );
    }
    return completedUpgradeCleanupOutcomeUnknown(outcome);
}

function officialUpgradeOutcome(outcome: OfficialUpgradeOutcomeState): OfficialUpgradeExecution {
    if (!outcome.upgradeExecutionRequested && outcome.executionError instanceof SshCommandOutcomeUnknownError) {
        throw remoteHelperSetupOutcomeUnknown(outcome);
    }
    if (outcome.cleanupFailed && outcome.cleanupError instanceof SshCommandOutcomeUnknownError) {
        throw remoteHelperCleanupOutcomeUnknown(outcome);
    }
    if (outcome.executionFailed && outcome.cleanupFailed) {
        throw new AggregateError(
            [outcome.executionError, outcome.cleanupError],
            "Upgrade execution failed and helper cleanup did not complete",
        );
    }
    if (outcome.executionFailed) throw outcome.executionError;
    if (!outcome.execution) throw new Error("Upgrade execution did not return a result");
    if (outcome.cleanupFailed && !outcome.execution.success) {
        throw new AggregateError(
            [remoteUpgradeFailure(outcome.execution), outcome.cleanupError],
            "Remote upgrade failed and helper cleanup did not complete",
        );
    }
    if (outcome.cleanupFailed) throw outcome.cleanupError;
    if (!outcome.execution.success) throw remoteUpgradeFailure(outcome.execution);
    return outcome.execution;
}

async function executeOfficialUpgrade(
    ssh: SshTransport,
    helperPath: string,
    command: string,
    timeoutMs: number,
): Promise<Awaited<ReturnType<SshTransport["exec"]>>> {
    let execution: OfficialUpgradeExecution | undefined;
    let executionFailed = false;
    let executionError: unknown;
    let upgradeExecutionRequested = false;
    try {
        await prepareRemoteUpgradeHelperDirectory(ssh, helperPath);
        await ssh.uploadText(helperPath, releaseAssetsScript, 0o600);
        const trustedRootPath = join(dirname(helperPath), SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME);
        await ssh.uploadText(trustedRootPath, SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL, 0o600);
        upgradeExecutionRequested = true;
        execution = await ssh.exec(command, timeoutMs);
    } catch (error: unknown) {
        if (upgradeExecutionRequested && error instanceof SshCommandOutcomeUnknownError) {
            throw remoteUpgradeOutcomeUnknown(error, helperPath);
        }
        executionFailed = true;
        executionError = error;
    }

    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
        await removeRemoteUpgradeHelper(ssh, helperPath);
    } catch (error: unknown) {
        cleanupFailed = true;
        cleanupError = error;
    }
    return officialUpgradeOutcome({
        execution,
        executionFailed,
        executionError,
        cleanupFailed,
        cleanupError,
        helperPath,
        upgradeExecutionRequested,
    });
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

type RemoteExecution = Awaited<ReturnType<SshTransport["exec"]>>;

type ExecStartEvidence = {
    status: ComponentProbeStatus;
    path: string | null;
    error: string | null;
};

async function runFixedRemoteCommand(
    ssh: SshTransport,
    command: string,
    timeoutMs: number,
): Promise<RemoteExecution | null> {
    try {
        return await ssh.exec(command, timeoutMs);
    } catch {
        return null;
    }
}

function singleSystemdProperty(output: string, property: string): string | null {
    const prefix = `${property}=`;
    const matches = output.split(/\r?\n/).filter(line => line.startsWith(prefix));
    return matches.length === 1 ? matches[0]!.slice(prefix.length) : null;
}

function strictExecStartPath(execStart: string): string | null {
    if (execStart.length > 4096 || /[\r\n\0]/.test(execStart)) return null;
    const matches = Array.from(execStart.matchAll(/(?:^|[{;]\s*)path=([^;}]+?)\s*(?=;|}|$)/g));
    if (matches.length !== 1) return null;
    const executablePath = matches[0]?.[1]?.trim() || "";
    return /^\/[a-zA-Z0-9._/-]+$/.test(executablePath) ? executablePath : null;
}

function execStartEvidence(output: string): ExecStartEvidence {
    if (output.length > 8192 || /\0/.test(output)) {
        return { status: "error", path: null, error: "systemd_output_invalid" };
    }
    if (!output.trim()) return { status: "unknown", path: null, error: "unit_missing" };
    const loadState = singleSystemdProperty(output, "LoadState");
    const execStart = singleSystemdProperty(output, "ExecStart");
    if (loadState === null || execStart === null) {
        return { status: "error", path: null, error: "systemd_output_invalid" };
    }
    if (loadState !== "loaded") return { status: "unknown", path: null, error: "unit_not_loaded" };
    if (execStart === "") return { status: "unknown", path: null, error: "exec_start_missing" };
    const executablePath = strictExecStartPath(execStart);
    return executablePath
        ? { status: "ok", path: executablePath, error: null }
        : { status: "error", path: null, error: "exec_start_invalid" };
}

function stableVersion(output: string): string | null {
    if (output.length > BINARY_VERSION_MAX_BYTES || /\0/.test(output)) return null;
    const versionTokens = output.split(VERSION_TOKEN_SEPARATOR).filter(token => SEMVER_CORE_TOKEN.test(token));
    const versions = versionTokens.map(token => token.startsWith("v") ? token.slice(1) : token);
    if (versions.length === 0 || versions.some(version => !EXACT_STABLE_SEMVER.test(version))) {
        return null;
    }
    const uniqueVersions = new Set(versions);
    return uniqueVersions.size === 1 ? [...uniqueVersions][0]! : null;
}

function stableSha256(output: string): string | null {
    return /^[0-9a-f]{64}$/.test(output) ? output : null;
}

function unavailableBinaryEvidence(
    definition: BinaryProbeDefinition,
    evidence: ExecStartEvidence,
): BinaryComponentEvidence {
    return {
        status: evidence.status,
        version: null,
        sha256: null,
        path: evidence.path,
        source: definition.source,
        error: evidence.error,
    };
}

function canonicalBase64Text(encoded: string, maximumBytes: number): string | null {
    if (encoded.length > Math.ceil(maximumBytes / 3) * 4 || encoded.length % 4 !== 0) return null;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
    const decodedBytes = Buffer.from(encoded, "base64");
    if (decodedBytes.length > maximumBytes || decodedBytes.toString("base64") !== encoded) return null;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes);
    } catch {
        return null;
    }
}

function taggedProbeValue(line: string | undefined, label: string): string | null {
    return line?.startsWith(label) ? line.slice(label.length) : null;
}

type BinaryProbeFields = {
    versionOutput: string;
    hashBefore: string;
    hashAfter: string | null;
};

function binaryProbeFields(output: string): BinaryProbeFields | null {
    if (output.length > 8192 || /[\r\0]/.test(output)) return null;
    const lines = (output.endsWith("\n") ? output.slice(0, -1) : output).split("\n");
    if (lines.length < 2 || lines.length > 3) return null;
    const hashBefore = taggedProbeValue(lines[0], BINARY_HASH_BEFORE_LABEL);
    const versionBase64 = taggedProbeValue(lines[1], BINARY_VERSION_LABEL);
    const hashAfter = lines.length === 3
        ? taggedProbeValue(lines[2], BINARY_HASH_AFTER_LABEL)
        : null;
    if (hashBefore === null || versionBase64 === null || (lines.length === 3 && hashAfter === null)) return null;
    const versionOutput = canonicalBase64Text(versionBase64, BINARY_VERSION_MAX_BYTES);
    return versionOutput === null ? null : { versionOutput, hashBefore, hashAfter };
}

type BinaryProbeValues = {
    version: string | null;
    sha256: string | null;
    error: string | null;
};

function completedBinaryProbe(fields: BinaryProbeFields): BinaryProbeValues {
    const version = stableVersion(fields.versionOutput);
    const hashBefore = stableSha256(fields.hashBefore);
    const hashAfter = fields.hashAfter === null ? null : stableSha256(fields.hashAfter);
    if (hashBefore && hashAfter && hashBefore !== hashAfter) {
        return { version: null, sha256: null, error: "binary_changed_during_probe" };
    }
    const sha256 = hashBefore && hashAfter ? hashBefore : null;
    if (!version) return { version: null, sha256, error: "version_output_invalid" };
    return sha256
        ? { version, sha256, error: null }
        : { version, sha256: null, error: "sha256_output_invalid" };
}

function reservedBinaryProbeFailure(
    execution: RemoteExecution,
    fields: BinaryProbeFields | null,
): BinaryProbeValues | null {
    if (execution.code === PROBE_CHANGED_DURING_READ) {
        return { version: null, sha256: null, error: "binary_changed_during_probe" };
    }
    if (execution.code === BINARY_HASH_BEFORE_FAILED) {
        return { version: null, sha256: null, error: "sha256_probe_failed" };
    }
    if (execution.code === BINARY_VERSION_FAILED) {
        return { version: null, sha256: null, error: "version_probe_failed" };
    }
    if (execution.code === BINARY_HASH_AFTER_FAILED) {
        const version = fields ? stableVersion(fields.versionOutput) : null;
        return version
            ? { version, sha256: null, error: "sha256_probe_failed" }
            : { version: null, sha256: null, error: fields ? "version_output_invalid" : "binary_probe_output_invalid" };
    }
    return null;
}

function binaryProbeValues(execution: RemoteExecution | null): BinaryProbeValues {
    if (!execution) return { version: null, sha256: null, error: "binary_probe_transport_failed" };
    const fields = binaryProbeFields(execution.stdout);
    const reservedFailure = reservedBinaryProbeFailure(execution, fields);
    if (reservedFailure) return reservedFailure;
    if (!execution.success) return { version: null, sha256: null, error: "binary_probe_failed" };
    return fields
        ? completedBinaryProbe(fields)
        : { version: null, sha256: null, error: "binary_probe_output_invalid" };
}

async function binaryComponentEvidence(
    ssh: SshTransport,
    definition: BinaryProbeDefinition,
): Promise<BinaryComponentEvidence> {
    const execStart = await systemdBinaryEvidence(ssh, definition);
    if (execStart.status !== "ok" || !execStart.path) return unavailableBinaryEvidence(definition, execStart);
    const fixedProbe = definition.commands[execStart.path];
    if (!fixedProbe) return unavailableBinaryEvidence(definition, {
        status: "error", path: execStart.path, error: "exec_start_not_allowed",
    });
    const evidence = await fixedBinaryEvidence(ssh, definition, execStart.path, fixedProbe);
    const verifiedExecStart = await systemdBinaryEvidence(ssh, definition);
    if (verifiedExecStart.status !== "ok") {
        return unavailableBinaryEvidence(definition, {
            status: "error", path: execStart.path, error: "exec_start_recheck_failed",
        });
    }
    return verifiedExecStart.path === execStart.path
        ? evidence
        : unavailableBinaryEvidence(definition, {
            status: "error", path: execStart.path, error: "exec_start_changed_during_probe",
        });
}

async function systemdBinaryEvidence(
    ssh: SshTransport,
    definition: BinaryProbeDefinition,
): Promise<ExecStartEvidence> {
    const systemdCommand = `systemctl show --property=LoadState --property=ExecStart -- ${definition.unit}`;
    const systemdExecution = await runFixedRemoteCommand(ssh, systemdCommand, PLATFORM_PROBE_TIMEOUT_MS);
    if (!systemdExecution) return { status: "error", path: null, error: "systemd_probe_transport_failed" };
    if (!systemdExecution.success) return { status: "error", path: null, error: "systemd_probe_failed" };
    return execStartEvidence(systemdExecution.stdout);
}

async function fixedBinaryEvidence(
    ssh: SshTransport,
    definition: BinaryProbeDefinition,
    executablePath: string,
    fixedProbe: FixedBinaryProbe,
): Promise<BinaryComponentEvidence> {
    const execution = await runFixedRemoteCommand(ssh, fixedProbe.command, PLATFORM_HASH_TIMEOUT_MS);
    const probe = binaryProbeValues(execution);
    return {
        status: probe.error ? "error" : "ok",
        version: probe.version,
        sha256: probe.sha256,
        path: executablePath,
        source: definition.source,
        error: probe.error,
    };
}

function parseWebConsoleVersion(markerOutput: string): string | null {
    if (markerOutput.length > WEB_CONSOLE_MARKER_MAX_BYTES || /\0/.test(markerOutput)) return null;
    try {
        const marker = JSON.parse(markerOutput) as unknown;
        if (typeof marker !== "object" || marker === null || Array.isArray(marker)) return null;
        const fields = marker as Record<string, unknown>;
        if (fields.schema_version !== 1 || fields.component !== "web-console") return null;
        return typeof fields.version === "string" && EXACT_STABLE_SEMVER.test(fields.version)
            ? fields.version
            : null;
    } catch {
        return null;
    }
}

const WEB_CONSOLE_PROBE_COMMAND = [
    "set -o pipefail",
    `ROOT=${quoteEnvValue(WEB_CONSOLE_CURRENT_DIR)}`,
    "if [ ! -e \"$ROOT\" ] && [ ! -L \"$ROOT\" ]; then exit 43; fi",
    `test -d "$ROOT" || exit ${WEB_CONSOLE_ROOT_INVALID}`,
    `ROOT_REAL_BEFORE=$(readlink -f -- "$ROOT") || exit ${WEB_CONSOLE_ROOT_INVALID}`,
    `case "$ROOT_REAL_BEFORE" in "$ROOT"|/opt/supacloud/web-console/releases/*) ;; *) exit ${WEB_CONSOLE_ROOT_INVALID} ;; esac`,
    `ROOT_ID_BEFORE=$(stat -c '%d:%i' -- "$ROOT_REAL_BEFORE") || exit ${WEB_CONSOLE_ROOT_INVALID}`,
    "MARKER_BEFORE=$ROOT_REAL_BEFORE/.supacloud-component.json",
    `test ! -L "$MARKER_BEFORE" || exit ${WEB_CONSOLE_MARKER_INVALID}`,
    `test -e "$MARKER_BEFORE" || exit ${WEB_CONSOLE_MARKER_MISSING}`,
    `test -f "$MARKER_BEFORE" || exit ${WEB_CONSOLE_MARKER_INVALID}`,
    `test "$(stat -c '%s' -- "$MARKER_BEFORE")" -le ${WEB_CONSOLE_MARKER_MAX_BYTES} || exit ${WEB_CONSOLE_MARKER_INVALID}`,
    `MARKER_BASE64_BEFORE=$(head -c ${WEB_CONSOLE_MARKER_MAX_BYTES + 1} -- "$MARKER_BEFORE" | base64 | tr -d '\\n') || exit ${WEB_CONSOLE_MARKER_INVALID}`,
    "web_tree_sha256() {",
    "  local TREE_ROOT INVALID_ENTRY TREE_DIGEST",
    "  TREE_ROOT=$1",
    `  INVALID_ENTRY=$(cd -- "$TREE_ROOT" && find . -xdev ! -type d ! -type f -print -quit) || return ${WEB_CONSOLE_TREE_FAILED}`,
    `  test -z "$INVALID_ENTRY" || return ${WEB_CONSOLE_TREE_INVALID}`,
    `  TREE_DIGEST=$(cd -- "$TREE_ROOT" && find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum | awk '{print $1}') || return ${WEB_CONSOLE_TREE_FAILED}`,
    "  printf '%s' \"$TREE_DIGEST\"",
    "}",
    "TREE_BEFORE=$(web_tree_sha256 \"$ROOT_REAL_BEFORE\")",
    "TREE_STATUS=$?",
    "test \"$TREE_STATUS\" -eq 0 || exit \"$TREE_STATUS\"",
    "TREE_AFTER=$(web_tree_sha256 \"$ROOT_REAL_BEFORE\")",
    "TREE_STATUS=$?",
    `test "$TREE_STATUS" -eq 0 || exit ${PROBE_CHANGED_DURING_READ}`,
    "MARKER_AFTER=$ROOT_REAL_BEFORE/.supacloud-component.json",
    `test ! -L "$MARKER_AFTER" && test -f "$MARKER_AFTER" || exit ${PROBE_CHANGED_DURING_READ}`,
    `test "$(stat -c '%s' -- "$MARKER_AFTER")" -le ${WEB_CONSOLE_MARKER_MAX_BYTES} || exit ${PROBE_CHANGED_DURING_READ}`,
    `MARKER_BASE64_AFTER=$(head -c ${WEB_CONSOLE_MARKER_MAX_BYTES + 1} -- "$MARKER_AFTER" | base64 | tr -d '\\n') || exit ${PROBE_CHANGED_DURING_READ}`,
    `test -d "$ROOT" || exit ${PROBE_CHANGED_DURING_READ}`,
    `ROOT_REAL_AFTER=$(readlink -f -- "$ROOT") || exit ${PROBE_CHANGED_DURING_READ}`,
    `ROOT_ID_AFTER=$(stat -c '%d:%i' -- "$ROOT_REAL_AFTER") || exit ${PROBE_CHANGED_DURING_READ}`,
    `printf '${WEB_ROOT_REAL_BEFORE_LABEL}%s\\n' "$ROOT_REAL_BEFORE"`,
    `printf '${WEB_ROOT_ID_BEFORE_LABEL}%s\\n' "$ROOT_ID_BEFORE"`,
    `printf '${WEB_MARKER_BEFORE_LABEL}%s\\n' "$MARKER_BASE64_BEFORE"`,
    `printf '${WEB_TREE_BEFORE_LABEL}%s\\n' "$TREE_BEFORE"`,
    `printf '${WEB_TREE_AFTER_LABEL}%s\\n' "$TREE_AFTER"`,
    `printf '${WEB_MARKER_AFTER_LABEL}%s\\n' "$MARKER_BASE64_AFTER"`,
    `printf '${WEB_ROOT_REAL_AFTER_LABEL}%s\\n' "$ROOT_REAL_AFTER"`,
    `printf '${WEB_ROOT_ID_AFTER_LABEL}%s\\n' "$ROOT_ID_AFTER"`,
].join("\n");

type WebConsoleProbeFields = {
    markerOutput: string;
    treeSha256: string | null;
    consistencyError: string | null;
};

const WEB_CONSOLE_PROBE_LABELS = [
    WEB_ROOT_REAL_BEFORE_LABEL,
    WEB_ROOT_ID_BEFORE_LABEL,
    WEB_MARKER_BEFORE_LABEL,
    WEB_TREE_BEFORE_LABEL,
    WEB_TREE_AFTER_LABEL,
    WEB_MARKER_AFTER_LABEL,
    WEB_ROOT_REAL_AFTER_LABEL,
    WEB_ROOT_ID_AFTER_LABEL,
] as const;

type WebConsoleProbeValues = [string, string, string, string, string, string, string, string];

function taggedWebConsoleProbeValues(output: string): WebConsoleProbeValues | null {
    if (output.length > 16_384 || /[\r\0]/.test(output)) return null;
    const lines = (output.endsWith("\n") ? output.slice(0, -1) : output).split("\n");
    if (lines.length !== WEB_CONSOLE_PROBE_LABELS.length) return null;
    const probeValues = WEB_CONSOLE_PROBE_LABELS.map((label, index) => taggedProbeValue(lines[index], label));
    return probeValues.some(probeValue => probeValue === null)
        ? null
        : probeValues as WebConsoleProbeValues;
}

function webConsoleConsistencyError(probeValues: WebConsoleProbeValues): string | null {
    const [rootBefore, rootIdBefore, markerBefore, treeBefore, treeAfter, markerAfter, rootAfter, rootIdAfter] = probeValues;
    if (rootBefore !== rootAfter || rootIdBefore !== rootIdAfter) {
        return "web_console_root_changed_during_probe";
    }
    if (markerBefore !== markerAfter) return "marker_changed_during_probe";
    return treeBefore !== treeAfter ? "tree_sha256_changed_during_probe" : null;
}

function webConsoleProbeFields(output: string): WebConsoleProbeFields | null {
    const probeValues = taggedWebConsoleProbeValues(output);
    if (!probeValues) return null;
    const [rootBefore, rootIdBefore, markerBefore, treeBefore, , markerAfter, rootAfter, rootIdAfter] = probeValues;
    const supportedRoot = /^\/opt\/supacloud\/web-console\/(?:current|releases\/[A-Za-z0-9][A-Za-z0-9._-]*)$/;
    if (![rootBefore, rootAfter].every(root => supportedRoot.test(root))) return null;
    if (![rootIdBefore, rootIdAfter].every(rootId => /^\d+:\d+$/.test(rootId))) return null;
    const markerOutput = canonicalBase64Text(markerBefore, WEB_CONSOLE_MARKER_MAX_BYTES);
    if (markerOutput === null || canonicalBase64Text(markerAfter, WEB_CONSOLE_MARKER_MAX_BYTES) === null) return null;
    const consistencyError = webConsoleConsistencyError(probeValues);
    return {
        markerOutput,
        treeSha256: consistencyError ? null : stableSha256(treeBefore),
        consistencyError,
    };
}

function webConsoleProbeError(
    execution: RemoteExecution | null,
    fields: WebConsoleProbeFields | null,
    version: string | null,
    treeSha256: string | null,
): { status: ComponentProbeStatus; error: string | null } {
    if (!execution) return { status: "error", error: "web_console_probe_transport_failed" };
    if (execution.code === WEB_CONSOLE_ROOT_MISSING) return { status: "unknown", error: "web_console_missing" };
    if (execution.code === WEB_CONSOLE_MARKER_MISSING) return { status: "unknown", error: "marker_missing" };
    if (execution.code === PROBE_CHANGED_DURING_READ) {
        return { status: "error", error: "web_console_changed_during_probe" };
    }
    if (execution.code === WEB_CONSOLE_ROOT_INVALID || execution.code === WEB_CONSOLE_TREE_INVALID) {
        return { status: "error", error: "web_console_invalid_file" };
    }
    if (execution.code === WEB_CONSOLE_MARKER_INVALID) return { status: "error", error: "marker_invalid" };
    if (execution.code === WEB_CONSOLE_TREE_FAILED) return { status: "error", error: "tree_sha256_probe_failed" };
    if (!execution.success) return { status: "error", error: "web_console_probe_failed" };
    if (!fields) return { status: "error", error: "web_console_probe_output_invalid" };
    if (fields.consistencyError) return { status: "error", error: fields.consistencyError };
    if (!version) return { status: "error", error: "marker_invalid" };
    return treeSha256 ? { status: "ok", error: null } : { status: "error", error: "tree_sha256_output_invalid" };
}

async function webConsoleEvidence(ssh: SshTransport): Promise<WebConsoleEvidence> {
    const execution = await runFixedRemoteCommand(ssh, WEB_CONSOLE_PROBE_COMMAND, WEB_CONSOLE_PROBE_TIMEOUT_MS);
    const fields = execution?.success ? webConsoleProbeFields(execution.stdout) : null;
    const version = fields && !fields.consistencyError ? parseWebConsoleVersion(fields.markerOutput) : null;
    const treeSha256 = fields?.treeSha256 ?? null;
    const state = webConsoleProbeError(execution, fields, version, treeSha256);
    return {
        status: state.status,
        version,
        tree_sha256: treeSha256,
        path: WEB_CONSOLE_CURRENT_DIR,
        source: "component_marker_and_tree_sha256",
        error: state.error,
    };
}

async function platformVersions(ssh: SshTransport) {
    const [managementApi, edgeRuntime, caddy, webConsole] = await Promise.all([
        binaryComponentEvidence(ssh, BINARY_PROBES.management_api),
        binaryComponentEvidence(ssh, BINARY_PROBES.edge_runtime),
        binaryComponentEvidence(ssh, BINARY_PROBES.caddy),
        webConsoleEvidence(ssh),
    ]);
    return {
        schema_version: 1,
        components: {
            management_api: managementApi,
            edge_runtime: edgeRuntime,
            caddy,
            web_console: webConsole,
        },
    };
}

function platformVersionsToolResult(report: Awaited<ReturnType<typeof platformVersions>>) {
    const isError = Object.values(report.components).some(component => component.status === "error");
    return {
        content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
        ...(isError ? { isError: true } : {}),
    };
}

export function registerSshTools(server: { tool: (...args: any[]) => void }, ssh: SshTransport): void {
    server.tool(
        "ssh",
        `Server management via SSH. Available before & after SupaCloud installation.
Actions: ping, setup, install, upgrade, versions, diagnose, exec, troubleshoot, container_logs, tenant_manage, tenant_list, tenant_inspect, tenant_diagnose, tenant_migrate`,
        {
            action: withDescription(stringEnum([
                "ping", "setup", "install", "upgrade", "versions", "diagnose", "exec",
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
            artifact_transport: optional(stringEnum(["local", "remote"]), "[upgrade] Download verified release assets locally or on the server (default: remote)"),
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
                    const REPO = "https://github.com/vibeunion/supacloud.git";
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
                        `git -C ${quoteEnvValue(BOOTSTRAP)} ls-files --error-unmatch setup.sh scripts/lib/install_config.sh scripts/lib/release_assets.sh packages/management-api/src/assets/sigstore-public-good-trusted-root.jsonl >/dev/null; ` +
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
                    const version = args.version
                        ? assertExactStableVersion(assertSafeReleaseTag(args.version), "version")
                        : undefined;
                    const edgeRuntimeVersion = args.edge_runtime_version
                        ? assertExactStableVersion(
                            assertSafeReleaseTag(args.edge_runtime_version),
                            "edge_runtime_version",
                        )
                        : undefined;
                    if (edgeRuntimeVersion && !version) {
                        throw new Error("'version' is required with 'edge_runtime_version'");
                    }
                    const validatedProxy = args.github_proxy ? assertSafeGithubProxy(args.github_proxy) : undefined;
                    if (args.artifact_transport === "local") {
                        if (!version || !edgeRuntimeVersion) {
                            throw new Error("Local artifact transport requires exact 'version' and 'edge_runtime_version'");
                        }
                        if (validatedProxy && !["direct", "none"].includes(validatedProxy.toLowerCase())) {
                            throw new Error("Local artifact transport only supports direct GitHub downloads");
                        }
                        text = await executeLocalUpgradeTransfer(ssh, {
                            managementVersion: version.replace(/^v/, ""),
                            edgeRuntimeVersion: edgeRuntimeVersion.replace(/^v/, ""),
                        });
                        break;
                    }
                    const githubProxy = validatedProxy && !["direct", "none"].includes(validatedProxy.toLowerCase())
                        ? validatedProxy
                        : undefined;
                    const helperPath = `/tmp/.supacloud-release-assets-${randomUUID()}/release_assets.sh`;
                    const cmd = buildOfficialUpgradeCommand({
                        version,
                        edgeRuntimeVersion,
                        githubProxy,
                        helperPath,
                    });
                    const upgradeTimeoutMs = githubProxy
                        ? PROXIED_UPGRADE_SSH_TIMEOUT_MS
                        : DIRECT_UPGRADE_SSH_TIMEOUT_MS;
                    const upgradeExecution = await executeOfficialUpgrade(ssh, helperPath, cmd, upgradeTimeoutMs);
                    const edgeBoundary = edgeRuntimeVersion ? "" : "\n⚠️ Edge Runtime was not upgraded; provide --edge_runtime_version for a component transaction.";
                    text = `✅ Upgrade done\n${upgradeExecution.stdout.slice(-300)}${edgeBoundary}`;
                    break;
                }
                case "versions": {
                    return platformVersionsToolResult(await platformVersions(ssh));
                }
                case "diagnose": {
                    const cmds = [
                        "set -o pipefail",
                        "echo '=== OS ===' && uname -a",
                        "echo '=== Memory ===' && free -h",
                        "echo '=== Disk ===' && df -h /",
                        "echo '=== Docker ===' && (docker ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || echo 'Not found')",
                        "echo '=== Management API /health ==='",
                        "(curl --fail --silent --show-error --max-time 5 --max-filesize 4096 http://127.0.0.1:9090/health 2>&1 | head -c 4096) || echo 'Probe failed'",
                        "printf '\\n'",
                        "echo '=== Management API /monitor/health ==='",
                        "(curl --fail --silent --show-error --max-time 15 --max-filesize 16384 http://127.0.0.1:9090/monitor/health 2>&1 | head -c 16384) || echo 'Probe failed'",
                        "printf '\\n'",
                    ];
                    const r = await ssh.exec(cmds.join("\n"), 30_000);
                    text = redactTenantConfig((r.stdout || r.stderr).slice(0, 32_768));
                    break;
                }
                case "exec": {
                    if (!args.command) throw new Error("'command' required");
                    const command = assertSafeExecCommand(args.command);
                    const r = await ssh.exec(command, getExecTimeoutMs(args.timeout_seconds));
                    if (!r.success) {
                        const diagnostic = r.stderr.trim() || r.stdout.trim() || "no remote diagnostic";
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
