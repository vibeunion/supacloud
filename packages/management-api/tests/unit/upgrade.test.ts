import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildEdgeRuntimeCapacityDropIn,
    buildEmbeddedEdgePrivilegeDropIn,
    buildManagementPrivilegeDropIn,
    buildCheckpointDatabaseOptions,
    backupCurrentBinary,
    activateStagedBinary,
    buildRuntimeServiceRestartPlan,
    assertExternalEdgeRuntimeUpgradeMode,
    assertEdgeRuntimeBinaryTarget,
    captureFileState,
    cleanupBinaryBackup,
    createBinaryBackupState,
    executeUpgradeTransaction,
    ensureEdgeRuntimeIdentity,
    ensureEmbeddedEdgeRuntimeSourceAccess,
    ensurePersistedEdgeRuntimeIdentity,
    activatePreparedWebConsoleLink,
    executeUpgradeRecoveryActions,
    extractWebConsoleArchive,
    formatUpgradeFailure,
    inspectActiveManagementBinary,
    inspectActiveSystemdBinary,
    normalizeEdgeRuntimeReleaseTag,
    normalizeExactManagementVersion,
    normalizeManagementReleaseTag,
    parseManagementVersionOutput,
    parsePostgrestLauncherDigestOutput,
    parseSystemdUnitBrokerDigestOutput,
    parseSystemdExecStartPath,
    parseSystemdEnabledState,
    parseSystemdMainPid,
    prepareWebConsoleLinkActivation,
    prepareUpgradeSecrets,
    resolveArtifactVerificationMode,
    resolveEdgeRuntimeCapacityConfig,
    resolveGithubEndpointPrefixes,
    resolvePersistedEdgeRuntimePort,
    resolvePersistedEdgeRuntimeMode,
    resolveUpgradeEnvironment,
    reconcileManagementPrivilegeDropIns,
    readSystemdEnabledState,
    runStagedDatabaseMigration,
    restoreCurrentBinary,
    rollbackArtifacts,
    restoreFileState,
    selectEdgeRuntimeRelease,
    selectManagementRelease,
    serializeGithubAttestationBundles,
    shouldCleanupUpgradeArtifacts,
    stopManagementService,
    supportsGithubOfflineAttestationVerification,
    upsertManagementWebConsoleDir,
    upsertPersistedEdgeRuntimePort,
    upsertEdgeRuntimeIdentityDefaults,
    UpgradeTransactionError,
    type UpgradeActivationState,
    upgradeRecoveryPaths,
    validateWebConsoleArchiveEntries,
    verifyArtifactAttestation,
    verifyActivatedManagementBinary,
    verifyArtifactChecksum,
    verifyManagementUpgradePreflight,
    verifyBackupPrivilegeDropPreflight,
    verifyWebConsoleArchiveExpandedSize,
    verifyWebConsoleReleaseTree,
    restoreWebConsoleLink,
    waitForManagementHealth,
    waitForEdgeRuntimeHealth,
    waitForUpgradeHealth,
} from "../../src/upgrade";
import {
    activatePreparedSystemdUnitBroker,
    prepareSystemdUnitBrokerActivation,
    readPrivilegedHelperIdentity,
    stageEmbeddedSystemdUnitBroker,
} from "../../src/embedded-systemd-unit-broker";

const originalFetch = globalThis.fetch;
const attestationEnvironmentKeys = [
  "GH_ARGUMENT_RECORD",
  "GH_BUNDLE_RECORD",
  "GH_LOCK_TMPDIR",
  "GH_OMIT_SOURCE_REF",
  "GH_OMIT_TRUSTED_ROOT",
  "GH_ROOT_RECORD",
  "GH_VERIFY_EXIT_CODE",
  "PATH",
  "SUPACLOUD_ALLOW_UNVERIFIED_RELEASE",
  "SUPACLOUD_GITHUB_PROXIES",
  "SUPACLOUD_GITHUB_PROXY",
  "SUPACLOUD_INTEGRITY_MODE_RECORD",
  "TMPDIR",
] as const;
const originalAttestationEnvironment = Object.fromEntries(
  attestationEnvironmentKeys.map(key => [key, process.env[key]]),
);

const originalUpgradeHealthAttempts = process.env.SUPACLOUD_UPGRADE_HEALTH_ATTEMPTS;
const originalEdgeUpgradeHealthAttempts = process.env.SUPACLOUD_UPGRADE_EDGE_HEALTH_ATTEMPTS;
const canonicalManagementBinary = "/usr/local/bin/supacloud";
const currentBinarySha256 = "a".repeat(64);

type ManagementBinaryFixture = {
  execStartPath?: string;
  executablePath?: string;
  mainPids?: string[];
  sha256?: string;
};

function managementBinaryFixture(input: ManagementBinaryFixture = {}) {
  const mainPids = input.mainPids ?? ["4242", "4242"];
  let mainPidRead = 0;
  return {
    run: async (command: string[]) => {
      if (command[3] === "--property=ExecStart") {
        const executablePath = input.execStartPath ?? canonicalManagementBinary;
        return {
          exitCode: 0,
          stdout: `{ path=${executablePath} ; argv[]=${executablePath} ; ignore_errors=no ; }\n`,
          stderr: "",
        };
      }
      if (command[3] === "--property=MainPID") {
        const stdout = mainPids[Math.min(mainPidRead, mainPids.length - 1)] ?? "";
        mainPidRead += 1;
        return { exitCode: 0, stdout: `${stdout}\n`, stderr: "" };
      }
      throw new Error(`Unexpected command: ${command.join(" ")}`);
    },
    readlink: () => input.executablePath ?? canonicalManagementBinary,
    sha256: () => input.sha256 ?? currentBinarySha256,
  };
}

function installFakeGithubCli(binDirectory: string): void {
  const executable = join(binDirectory, "gh");
  writeFileSync(executable, [
    "#!/bin/sh",
    'if [ "$1 $2 $3" = "attestation verify --help" ]; then',
    '  printf "%s\\n" "--bundle" "--signer-workflow" "--deny-self-hosted-runners"',
    '  [ "${GH_OMIT_SOURCE_REF:-false}" = "true" ] || printf "%s\\n" "--source-ref"',
    '  [ "${GH_OMIT_TRUSTED_ROOT:-false}" = "true" ] || printf "%s\\n" "--custom-trusted-root"',
    "  exit 0",
    "fi",
    'printf "%s\\n" "$*" > "$GH_ARGUMENT_RECORD"',
    'bundle=""',
    'trusted_root=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --bundle) shift; bundle="$1" ;;',
    '    --custom-trusted-root) shift; trusted_root="$1" ;;',
    '  esac',
    '  shift',
    'done',
    'case "$bundle" in */bundle.jsonl) test -f "$bundle" || exit 88 ;; *) exit 89 ;; esac',
    'case "$trusted_root" in */trusted_root.jsonl) test -f "$trusted_root" || exit 90 ;; *) exit 91 ;; esac',
    'cp "$bundle" "$GH_BUNDLE_RECORD"',
    'cp "$trusted_root" "$GH_ROOT_RECORD"',
    '[ "${GH_LOCK_TMPDIR:-false}" = "true" ] && chmod 0555 "$TMPDIR"',
    'exit "${GH_VERIFY_EXIT_CODE:-0}"',
    "",
  ].join("\n"));
  chmodSync(executable, 0o755);
}

function createAttestationFixture() {
  const directory = mkdtempSync(join(tmpdir(), "supacloud-upgrade-attestation-"));
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  installFakeGithubCli(binDirectory);
  const artifact = join(directory, "artifact");
  writeFileSync(artifact, "verified artifact fixture");
  process.env.PATH = `${binDirectory}:${originalAttestationEnvironment.PATH ?? ""}`;
  process.env.TMPDIR = directory;
  process.env.GH_ARGUMENT_RECORD = join(directory, "gh-arguments.txt");
  process.env.GH_BUNDLE_RECORD = join(directory, "bundle-copy.jsonl");
  process.env.GH_ROOT_RECORD = join(directory, "trusted-root-copy.jsonl");
  process.env.SUPACLOUD_INTEGRITY_MODE_RECORD = join(directory, "integrity-mode");
  return { artifact, directory };
}

const ensureHealthTimeout = () => {
  process.env.SUPACLOUD_UPGRADE_HEALTH_ATTEMPTS = "1";
  process.env.SUPACLOUD_UPGRADE_EDGE_HEALTH_ATTEMPTS = "1";
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of attestationEnvironmentKeys) {
    const originalValue = originalAttestationEnvironment[key];
    if (originalValue === undefined) delete process.env[key];
    else process.env[key] = originalValue;
  }
  if (originalUpgradeHealthAttempts === undefined) {
    delete process.env.SUPACLOUD_UPGRADE_HEALTH_ATTEMPTS;
  } else {
    process.env.SUPACLOUD_UPGRADE_HEALTH_ATTEMPTS = originalUpgradeHealthAttempts;
  }
  if (originalEdgeUpgradeHealthAttempts === undefined) {
    delete process.env.SUPACLOUD_UPGRADE_EDGE_HEALTH_ATTEMPTS;
  } else {
    process.env.SUPACLOUD_UPGRADE_EDGE_HEALTH_ATTEMPTS = originalEdgeUpgradeHealthAttempts;
  }
});

describe("upgrade release selection", () => {
  test("pins secret checkpoint verification to DATABASE_URL despite ambient PGDATABASE", async () => {
    const originalPgDatabase = process.env.PGDATABASE;
    process.env.PGDATABASE = "postgres";
    let database: SQL | undefined;

    try {
      const options = buildCheckpointDatabaseOptions(
        "postgresql://postgres:placeholder@127.0.0.1:5432/supacloud_meta?sslmode=disable",
      );
      database = new SQL(options);
      expect(options).toEqual({
        url: "postgresql://postgres:placeholder@127.0.0.1:5432/supacloud_meta?sslmode=disable",
        database: "supacloud_meta",
        max: 1,
      });
      expect(database.options.database).toBe("supacloud_meta");
    } finally {
      if (database) await database.close();
      if (originalPgDatabase === undefined) delete process.env.PGDATABASE;
      else process.env.PGDATABASE = originalPgDatabase;
    }
  });

  test("decodes an escaped database name for checkpoint verification", () => {
    expect(buildCheckpointDatabaseOptions(
      "postgresql://postgres:placeholder@127.0.0.1:5432/tenant%5Fmeta",
    ).database).toBe("tenant_meta");
  });

  test("rejects checkpoint verification without an explicit database name", () => {
    expect(() => buildCheckpointDatabaseOptions(
      "postgresql://postgres:placeholder@127.0.0.1:5432",
    )).toThrow("DATABASE_URL must include a database name");
  });

  test("creates the dedicated Edge Runtime identity during a Linux upgrade", async () => {
    const commands: string[][] = [];
    const responses = [
      { exitCode: 2, stdout: "", stderr: "missing group" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "missing user" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "998\n", stderr: "" },
      { exitCode: 0, stdout: "supacloud-edge\n", stderr: "" },
    ];

    const identity = await ensureEdgeRuntimeIdentity({}, {
      platform: "linux",
      run: async (command) => {
        commands.push(command);
        const response = responses.shift();
        if (!response) throw new Error("Unexpected identity command");
        return response;
      },
    });

    expect(identity).toEqual({ user: "supacloud-edge", group: "supacloud-edge" });
    expect(commands).toEqual([
      ["getent", "group", "supacloud-edge"],
      ["groupadd", "--system", "supacloud-edge"],
      ["id", "-u", "supacloud-edge"],
      [
        "useradd", "--system", "--no-create-home", "--home-dir", "/nonexistent",
        "--shell", "/usr/sbin/nologin", "--gid", "supacloud-edge", "supacloud-edge",
      ],
      ["id", "-u", "supacloud-edge"],
      ["id", "-gn", "supacloud-edge"],
    ]);
  });

  test("rejects a privileged or mismatched existing Edge Runtime account", async () => {
    const responses = [
      { exitCode: 0, stdout: "supacloud-edge:x:998:\n", stderr: "" },
      { exitCode: 0, stdout: "0\n", stderr: "" },
      { exitCode: 0, stdout: "0\n", stderr: "" },
      { exitCode: 0, stdout: "supacloud-edge\n", stderr: "" },
    ];

    await expect(ensureEdgeRuntimeIdentity({}, {
      platform: "linux",
      run: async () => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected identity command");
        return response;
      },
    })).rejects.toThrow("violates the dedicated runtime-user contract");
  });

  test("keeps an existing dedicated Edge Runtime identity unchanged", async () => {
    const commands: string[][] = [];
    const responses = [
      { exitCode: 0, stdout: "supacloud-edge:x:998:\n", stderr: "" },
      { exitCode: 0, stdout: "998\n", stderr: "" },
      { exitCode: 0, stdout: "998\n", stderr: "" },
      { exitCode: 0, stdout: "supacloud-edge\n", stderr: "" },
    ];

    await ensureEdgeRuntimeIdentity({}, {
      platform: "linux",
      run: async (command) => {
        commands.push(command);
        const response = responses.shift();
        if (!response) throw new Error("Unexpected identity command");
        return response;
      },
    });

    expect(commands.every(([command]) => command !== "groupadd" && command !== "useradd")).toBe(true);
  });

  test("adds missing Edge Runtime defaults without replacing custom account values", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-edge-identity-"));
    const envFile = join(dir, "management-api.env");
    writeFileSync(envFile, "EDGE_RUNTIME_USER=custom-edge\nEDGE_RUNTIME_GROUP=\nPORT=9090\n", { mode: 0o600 });

    try {
      upsertEdgeRuntimeIdentityDefaults(envFile, {
        user: "supacloud-edge",
        group: "supacloud-edge",
      });
      expect(readFileSync(envFile, "utf8")).toBe(
        "EDGE_RUNTIME_USER=custom-edge\nEDGE_RUNTIME_GROUP=supacloud-edge\nPORT=9090\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provisions the identity from the persistent service environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-persisted-edge-"));
    const envFile = join(dir, "management-api.env");
    writeFileSync(envFile, "EDGE_RUNTIME_USER=file-edge\nEDGE_RUNTIME_GROUP=file-edge-group\n", { mode: 0o600 });

    try {
      const identity = await ensurePersistedEdgeRuntimeIdentity(envFile, { platform: "darwin" });
      expect(identity).toEqual({ user: "file-edge", group: "file-edge-group" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replaces empty persisted Edge Runtime identity values", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-empty-edge-"));
    const envFile = join(dir, "management-api.env");
    writeFileSync(envFile, "EDGE_RUNTIME_USER=\nEDGE_RUNTIME_GROUP=\n", { mode: 0o600 });

    try {
      upsertEdgeRuntimeIdentityDefaults(envFile, { user: "supacloud-edge", group: "supacloud-edge" });
      expect(readFileSync(envFile, "utf8")).toBe(
        "EDGE_RUNTIME_USER=supacloud-edge\nEDGE_RUNTIME_GROUP=supacloud-edge\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restores the old runtime key when init-db fails before the rotation checkpoint", async () => {
    const events: string[] = [];
    const prepared = prepareUpgradeSecrets({
      MASTER_TOKEN: "master-token-0123456789abcdef0123456789abcdef",
      DATABASE_URL: "postgresql://postgres:test@localhost:5432/supacloud_meta",
    });

    await expect(runStagedDatabaseMigration("/staged/supacloud", prepared, {
      captureRuntimeEnv: () => ({ path: "/runtime.env", existed: true, content: Buffer.from("old"), mode: 0o600 }),
      stopService: async () => { events.push("stop"); },
      persistSecrets: () => { events.push("persist"); },
      runInit: async () => { events.push("init"); throw new Error("init failed"); },
      hasCheckpoint: async () => { events.push("checkpoint:false"); return false; },
      restoreRuntimeEnv: () => { events.push("restore-env"); },
      restart: async () => { events.push("restart"); },
      healthCheck: async () => { events.push("health"); },
    })).rejects.toThrow("init failed");

    expect(events).toEqual(["stop", "persist", "init", "checkpoint:false", "restore-env", "restart", "health"]);
  });

  test("keeps the current runtime key when init-db reports failure after a durable rotation checkpoint", async () => {
    const events: string[] = [];
    const prepared = prepareUpgradeSecrets({
      MASTER_TOKEN: "master-token-0123456789abcdef0123456789abcdef",
      DATABASE_URL: "postgresql://postgres:test@localhost:5432/supacloud_meta",
    });

    await expect(runStagedDatabaseMigration("/staged/supacloud", prepared, {
      captureRuntimeEnv: () => ({ path: "/runtime.env", existed: true, content: Buffer.from("old"), mode: 0o600 }),
      stopService: async () => { events.push("stop"); },
      persistSecrets: () => { events.push("persist"); },
      runInit: async () => { events.push("init"); throw new Error("post-commit failure"); },
      hasCheckpoint: async () => { events.push("checkpoint:true"); return true; },
      restoreRuntimeEnv: () => { events.push("restore-env"); },
      restart: async () => { events.push("restart"); },
      healthCheck: async () => { events.push("health"); },
    })).rejects.toThrow("post-commit failure");

    expect(events).toEqual(["stop", "persist", "init", "checkpoint:true", "restart", "health"]);
  });

  test("leaves the service stopped when checkpoint state cannot be read safely", async () => {
    const events: string[] = [];
    const prepared = prepareUpgradeSecrets({
      MASTER_TOKEN: "master-token-0123456789abcdef0123456789abcdef",
      DATABASE_URL: "postgresql://postgres:test@localhost:5432/supacloud_meta",
    });

    await expect(runStagedDatabaseMigration("/staged/supacloud", prepared, {
      captureRuntimeEnv: () => ({ path: "/runtime.env", existed: false }),
      stopService: async () => { events.push("stop"); },
      persistSecrets: () => { events.push("persist"); },
      runInit: async () => { events.push("init"); throw new Error("init failed"); },
      hasCheckpoint: async () => { events.push("checkpoint:error"); throw new Error("database unavailable"); },
      restoreRuntimeEnv: () => { events.push("restore-env"); },
      restart: async () => { events.push("restart"); },
      healthCheck: async () => { events.push("health"); },
    })).rejects.toThrow("service remains stopped");

    expect(events).toEqual(["stop", "persist", "init", "checkpoint:error"]);
  });

  test("recovers a service that partially stopped before reporting a systemctl error", async () => {
    const events: string[] = [];
    const activeStates = [true, false];

    await expect(stopManagementService({
      isActive: async () => activeStates.shift() ?? false,
      stop: async () => ({ exitCode: 1, stderr: "stop timed out" }),
      start: async () => { events.push("start"); return { exitCode: 0, stderr: "" }; },
      healthCheck: async () => { events.push("health"); },
    })).rejects.toThrow("stop timed out");

    expect(events).toEqual(["start", "health"]);
  });

  test("upgrade init-db ignores tracked legacy config unless explicitly opted in", async () => {
    const reads: string[] = [];
    const readEnv = async (filePath: string) => {
      reads.push(filePath);
      if (filePath === "/runtime.env") return { RUNTIME_ONLY: "runtime", SHARED: "runtime" };
      if (filePath === "/legacy.env") return { LEGACY_ONLY: "legacy", SHARED: "legacy" };
      return {};
    };

    const normal = await resolveUpgradeEnvironment({
      env: { SHARED: "explicit" },
      managementEnvPath: "/runtime.env",
      legacyEnvPath: "/legacy.env",
      readEnv,
    });
    expect(normal).toEqual({ RUNTIME_ONLY: "runtime", SHARED: "explicit" });
    expect(reads).toEqual(["/runtime.env"]);

    reads.length = 0;
    const optedIn = await resolveUpgradeEnvironment({
      env: { SUPACLOUD_LOAD_LEGACY_CONFIG_ENV: "true", SHARED: "explicit" },
      managementEnvPath: "/runtime.env",
      legacyEnvPath: "/legacy.env",
      readEnv,
    });
    expect(optedIn.LEGACY_ONLY).toBe("legacy");
    expect(optedIn.SHARED).toBe("explicit");
    expect(reads).toEqual(["/runtime.env", "/legacy.env"]);
  });

  test("prepares independent runtime secrets and keeps the old master token migration-only", () => {
    const masterToken = "master-token-0123456789abcdef0123456789abcdef";
    const prepared = prepareUpgradeSecrets({ MASTER_TOKEN: masterToken });

    expect(prepared.runtimeEnv.LEGACY_SECRETS_ENCRYPTION_KEY).toBe(masterToken);
    expect(prepared.runtimeEnv.SECRETS_ENCRYPTION_KEY).not.toBe(masterToken);
    expect(prepared.runtimeEnv.SUPAOAUTH_BFF_SIGNING_SECRET).not.toBe(masterToken);
    expect(prepared.runtimeEnv.SUPAOAUTH_BFF_SIGNING_SECRET)
      .not.toBe(prepared.runtimeEnv.SECRETS_ENCRYPTION_KEY);
    expect(prepared.runtimeSecretsToPersist).toEqual({
      SECRETS_ENCRYPTION_KEY: prepared.runtimeEnv.SECRETS_ENCRYPTION_KEY,
      SUPAOAUTH_BFF_SIGNING_SECRET: prepared.runtimeEnv.SUPAOAUTH_BFF_SIGNING_SECRET,
    });
    expect(prepared.runtimeSecretsToPersist).not.toHaveProperty("LEGACY_SECRETS_ENCRYPTION_KEY");
  });

  test("preserves an already separated encryption key without inventing a legacy fallback", () => {
    const existing = {
      MASTER_TOKEN: "master-token-0123456789abcdef0123456789abcdef",
      SECRETS_ENCRYPTION_KEY: "encryption-key-0123456789abcdef0123456789abcdef",
      SUPAOAUTH_BFF_SIGNING_SECRET: "bff-signing-key-0123456789abcdef0123456789abcdef",
    };
    const prepared = prepareUpgradeSecrets(existing);

    expect(prepared.runtimeEnv).toEqual(existing);
    expect(prepared.runtimeSecretsToPersist).toEqual({
      SECRETS_ENCRYPTION_KEY: existing.SECRETS_ENCRYPTION_KEY,
      SUPAOAUTH_BFF_SIGNING_SECRET: existing.SUPAOAUTH_BFF_SIGNING_SECRET,
    });
  });

  test("normalizes explicit versions and ignores unrelated latest component releases", () => {
    expect(normalizeExactManagementVersion("0.50.30")).toBe("0.50.30");
    expect(normalizeExactManagementVersion("management-api-v0.50.30")).toBe("0.50.30");
    expect(() => normalizeExactManagementVersion("latest")).toThrow("exact stable");
    expect(normalizeManagementReleaseTag("0.38.0")).toBe("management-api-v0.38.0");
    expect(normalizeManagementReleaseTag("v0.38.0")).toBe("management-api-v0.38.0");
    expect(normalizeManagementReleaseTag("management-api-v0.38.0")).toBe("management-api-v0.38.0");

    const selected = selectManagementRelease(
      [
        {
          tag_name: "edge-runtime-v0.9.0",
          draft: false,
          prerelease: false,
          assets: [{ name: "supacloud-edge-runtime-linux-amd64" }],
        },
        {
          tag_name: "management-api-v0.38.0",
          draft: false,
          prerelease: false,
          assets: [
            { name: "supacloud-linux-amd64" },
            { name: "SHA256SUMS" },
          ],
        },
        {
          tag_name: "management-api-v0.37.0",
          draft: false,
          prerelease: false,
          assets: [
            { name: "supacloud-linux-amd64" },
            { name: "web-console-build.tar.gz" },
            { name: "SHA256SUMS" },
          ],
        },
      ],
      "supacloud-linux-amd64",
    );

    expect(selected.tag_name).toBe("management-api-v0.37.0");
  });

  test("requires Management --version to report one exact stable version", () => {
    expect(parseManagementVersionOutput("SupaCloud Version: 0.50.30\n")).toBe("0.50.30");
    expect(parseManagementVersionOutput('{"message":"SupaCloud Version: 0.50.30"}\n')).toBe("0.50.30");
    for (const invalid of [
      "SupaCloud Version: 0.50.30-beta.1\n",
      "SupaCloud Version: 0.50.29\nextra\n",
      '{"message":"Edge Runtime Version: 0.16.8"}\n',
    ]) {
      expect(() => parseManagementVersionOutput(invalid)).toThrow();
    }
  });

  test("requires the Management helper identity command to report one exact digest", () => {
    const digest = "b".repeat(64);
    expect(parseSystemdUnitBrokerDigestOutput(
      `SupaCloud systemd-unit helper SHA-256: ${digest}\n`,
    )).toBe(digest);
    expect(parseSystemdUnitBrokerDigestOutput(JSON.stringify({
      message: `SupaCloud systemd-unit helper SHA-256: ${digest}`,
    }))).toBe(digest);
    expect(() => parseSystemdUnitBrokerDigestOutput(
      `SupaCloud systemd-unit helper SHA-256: ${digest}\nextra\n`,
    )).toThrow("exactly one line");

    expect(parsePostgrestLauncherDigestOutput(
      `SupaCloud PostgREST launcher SHA-256: ${digest}\n`,
    )).toBe(digest);
    expect(parsePostgrestLauncherDigestOutput(JSON.stringify({
      message: `SupaCloud PostgREST launcher SHA-256: ${digest}`,
    }))).toBe(digest);
    expect(() => parsePostgrestLauncherDigestOutput(
      `SupaCloud PostgREST launcher SHA-256: ${digest}\nextra\n`,
    )).toThrow("exactly one line");
  });

  test("selects only the explicitly pinned Edge Runtime release with its own checksum", () => {
    expect(normalizeEdgeRuntimeReleaseTag("0.16.7")).toBe("edge-runtime-v0.16.7");
    expect(normalizeEdgeRuntimeReleaseTag("v0.16.7")).toBe("edge-runtime-v0.16.7");
    expect(normalizeEdgeRuntimeReleaseTag("edge-runtime-v0.16.7")).toBe("edge-runtime-v0.16.7");
    for (const invalidVersion of ["latest", "", "0.16", "0.16.7-beta.1"]) {
      expect(() => normalizeEdgeRuntimeReleaseTag(invalidVersion)).toThrow("exact stable");
    }

    const selected = selectEdgeRuntimeRelease({
      tag_name: "edge-runtime-v0.16.7",
      draft: false,
      prerelease: false,
      assets: [
        { name: "supacloud-edge-runtime-linux-amd64" },
        { name: "SHA256SUMS" },
      ],
    }, "edge-runtime-v0.16.7", "supacloud-edge-runtime-linux-amd64");

    expect(selected.tag_name).toBe("edge-runtime-v0.16.7");
    expect(() => selectEdgeRuntimeRelease({
      tag_name: "edge-runtime-v0.16.6",
      draft: false,
      prerelease: false,
      assets: [
        { name: "supacloud-edge-runtime-linux-amd64" },
        { name: "SHA256SUMS" },
      ],
    }, "edge-runtime-v0.16.7", "supacloud-edge-runtime-linux-amd64"))
      .toThrow("edge-runtime-v0.16.7");
  });

  test("release verification is fail-closed unless break-glass is explicitly enabled", () => {
    expect(resolveArtifactVerificationMode(true, {})).toBe("attested");
    expect(() => resolveArtifactVerificationMode(false, {})).toThrow("attestation verification is required");
    expect(resolveArtifactVerificationMode(false, {
      SUPACLOUD_ALLOW_UNVERIFIED_RELEASE: "true",
    })).toBe("limited");
  });

  test("GitHub endpoints are direct-first and do not add an implicit proxy", () => {
    expect(resolveGithubEndpointPrefixes({})).toEqual([""]);
    expect(resolveGithubEndpointPrefixes({
      SUPACLOUD_GITHUB_PROXY: "https://proxy.example.test",
    })).toEqual(["", "https://proxy.example.test/"]);
  });

  test("offline attestation capability requires every gh verification flag", () => {
    const requiredFlags = [
      "--bundle",
      "--custom-trusted-root",
      "--signer-workflow",
      "--source-ref",
      "--deny-self-hosted-runners",
    ];
    expect(supportsGithubOfflineAttestationVerification(0, requiredFlags.join("\n"))).toBe(true);
    expect(supportsGithubOfflineAttestationVerification(0, requiredFlags.map(flag => `${flag}=value`).join("\n"))).toBe(true);
    expect(supportsGithubOfflineAttestationVerification(1, requiredFlags.join("\n"))).toBe(false);
    for (const omittedFlag of requiredFlags) {
      expect(supportsGithubOfflineAttestationVerification(
        0,
        requiredFlags.filter(flag => flag !== omittedFlag).join("\n"),
      )).toBe(false);
    }
    expect(supportsGithubOfflineAttestationVerification(
      0,
      ["--bundle-from-oci", "--signer-workflow-repository", "--source-ref-pattern"].join("\n"),
    )).toBe(false);
  });

  test("serializes every validated GitHub attestation bundle as JSONL", () => {
    expect(serializeGithubAttestationBundles({
      attestations: [
        { bundle: { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" } },
        { bundle: { verificationMaterial: { tlogEntries: [] } } },
      ],
    })).toBe([
      '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}',
      '{"verificationMaterial":{"tlogEntries":[]}}',
      "",
    ].join("\n"));

    for (const invalidPayload of [
      null,
      {},
      { attestations: [] },
      { attestations: [{ bundle: null }] },
      { attestations: [{ bundle: [] }] },
      { attestations: [{ bundle: "invalid" }] },
    ]) {
      expect(() => serializeGithubAttestationBundles(invalidPayload)).toThrow("attestation");
    }
  });

  test("downloads a public digest bundle direct-first and verifies the pinned source ref", async () => {
    const fixture = createAttestationFixture();
    const requests: string[] = [];
    process.env.SUPACLOUD_GITHUB_PROXY = "https://proxy.example.test/";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const requestUrl = String(input);
      requests.push(requestUrl);
      if (requests.length === 1) return new Response("unavailable", { status: 503 });
      return Response.json({ attestations: [{ bundle: { mediaType: "sigstore" } }] });
    }) as typeof fetch;

    try {
      await expect(verifyArtifactAttestation({ filePath: fixture.artifact, forceYes: true })).resolves.toBeUndefined();
      const digest = createHash("sha256").update(readFileSync(fixture.artifact)).digest("hex");
      const apiUrl = `https://api.github.com/repos/vibeunion/supacloud/attestations/sha256:${digest}`;
      expect(requests).toEqual([apiUrl, `https://proxy.example.test/${apiUrl}`]);
      const ghArguments = readFileSync(process.env.GH_ARGUMENT_RECORD!, "utf8");
      expect(ghArguments).toContain("--bundle");
      expect(ghArguments).toContain("/bundle.jsonl");
      expect(ghArguments).toContain("--custom-trusted-root");
      expect(ghArguments).toContain("/trusted_root.jsonl");
      expect(ghArguments).toContain("--repo vibeunion/supacloud");
      expect(ghArguments).toContain("--signer-workflow vibeunion/supacloud/.github/workflows/release-please.yml");
      expect(ghArguments).toContain("--source-ref refs/heads/main");
      expect(ghArguments).toContain("--deny-self-hosted-runners");
      expect(readFileSync(process.env.GH_BUNDLE_RECORD!, "utf8")).toBe('{"mediaType":"sigstore"}\n');
      expect(createHash("sha256").update(readFileSync(process.env.GH_ROOT_RECORD!)).digest("hex"))
        .toBe("3c2cc7f357dc064ec527fdcd78da6e9245c21a381e1abaa0f2b62b186bcac1a1");
      expect(readdirSync(fixture.directory).filter(name => name.startsWith("supacloud-sigstore-"))).toEqual([]);
      expect(readFileSync(process.env.SUPACLOUD_INTEGRITY_MODE_RECORD!, "utf8").trim())
        .toBe("github-attestation+same-release-sha256");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test("propagates gh verification failure and removes the temporary bundle", async () => {
    const fixture = createAttestationFixture();
    process.env.GH_VERIFY_EXIT_CODE = "9";
    globalThis.fetch = (async () => Response.json({
      attestations: [{ bundle: { mediaType: "sigstore" } }],
    })) as typeof fetch;

    try {
      await expect(verifyArtifactAttestation({ filePath: fixture.artifact, forceYes: true }))
        .rejects.toThrow("GitHub artifact attestation verification failed");
      expect(readdirSync(fixture.directory).filter(name => name.startsWith("supacloud-sigstore-"))).toEqual([]);
      expect(existsSync(process.env.SUPACLOUD_INTEGRITY_MODE_RECORD!)).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test("preserves verification and cleanup errors together", async () => {
    const fixture = createAttestationFixture();
    process.env.GH_VERIFY_EXIT_CODE = "9";
    process.env.GH_LOCK_TMPDIR = "true";
    globalThis.fetch = (async () => Response.json({
      attestations: [{ bundle: { mediaType: "sigstore" } }],
    })) as typeof fetch;
    let failure: unknown;

    try {
      await verifyArtifactAttestation({ filePath: fixture.artifact, forceYes: true });
    } catch (error: unknown) {
      failure = error;
    } finally {
      chmodSync(fixture.directory, 0o700);
      rmSync(fixture.directory, { recursive: true, force: true });
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(errors.some(error => String(error).includes("verification failed"))).toBe(true);
    expect(errors.some(error => String(error).includes("EACCES") || String(error).includes("permission"))).toBe(true);
  });

  test("missing offline capability only permits the existing explicit break-glass", async () => {
    const fixture = createAttestationFixture();
    process.env.GH_OMIT_SOURCE_REF = "true";
    process.env.SUPACLOUD_ALLOW_UNVERIFIED_RELEASE = "true";
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("attestation API must not be called in break-glass mode");
    }) as typeof fetch;

    try {
      await expect(verifyArtifactAttestation({ filePath: fixture.artifact, forceYes: true })).resolves.toBeUndefined();
      expect(fetchCalled).toBe(false);
      expect(readFileSync(process.env.SUPACLOUD_INTEGRITY_MODE_RECORD!, "utf8").trim())
        .toBe("break-glass:same-release-sha256-only");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test("rejects an artifact whose digest differs from the same-release checksum", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-checksum-"));
    const artifact = join(dir, "supacloud-linux-amd64");
    writeFileSync(artifact, "tampered");

    try {
      expect(() => verifyArtifactChecksum(
        artifact,
        "supacloud-linux-amd64",
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  supacloud-linux-amd64\n",
      )).toThrow("SHA256 mismatch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parses a single canonical systemd ExecStart path", () => {
    expect(parseSystemdExecStartPath(
      "{ path=/usr/local/bin/supacloud ; argv[]=/usr/local/bin/supacloud --serve ; ignore_errors=no ; }\n",
    )).toBe(canonicalManagementBinary);
  });

  test("rejects empty, relative, and ambiguous systemd ExecStart values", () => {
    expect(() => parseSystemdExecStartPath("")).toThrow("exactly one executable path");
    expect(() => parseSystemdExecStartPath("{ path=bin/supacloud ; argv[]=bin/supacloud ; }"))
      .toThrow("absolute path");
    expect(() => parseSystemdExecStartPath(
      "{ path=/usr/local/bin/supacloud ; } ; { path=/opt/supacloud/bin/supacloud ; }",
    )).toThrow("exactly one executable path");
  });

  test("rejects inactive, malformed, and unsafe MainPID values", () => {
    for (const value of ["0", "1", "not-a-pid", "9007199254740992"]) {
      expect(() => parseSystemdMainPid(value)).toThrow();
    }
    expect(parseSystemdMainPid("4242\n")).toBe(4242);
  });

  test("inspects a stable canonical active Management binary", async () => {
    await expect(inspectActiveManagementBinary(managementBinaryFixture())).resolves.toEqual({
      unit: "supacloud.service",
      execStartPath: canonicalManagementBinary,
      pid: 4242,
      executablePath: canonicalManagementBinary,
      sha256: currentBinarySha256,
    });
  });

  test("inspects an external Edge Runtime through its real systemd target", async () => {
    const edgeTarget = "/opt/supacloud/bin/supacloud-edge-runtime";
    const fixture = managementBinaryFixture({
      execStartPath: edgeTarget,
      executablePath: edgeTarget,
    });
    await expect(inspectActiveSystemdBinary("supacloud-edge-runtime.service", fixture)).resolves.toEqual({
      unit: "supacloud-edge-runtime.service",
      execStartPath: edgeTarget,
      pid: 4242,
      executablePath: edgeTarget,
      sha256: currentBinarySha256,
    });
  });

  test("rejects Edge Runtime targets that could overwrite another executable", () => {
    expect(() => assertEdgeRuntimeBinaryTarget("/usr/local/bin/supacloud-edge-runtime")).not.toThrow();
    expect(() => assertEdgeRuntimeBinaryTarget("/opt/supacloud/bin/supacloud-edge-runtime")).not.toThrow();
    for (const unsafeTarget of [
      "/usr/local/bin/supacloud",
      "/usr/local/bin/edge-runtime",
      "/opt/supacloud/bin/supacloud-edge-runtime.backup",
      "/tmp/supacloud-edge-runtime",
    ]) {
      expect(() => assertEdgeRuntimeBinaryTarget(unsafeTarget)).toThrow("Unsafe Edge Runtime upgrade target");
    }
  });

  test("accepts only the enabled states that the component transaction preserves", () => {
    expect(parseSystemdEnabledState({ exitCode: 0, stdout: "enabled\n", stderr: "" })).toBe("enabled");
    expect(parseSystemdEnabledState({ exitCode: 1, stdout: "disabled\n", stderr: "" })).toBe("disabled");
    expect(() => parseSystemdEnabledState({ exitCode: 0, stdout: "static\n", stderr: "" })).toThrow();
    expect(() => parseSystemdEnabledState({ exitCode: 1, stdout: "", stderr: "not found" })).toThrow();
  });

  test("reads enabled and disabled Edge unit states without normalizing them", async () => {
    for (const state of ["enabled", "disabled"] as const) {
      const exitCode = state === "enabled" ? 0 : 1;
      await expect(readSystemdEnabledState("supacloud-edge-runtime.service", async command => {
        expect(command).toEqual(["systemctl", "is-enabled", "supacloud-edge-runtime.service"]);
        return { exitCode, stdout: `${state}\n`, stderr: "" };
      })).resolves.toBe(state);
    }
    await expect(readSystemdEnabledState("supacloud-edge-runtime.service", async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "unit missing",
    }))).rejects.toThrow("supacloud-edge-runtime.service enabled state");
  });

  test("component upgrade rejects embedded mode before artifact work", () => {
    expect(() => assertExternalEdgeRuntimeUpgradeMode("embedded"))
      .toThrow("persisted external mode only");
    expect(() => assertExternalEdgeRuntimeUpgradeMode("external")).not.toThrow();
  });

  test("fails closed when systemd, procfs, hashing, or PID stability cannot be verified", async () => {
    await expect(verifyManagementUpgradePreflight({
      ...managementBinaryFixture(),
      run: async () => ({ exitCode: 1, stdout: "", stderr: "unit unavailable" }),
    })).rejects.toThrow("unit unavailable");

    await expect(verifyManagementUpgradePreflight({
      ...managementBinaryFixture(),
      readlink: () => { throw new Error("procfs unavailable"); },
    })).rejects.toThrow("procfs unavailable");

    await expect(verifyManagementUpgradePreflight({
      ...managementBinaryFixture(),
      sha256: () => { throw new Error("read failed"); },
    })).rejects.toThrow("Cannot hash supacloud.service active executable");

    await expect(verifyManagementUpgradePreflight(managementBinaryFixture({
      mainPids: ["4242", "4343"],
    }))).rejects.toThrow("MainPID changed from 4242 to 4343");
  });

  test("upgrade preflight requires setpriv and id before staging", () => {
    const installedPaths = new Set(["/usr/bin/setpriv", "/usr/bin/id"]);
    expect(() => verifyBackupPrivilegeDropPreflight((filePath) => installedPaths.has(filePath))).not.toThrow();
    expect(() => verifyBackupPrivilegeDropPreflight((filePath) => filePath.endsWith("/id")))
      .toThrow("requires setpriv");
    expect(() => verifyBackupPrivilegeDropPreflight((filePath) => filePath.endsWith("/setpriv")))
      .toThrow("requires id");
  });

  test("rejects a deleted active executable", async () => {
    await expect(verifyManagementUpgradePreflight(managementBinaryFixture({
      executablePath: `${canonicalManagementBinary} (deleted)`,
    }))).rejects.toThrow(`runs ${canonicalManagementBinary} (deleted)`);
  });

  test("preflight mismatch stops before staging or database migration", async () => {
    const events: string[] = [];
    const customBinary = "/opt/supacloud/bin/supacloud";

    await expect(executeUpgradeTransaction({
      preflight: async () => {
        events.push("preflight");
        await verifyManagementUpgradePreflight(managementBinaryFixture({
          execStartPath: customBinary,
          executablePath: customBinary,
        }));
      },
      stage: async () => { events.push("stage"); },
      migrate: async () => { events.push("migrate"); },
      activate: async () => { events.push("activate"); },
      restart: async () => { events.push("restart"); },
      healthCheck: async () => { events.push("health"); },
      rollback: async () => { events.push("rollback"); },
      cleanup: async () => { events.push("cleanup"); },
    })).rejects.toThrow(`ExecStart is ${customBinary}`);

    expect(events).toEqual(["preflight", "cleanup"]);
  });

  test("healthy old service with a different digest triggers rollback", async () => {
    const events: string[] = [];
    const stagedSha256 = "b".repeat(64);
    ensureHealthTimeout();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(url.endsWith("/") ? "<!doctype html>" : "ok", {
        status: 200,
        headers: { "content-type": url.endsWith("/") ? "text/html" : "application/json" },
      });
    }) as typeof fetch;

    await expect(executeUpgradeTransaction({
      preflight: async () => { events.push("preflight"); },
      stage: async () => { events.push("stage"); },
      migrate: async () => { events.push("migrate"); },
      activate: async () => { events.push("activate"); },
      restart: async () => { events.push("restart"); },
      healthCheck: async () => {
        events.push("health");
        await waitForUpgradeHealth();
        await verifyActivatedManagementBinary(stagedSha256, managementBinaryFixture({
          sha256: currentBinarySha256,
        }));
      },
      rollback: async () => { events.push("rollback"); },
      cleanup: async () => { events.push("cleanup"); },
    })).rejects.toThrow("does not match the staged release binary");

    expect(events).toEqual([
      "preflight",
      "stage",
      "migrate",
      "activate",
      "restart",
      "health",
      "rollback",
      "cleanup",
    ]);
  });

  test("canonical active path with a stable PID and staged digest can commit", async () => {
    const events: string[] = [];

    await expect(executeUpgradeTransaction({
      preflight: async () => { events.push("preflight"); },
      stage: async () => { events.push("stage"); },
      migrate: async () => { events.push("migrate"); },
      activate: async () => { events.push("activate"); },
      restart: async () => { events.push("restart"); },
      healthCheck: async () => {
        events.push("health");
        await verifyActivatedManagementBinary(currentBinarySha256, managementBinaryFixture());
      },
      rollback: async () => { events.push("rollback"); },
      cleanup: async () => { events.push("cleanup"); },
    })).resolves.toBeUndefined();

    expect(events).toEqual([
      "preflight",
      "stage",
      "migrate",
      "activate",
      "restart",
      "health",
      "cleanup",
    ]);
  });

  test("restores activated artifacts when the post-restart health check fails", async () => {
    const events: string[] = [];

    await expect(executeUpgradeTransaction({
      preflight: async () => { events.push("preflight"); },
      stage: async () => { events.push("stage"); },
      migrate: async () => { events.push("migrate"); },
      activate: async () => { events.push("activate"); },
      restart: async () => { events.push("restart"); },
      healthCheck: async () => {
        events.push("health");
        throw new Error("unhealthy");
      },
      rollback: async () => { events.push("rollback"); },
      cleanup: async () => { events.push("cleanup"); },
    })).rejects.toThrow("unhealthy");

    expect(events).toEqual([
      "preflight",
      "stage",
      "migrate",
      "activate",
      "restart",
      "health",
      "rollback",
      "cleanup",
    ]);
  });

  test("preserves recovery evidence and both errors when rollback fails", async () => {
    const events: string[] = [];
    let failure: unknown;
    try {
      await executeUpgradeTransaction({
        preflight: async () => { events.push("preflight"); },
        stage: async () => { events.push("stage"); },
        migrate: async () => { events.push("migrate"); },
        activate: async () => { events.push("activate"); },
        restart: async () => { throw new Error("restart failed"); },
        healthCheck: async () => { events.push("health"); },
        rollback: async () => { throw new Error("rollback failed"); },
        cleanup: async () => { events.push("cleanup"); },
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(UpgradeTransactionError);
    const rollbackFailure = failure as UpgradeTransactionError;
    expect(rollbackFailure.kind).toBe("rollback-incomplete");
    expect(rollbackFailure.errors.some(candidate => String(candidate).includes("restart failed"))).toBe(true);
    expect(rollbackFailure.errors.some(candidate => String(candidate).includes("rollback failed"))).toBe(true);
    const output = formatUpgradeFailure(rollbackFailure, ["/usr/local/bin/supacloud.bak-run"]);
    expect(output).toContain("rollback is incomplete");
    expect(output).toContain("restart failed");
    expect(output).toContain("rollback failed");
    expect(output).toContain("/usr/local/bin/supacloud.bak-run");
    expect(events).toContain("cleanup");
    expect(shouldCleanupUpgradeArtifacts({
      committed: false,
      rollbackSucceeded: false,
      activationStarted: true,
    })).toBe(false);
  });

  test("reports a committed upgrade with incomplete cleanup distinctly", async () => {
    let failure: unknown;
    try {
      await executeUpgradeTransaction({
        preflight: async () => {},
        stage: async () => {},
        migrate: async () => {},
        activate: async () => {},
        restart: async () => {},
        healthCheck: async () => {},
        rollback: async () => {},
        cleanup: async () => { throw new Error("backup removal denied"); },
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UpgradeTransactionError);
    expect((failure as UpgradeTransactionError).kind).toBe("cleanup-incomplete-after-commit");
    const output = formatUpgradeFailure(failure, ["/opt/supacloud/web-console/current.bak-run"]);
    expect(output).toContain("Upgrade committed, but cleanup is incomplete");
    expect(output).toContain("backup removal denied");
    expect(output).toContain("current.bak-run");
  });

  test("preserves upgrade and cleanup diagnostics after a successful rollback", async () => {
    let failure: unknown;
    try {
      await executeUpgradeTransaction({
        preflight: async () => {},
        stage: async () => {},
        migrate: async () => {},
        activate: async () => {},
        restart: async () => { throw new Error("restart failed"); },
        healthCheck: async () => {},
        rollback: async () => {},
        cleanup: async () => { throw new Error("staged file removal denied"); },
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UpgradeTransactionError);
    expect((failure as UpgradeTransactionError).kind).toBe("cleanup-incomplete-after-failure");
    const output = formatUpgradeFailure(failure);
    expect(output).toContain("Upgrade failed and cleanup is incomplete");
    expect(output).toContain("restart failed");
    expect(output).toContain("staged file removal denied");
  });

  test("redacts secrets from nested CLI failure diagnostics", () => {
    const failure = new UpgradeTransactionError(
      "rollback-incomplete",
      [
        new Error("DATABASE_URL=postgresql://admin:database-password@localhost/supacloud"),
        new Error("API_TOKEN=raw-token"),
      ],
      "Upgrade failed and rollback did not complete",
    );

    const output = formatUpgradeFailure(failure);
    expect(output).toContain("DATABASE_URL=[REDACTED]");
    expect(output).toContain("API_TOKEN=[REDACTED]");
    expect(output).not.toContain("database-password");
    expect(output).not.toContain("raw-token");
  });

  test("rejects Web Console archives with path traversal entries", () => {
    expect(() => validateWebConsoleArchiveEntries("index.html\n../escape\n"))
      .toThrow("unsafe path");
    expect(() => validateWebConsoleArchiveEntries("./index.html\nindex.html\n"))
      .toThrow("duplicate path");
    expect(() => validateWebConsoleArchiveEntries("index.html\n_app\n_app/entry.js\n"))
      .toThrow("traverses a file");
    expect(() => validateWebConsoleArchiveEntries("index.html\n_app/\n_app\n"))
      .toThrow();
    expect(() => validateWebConsoleArchiveEntries(`index.html\n${"a/".repeat(33)}asset.js\n`))
      .toThrow("unsafe path");
    const maximumInventory = ["index.html", ...Array.from(
      { length: 9_999 },
      (_, index) => `asset-${index}.js`,
    )].join("\n");
    expect(validateWebConsoleArchiveEntries(maximumInventory).files).toHaveLength(10_000);
    expect(() => validateWebConsoleArchiveEntries(`${maximumInventory}\noverflow.js`))
      .toThrow("too many entries");
    const materializedOverflow = ["index.html", ...Array.from(
      { length: 5_000 },
      (_, index) => `directory-${index}/asset.js`,
    )].join("\n");
    expect(() => validateWebConsoleArchiveEntries(materializedOverflow))
      .toThrow("materializes too many entries");
  });

  test("rejects Web Console expanded bytes before filesystem extraction", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-web-console-expanded-")));
    const source = join(directory, "source");
    const archive = join(directory, "web-console-build.tar.gz");
    try {
      mkdirSync(source);
      writeFileSync(join(source, "index.html"), "x".repeat(64));
      expect(Bun.spawnSync(["tar", "-czf", archive, "-C", source, "."]).exitCode).toBe(0);
      await expect(verifyWebConsoleArchiveExpandedSize(archive, 32))
        .rejects.toThrow("exceeds the expanded size limit");
      await expect(verifyWebConsoleArchiveExpandedSize(archive, 64)).resolves.toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("extracts Web Console files with exact public modes under restrictive umask", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-web-console-mode-")));
    const source = join(directory, "source");
    const releases = join(directory, "releases");
    const archive = join(directory, "web-console-build.tar.gz");
    const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    mkdirSync(join(source, "_app"), { recursive: true });
    mkdirSync(releases, { mode: 0o700 });
    chmodSync(releases, 0o700);
    writeFileSync(join(source, "index.html"), "<!doctype html><title>SupaCloud</title>\n", { mode: 0o600 });
    writeFileSync(join(source, "_app", "entry.js"), "console.log('verified');\n", { mode: 0o700 });
    const packed = Bun.spawnSync(["tar", "-czf", archive, "-C", source, "."]);
    expect(packed.exitCode).toBe(0);

    const originalUmask = process.umask(0o077);
    try {
      const staged = await extractWebConsoleArchive(
        archive,
        "management-api-v0.60.1",
        { label: "test fixture", proxyPrefix: "" },
        { releasesDir: releases, owner },
      );
      expect(statSync(staged.releaseDir).mode & 0o777).toBe(0o755);
      expect(statSync(directory).mode & 0o777).toBe(0o755);
      expect(statSync(releases).mode & 0o777).toBe(0o755);
      expect(statSync(join(staged.releaseDir, "_app")).mode & 0o777).toBe(0o755);
      expect(statSync(join(staged.releaseDir, "index.html")).mode & 0o777).toBe(0o644);
      expect(statSync(join(staged.releaseDir, "_app", "entry.js")).mode & 0o777).toBe(0o644);
      expect(readFileSync(join(staged.releaseDir, "index.html"), "utf8"))
        .toBe("<!doctype html><title>SupaCloud</title>\n");
      verifyWebConsoleReleaseTree(staged.releaseDir, staged.treeSha256, owner);

      chmodSync(join(staged.releaseDir, "_app", "entry.js"), 0o600);
      expect(() => verifyWebConsoleReleaseTree(staged.releaseDir, staged.treeSha256, owner))
        .toThrow("mode is not 0644");
      chmodSync(join(staged.releaseDir, "_app", "entry.js"), 0o644);
      writeFileSync(join(staged.releaseDir, "_app", "entry.js"), "console.log('changed');\n", { mode: 0o644 });
      expect(() => verifyWebConsoleReleaseTree(staged.releaseDir, staged.treeSha256, owner))
        .toThrow("content tree changed");
      expect(() => verifyWebConsoleReleaseTree(staged.releaseDir, staged.treeSha256, {
        uid: owner.uid + 1,
        gid: owner.gid,
      })).toThrow("unsafe directory");
    } finally {
      process.umask(originalUmask);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects Web Console link entries before creating an activatable release", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-web-console-links-")));
    const source = join(directory, "source");
    const releases = join(directory, "releases");
    const archive = join(directory, "web-console-build.tar.gz");
    const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    mkdirSync(source);
    mkdirSync(releases, { mode: 0o700 });
    chmodSync(releases, 0o700);
    writeFileSync(join(source, "index.html"), "<!doctype html>\n");
    symlinkSync("index.html", join(source, "linked.html"));
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", source, "."]).exitCode).toBe(0);

    try {
      await expect(extractWebConsoleArchive(
        archive,
        "management-api-v0.60.1",
        { label: "test fixture", proxyPrefix: "" },
        { releasesDir: releases, owner },
      )).rejects.toThrow("links or special files");
      expect(readdirSync(releases)).toEqual([]);

      rmSync(join(source, "linked.html"));
      linkSync(join(source, "index.html"), join(source, "hard-linked.html"));
      expect(Bun.spawnSync(["tar", "-czf", archive, "-C", source, "."]).exitCode).toBe(0);
      await expect(extractWebConsoleArchive(
        archive,
        "management-api-v0.60.1",
        { label: "test fixture", proxyPrefix: "" },
        { releasesDir: releases, owner },
      )).rejects.toThrow("links or special files");
      expect(readdirSync(releases)).toEqual([]);

      rmSync(join(source, "hard-linked.html"));
      const fifoPath = join(source, "named-pipe");
      expect(Bun.spawnSync(["mkfifo", fifoPath]).exitCode).toBe(0);
      expect(Bun.spawnSync(["tar", "-czf", archive, "-C", source, "."]).exitCode).toBe(0);
      await expect(extractWebConsoleArchive(
        archive,
        "management-api-v0.60.1",
        { label: "test fixture", proxyPrefix: "" },
        { releasesDir: releases, owner },
      )).rejects.toThrow("links or special files");
      expect(readdirSync(releases)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("atomically activates and restores the Web Console current symlink", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-web-console-link-")));
    const current = join(directory, "current");
    const previous = join(directory, "previous");
    const target = join(directory, "target");
    const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    try {
      chmodSync(directory, 0o755);
      mkdirSync(previous);
      mkdirSync(target);
      symlinkSync(previous, current);
      const activation = prepareWebConsoleLinkActivation(current, target, owner);
      expect(readlinkSync(current)).toBe(previous);
      expect(lstatSync(activation.nextLink).isSymbolicLink()).toBe(true);
      activatePreparedWebConsoleLink(activation);
      expect(readlinkSync(current)).toBe(target);
      expect(existsSync(activation.nextLink)).toBe(false);
      restoreWebConsoleLink(activation);
      expect(readlinkSync(current)).toBe(previous);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite a drifted Web Console current target during rollback", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-web-console-link-drift-")));
    const current = join(directory, "current");
    const previous = join(directory, "previous");
    const target = join(directory, "target");
    const unexpected = join(directory, "unexpected");
    const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    try {
      chmodSync(directory, 0o755);
      for (const release of [previous, target, unexpected]) mkdirSync(release);
      symlinkSync(previous, current);
      const activation = prepareWebConsoleLinkActivation(current, target, owner);
      activatePreparedWebConsoleLink(activation);
      const replacement = join(directory, "replacement");
      symlinkSync(unexpected, replacement);
      renameSync(replacement, current);
      expect(() => restoreWebConsoleLink(activation)).toThrow("changed before rollback");
      expect(readlinkSync(current)).toBe(unexpected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps the previous Web Console target when prepared activation fails", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-web-console-link-failure-")));
    const current = join(directory, "current");
    const previous = join(directory, "previous");
    const target = join(directory, "target");
    const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    try {
      chmodSync(directory, 0o755);
      mkdirSync(previous);
      mkdirSync(target);
      symlinkSync(previous, current);
      const activation = prepareWebConsoleLinkActivation(current, target, owner);
      rmSync(activation.nextLink);

      expect(() => activatePreparedWebConsoleLink(activation)).toThrow();
      expect(readlinkSync(current)).toBe(previous);
      expect(activation.activated).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains helper evidence after internal recovery fails and outer rollback continues", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-helper-combined-recovery-")));
    const helperTarget = join(directory, "systemd-unit");
    const managementBackup = join(directory, "management.bak");
    const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const previousContent = "#!/bin/sh\nprintf previous-helper\\n\n";
    try {
      writeFileSync(helperTarget, previousContent, { mode: 0o755 });
      chmodSync(helperTarget, 0o755);
      const previous = readPrivilegedHelperIdentity(helperTarget, owner);
      const staged = stageEmbeddedSystemdUnitBroker(helperTarget, "combined", owner);
      const prepared = prepareSystemdUnitBrokerActivation({
        staged,
        targetPath: helperTarget,
        runId: "combined",
        owner,
        expectedPrevious: previous,
      });
      let activationFailure: unknown;
      try {
        activatePreparedSystemdUnitBroker(prepared, {
          syncDirectory: () => { throw new Error("directory fsync failed after rename"); },
          verifyInstalled: () => { throw new Error("verification must not run after fsync failure"); },
          restore: () => { throw new Error("internal helper restore failed"); },
        });
      } catch (error: unknown) {
        activationFailure = error;
      }

      expect(activationFailure).toBeInstanceOf(AggregateError);
      expect(prepared.state.activated).toBe(true);
      const frozenBackup = readPrivilegedHelperIdentity(
        prepared.state.backupPath,
        owner,
        previous.mode,
      );
      expect(frozenBackup.content).toEqual(previous.content);
      expect(frozenBackup.mode).toBe(previous.mode);

      writeFileSync(managementBackup, "previous-management", { mode: 0o755 });
      const activationState: UpgradeActivationState = {
        binary: {
          targetPath: join(directory, "missing-parent", "management"),
          backupPath: managementBackup,
          hadTarget: true,
          backupReady: true,
          activated: true,
        },
        edgeBinary: null,
        postgrestLauncher: null,
        systemdUnitBroker: prepared.state,
        webConsoleLink: null,
        managementEnvState: null,
        edgeRuntimeEnvState: null,
        edgeRuntimeDropInState: null,
        managementPrivilegeDropInState: null,
        embeddedEdgePrivilegeDropInState: null,
      };
      let rollbackFailure: unknown;
      try {
        await rollbackArtifacts(activationState, []);
      } catch (error: unknown) {
        rollbackFailure = error;
      }

      expect(rollbackFailure).toBeInstanceOf(AggregateError);
      expect(readFileSync(helperTarget, "utf8")).toBe(previousContent);
      expect(prepared.state.activated).toBe(false);
      const recoveryPaths = upgradeRecoveryPaths({ activation: activationState });
      expect(recoveryPaths).toContain(prepared.state.backupPath);
      const failure = new UpgradeTransactionError(
        "rollback-incomplete",
        [activationFailure, rollbackFailure],
        "Upgrade failed and rollback did not complete",
      );
      expect(formatUpgradeFailure(failure, recoveryPaths)).toContain(prepared.state.backupPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("attempts every recovery action before reporting aggregate failures", async () => {
    const attempted: string[] = [];
    await expect(executeUpgradeRecoveryActions([
      { description: "Management restore", run: () => { attempted.push("management"); throw new Error("failed"); } },
      { description: "helper restore", run: () => { attempted.push("helper"); } },
      { description: "health read-back", run: async () => { attempted.push("health"); throw new Error("unhealthy"); } },
    ])).rejects.toBeInstanceOf(AggregateError);
    expect(attempted).toEqual(["management", "helper", "health"]);
  });

  test("restores runtime env and systemd drop-in contents, permissions, and absence exactly", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-state-"));
    const runtimeEnv = join(dir, "management-api.env");
    const dropIn = join(dir, "50-edge-runtime-capacity.conf");
    const absent = join(dir, "previously-absent.conf");
    try {
      writeFileSync(runtimeEnv, "EDGE_RUNTIME_MODE=embedded\nCUSTOM=keep\n");
      chmodSync(runtimeEnv, 0o640);
      writeFileSync(dropIn, "[Service]\nEnvironment=WORKER_POOL_SIZE=3\n");
      chmodSync(dropIn, 0o644);
      const runtimeState = captureFileState(runtimeEnv);
      const dropInState = captureFileState(dropIn);
      const absentState = captureFileState(absent);

      writeFileSync(runtimeEnv, "EDGE_RUNTIME_MODE=external\n");
      chmodSync(runtimeEnv, 0o600);
      writeFileSync(dropIn, "replacement\n");
      writeFileSync(absent, "created-during-upgrade\n");

      restoreFileState(runtimeState);
      restoreFileState(dropInState);
      restoreFileState(absentState);

      expect(readFileSync(runtimeEnv, "utf8")).toBe("EDGE_RUNTIME_MODE=embedded\nCUSTOM=keep\n");
      expect(statSync(runtimeEnv).mode & 0o777).toBe(0o640);
      expect(readFileSync(dropIn, "utf8")).toBe("[Service]\nEnvironment=WORKER_POOL_SIZE=3\n");
      expect(statSync(dropIn).mode & 0o777).toBe(0o644);
      expect(existsSync(absent)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed current backup never restores a stale historical .bak file", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-backup-"));
    const target = join(dir, "supacloud");
    const historical = `${target}.bak`;
    try {
      writeFileSync(target, "current-binary");
      writeFileSync(historical, "stale-historical-binary");
      const state = createBinaryBackupState(target, "this-run");
      expect(state.backupPath).not.toBe(historical);
      expect(() => backupCurrentBinary(state, () => {
        throw new Error("copy failed");
      })).toThrow("copy failed");
      expect(state.backupReady).toBe(false);

      writeFileSync(target, "current-binary-after-failure");
      restoreCurrentBinary(state);
      expect(readFileSync(target, "utf8")).toBe("current-binary-after-failure");
      expect(readFileSync(historical, "utf8")).toBe("stale-historical-binary");
      cleanupBinaryBackup(state);
      expect(existsSync(state.backupPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a successful per-run backup restores and cleans up only its own file", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-backup-success-"));
    const target = join(dir, "supacloud");
    try {
      writeFileSync(target, "old-binary");
      const state = createBinaryBackupState(target, "successful-run");
      backupCurrentBinary(state);
      expect(state.backupReady).toBe(true);
      expect(readFileSync(state.backupPath, "utf8")).toBe("old-binary");
      writeFileSync(target, "new-binary");
      state.activated = true;
      restoreCurrentBinary(state);
      expect(readFileSync(target, "utf8")).toBe("old-binary");
      cleanupBinaryBackup(state);
      expect(existsSync(state.backupPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("atomically restores a binary while its current executable is still running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-running-binary-"));
    const target = join(dir, "supacloud");
    copyFileSync(process.execPath, target);
    chmodSync(target, 0o755);
    const state = createBinaryBackupState(target, "running-binary");
    backupCurrentBinary(state);
    chmodSync(state.backupPath, 0o600);
    const runningBinary = Bun.spawn([target, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await Bun.sleep(100);
      process.kill(runningBinary.pid, 0);
      const runningInode = statSync(target).ino;

      restoreCurrentBinary(state);

      expect(statSync(target).ino).not.toBe(runningInode);
      expect(statSync(target).mode & 0o777).toBe(0o755);
      expect(readFileSync(target)).toEqual(readFileSync(state.backupPath));
      expect(readdirSync(dir).some(name => name.includes(".restore-"))).toBe(false);
    } finally {
      runningBinary.kill();
      await runningBinary.exited;
      cleanupBinaryBackup(state);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restores both Management and Edge binaries after partial activation", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-binaries-"));
    const managementTarget = join(dir, "supacloud");
    const edgeTarget = join(dir, "supacloud-edge-runtime");
    const stagedManagement = join(dir, "staged-management");
    const stagedEdge = join(dir, "staged-edge");
    writeFileSync(managementTarget, "old-management");
    writeFileSync(edgeTarget, "old-edge");
    writeFileSync(stagedManagement, "new-management");
    writeFileSync(stagedEdge, "new-edge");
    const managementState = createBinaryBackupState(managementTarget, "transaction");
    const edgeState = createBinaryBackupState(edgeTarget, "transaction");

    try {
      activateStagedBinary(stagedManagement, managementState);
      activateStagedBinary(stagedEdge, edgeState);
      restoreCurrentBinary(managementState);
      restoreCurrentBinary(edgeState);
      expect(readFileSync(managementTarget, "utf8")).toBe("old-management");
      expect(readFileSync(edgeTarget, "utf8")).toBe("old-edge");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("post-upgrade health check validates web console root HTML", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).endsWith("/health")) {
        return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("<!DOCTYPE html><html><body>console</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as typeof fetch;

    ensureHealthTimeout();
    await expect(waitForManagementHealth()).resolves.toBeUndefined();
    expect(calls).toEqual([
      "http://127.0.0.1:9090/health",
      "http://127.0.0.1:9090/",
    ]);
  });

  test("post-upgrade health check fails when web console root is not HTML", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).endsWith("/health")) {
        return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("Asset Not Found.", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;

    ensureHealthTimeout();
    await expect(waitForManagementHealth()).rejects.toThrow("web console root check");
    expect(calls).toEqual([
      "http://127.0.0.1:9090/health",
      "http://127.0.0.1:9090/",
    ]);
  });

  test("post-upgrade health check rejects an unavailable Edge Runtime", async () => {
    ensureHealthTimeout();
    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;

    await expect(waitForEdgeRuntimeHealth()).rejects.toThrow("returned HTTP 403");
  });

  test("combined upgrade and rollback health rejects an unavailable restored Edge Runtime", async () => {
    const calls: string[] = [];
    ensureHealthTimeout();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "http://127.0.0.1:9005/health") {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(url.endsWith("/") ? "<!doctype html>" : "ok", {
        status: 200,
        headers: { "content-type": url.endsWith("/") ? "text/html" : "application/json" },
      });
    }) as typeof fetch;

    await expect(waitForUpgradeHealth()).rejects.toThrow("returned HTTP 503");
    expect(calls).toEqual([
      "http://127.0.0.1:9090/health",
      "http://127.0.0.1:9090/",
      "http://127.0.0.1:9005/health",
    ]);
  });

  test("persisted Edge Runtime mode rejects invalid upgrade state", () => {
    expect(resolvePersistedEdgeRuntimeMode(undefined)).toBe("embedded");
    expect(resolvePersistedEdgeRuntimeMode("")).toBe("embedded");
    expect(resolvePersistedEdgeRuntimeMode("embedded")).toBe("embedded");
    expect(resolvePersistedEdgeRuntimeMode("external")).toBe("external");
    expect(() => resolvePersistedEdgeRuntimeMode("externel")).toThrow("Invalid persisted EDGE_RUNTIME_MODE");
  });

  test("restarts only the service selected by the persisted Edge Runtime mode", () => {
    expect(buildRuntimeServiceRestartPlan("embedded", true)).toEqual([
      "disable-external-edge-runtime",
      "restart-management",
    ]);
    expect(buildRuntimeServiceRestartPlan("embedded", false)).toEqual(["restart-management"]);
    expect(buildRuntimeServiceRestartPlan("external", true)).toEqual([
      "restart-management",
      "restart-external-edge-runtime",
    ]);
    expect(buildRuntimeServiceRestartPlan("external", false)).toEqual(["restart-management"]);
  });

  test("upgrade persists a non-conflicting native Edge Runtime port", () => {
    const envDir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-edge-port-"));
    const managementEnv = join(envDir, "management-api.env");
    const runtimeEnv = join(envDir, "edge-runtime.env");
    try {
      writeFileSync(managementEnv, "EDGE_RUNTIME_MODE=embedded\n");

      expect(upsertPersistedEdgeRuntimePort(managementEnv, runtimeEnv)).toBe(9005);
      expect(readFileSync(managementEnv, "utf8")).toContain("EDGE_RUNTIME_PORT=9005\n");
      expect(readFileSync(managementEnv, "utf8")).toContain("EDGE_RUNTIME_INTERNAL=127.0.0.1:9005\n");
      expect(readFileSync(runtimeEnv, "utf8")).toContain("EDGE_RUNTIME_PORT=9005\n");
    } finally {
      rmSync(envDir, { recursive: true, force: true });
    }
  });

  test("upgrade preserves an explicit valid Edge Runtime port", () => {
    const envDir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-custom-edge-port-"));
    const managementEnv = join(envDir, "management-api.env");
    const runtimeEnv = join(envDir, "edge-runtime.env");
    try {
      writeFileSync(managementEnv, "EDGE_RUNTIME_PORT=9123\n");

      expect(upsertPersistedEdgeRuntimePort(managementEnv, runtimeEnv)).toBe(9123);
      expect(resolvePersistedEdgeRuntimePort(managementEnv, runtimeEnv)).toBe(9123);
      expect(readFileSync(runtimeEnv, "utf8")).toContain("EDGE_RUNTIME_PORT=9123\n");
    } finally {
      rmSync(envDir, { recursive: true, force: true });
    }
  });

  test("upgrade rejects an invalid persisted Edge Runtime port", () => {
    const envDir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-invalid-edge-port-"));
    const managementEnv = join(envDir, "management-api.env");
    const runtimeEnv = join(envDir, "edge-runtime.env");
    try {
      writeFileSync(managementEnv, "EDGE_RUNTIME_PORT=70000\n");
      expect(() => resolvePersistedEdgeRuntimePort(managementEnv, runtimeEnv))
        .toThrow("Invalid persisted EDGE_RUNTIME_PORT");
    } finally {
      rmSync(envDir, { recursive: true, force: true });
    }
  });

  test("normalizes management env WEB_CONSOLE_DIR to runtime link", () => {
    const envDir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-web-console-env-"));
    const managementEnv = join(envDir, "management-api.env");
    try {
      writeFileSync(managementEnv, "SUPACLOUD_LOG_LEVEL=debug\n");
      upsertManagementWebConsoleDir(managementEnv);
      expect(readFileSync(managementEnv, "utf8")).toContain("WEB_CONSOLE_DIR=/opt/supacloud/web-console/current\n");
    } finally {
      rmSync(envDir, { recursive: true, force: true });
    }
  });
});

describe("embedded Edge Runtime source access", () => {
  test("grants read-only source access to the dedicated runtime group", async () => {
    const commands: string[][] = [];
    const sourceDir = mkdtempSync(join(tmpdir(), "supacloud-edge-source-"));

    await ensureEmbeddedEdgeRuntimeSourceAccess(
      { user: "supacloud-edge", group: "supacloud-edge" },
      {
        platform: "linux",
        sourceDir,
        run: async (command) => {
          commands.push(command);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(commands).toEqual([
      ["chmod", "-R", "g-w,g+rX", sourceDir],
      ["chgrp", "-R", "supacloud-edge", sourceDir],
    ]);
    rmSync(sourceDir, { recursive: true, force: true });
  });

  test("fails before privilege drop when source permissions cannot be changed", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "supacloud-edge-source-"));
    await expect(ensureEmbeddedEdgeRuntimeSourceAccess(
      { user: "supacloud-edge", group: "supacloud-edge" },
      {
        platform: "linux",
        sourceDir,
        run: async () => ({ exitCode: 1, stdout: "", stderr: "permission denied" }),
      },
    )).rejects.toThrow("Failed to grant Edge Runtime source access: permission denied");
    rmSync(sourceDir, { recursive: true, force: true });
  });
});

describe("upgrade edge-runtime capacity defaults", () => {
  test("keeps privilege-drop capabilities in the canonical unit and embedded drop-in", () => {
    const managementUnit = readFileSync(
      join(import.meta.dir, "../../../..", "infrastructure/systemd/supacloud.service"),
      "utf8",
    );
    const dropIn = buildEmbeddedEdgePrivilegeDropIn();
    expect(managementUnit).toContain("NoNewPrivileges=true");
    expect(managementUnit).toContain("CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETGID CAP_SETUID");
    expect(dropIn).toContain("CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETGID CAP_SETUID");
    expect(dropIn).not.toContain("@keyring");
  });

  test("external upgrades retain Management privilege capabilities and enforce no-new-privileges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-upgrade-privilege-"));
    const managementDropIn = join(dir, "40-management-privilege.conf");
    const embeddedDropIn = join(dir, "50-embedded-edge-privilege.conf");
    let reloadCount = 0;
    try {
      writeFileSync(embeddedDropIn, "legacy embedded policy\n");
      await reconcileManagementPrivilegeDropIns("external", {
        user: "supacloud-edge",
        group: "supacloud-edge",
      }, {
        managementDropInPath: managementDropIn,
        embeddedDropInPath: embeddedDropIn,
        reloadSystemd: async () => { reloadCount += 1; },
      });

      expect(readFileSync(managementDropIn, "utf8")).toBe(buildManagementPrivilegeDropIn());
      expect(readFileSync(managementDropIn, "utf8")).toContain("NoNewPrivileges=true");
      expect(statSync(managementDropIn).mode & 0o777).toBe(0o644);
      expect(existsSync(embeddedDropIn)).toBe(false);
      expect(reloadCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sizes systemd limits to sixty percent of a two-core node", () => {
    const config = resolveEdgeRuntimeCapacityConfig({
      env: {},
      cpuCount: 2,
      totalMemoryMb: 2048,
    });

    expect(config.workerPoolSize).toBe(20);
    expect(config.backgroundWorkerPoolSize).toBe(20);
    expect(config.cpuQuotaPercent).toBe(120);
    expect(config.memoryMaxMb).toBe(1228);
    expect(config.memoryHighMb).toBe(982);
    expect(config.tasksMax).toBe(256);
  });

  test("honors explicit upgrade environment overrides", () => {
    const config = resolveEdgeRuntimeCapacityConfig({
      env: {
        SUPACLOUD_EDGE_WORKER_POOL_SIZE: "8",
        SUPACLOUD_EDGE_BACKGROUND_WORKER_POOL_SIZE: "16",
        SUPACLOUD_EDGE_CPU_QUOTA_PERCENT: "75",
        SUPACLOUD_EDGE_MEMORY_MAX_MB: "512",
        SUPACLOUD_EDGE_MEMORY_HIGH_MB: "400",
        SUPACLOUD_EDGE_TASKS_MAX: "128",
      },
      cpuCount: 2,
      totalMemoryMb: 2048,
    });

    expect(config).toEqual({
      workerPoolSize: 8,
      backgroundWorkerPoolSize: 16,
      cpuQuotaPercent: 75,
      memoryMaxMb: 512,
      memoryHighMb: 400,
      tasksMax: 128,
    });
  });

  test("writes a late systemd drop-in that overrides stale low limits", () => {
    const dropIn = buildEdgeRuntimeCapacityDropIn({
      workerPoolSize: 20,
      backgroundWorkerPoolSize: 20,
      cpuQuotaPercent: 120,
      memoryHighMb: 982,
      memoryMaxMb: 1228,
      tasksMax: 256,
    });

    expect(dropIn).toContain("Environment=WORKER_POOL_SIZE=20");
    expect(dropIn).toContain("Environment=BACKGROUND_WORKER_POOL_SIZE=20");
    expect(dropIn).toContain("CPUQuota=120%");
    expect(dropIn).toContain("MemoryHigh=982M");
    expect(dropIn).toContain("MemoryMax=1228M");
    expect(dropIn).toContain("TasksMax=256");
  });
});
