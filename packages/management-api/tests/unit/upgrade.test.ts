import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildEdgeRuntimeCapacityDropIn,
    buildEmbeddedEdgePrivilegeDropIn,
    buildCheckpointDatabaseOptions,
    backupCurrentBinary,
    captureFileState,
    cleanupBinaryBackup,
    createBinaryBackupState,
    executeUpgradeTransaction,
    ensureEdgeRuntimeIdentity,
    ensureEmbeddedEdgeRuntimeSourceAccess,
    ensurePersistedEdgeRuntimeIdentity,
    normalizeManagementReleaseTag,
    prepareUpgradeSecrets,
    resolveArtifactVerificationMode,
    resolveEdgeRuntimeCapacityConfig,
    resolveGithubEndpointPrefixes,
    resolvePersistedEdgeRuntimePort,
    resolvePersistedEdgeRuntimeMode,
    resolveUpgradeEnvironment,
    runStagedDatabaseMigration,
    restoreCurrentBinary,
    restoreFileState,
    selectManagementRelease,
    stopManagementService,
    upsertManagementWebConsoleDir,
    upsertPersistedEdgeRuntimePort,
    upsertEdgeRuntimeIdentityDefaults,
    validateWebConsoleArchiveEntries,
    verifyArtifactChecksum,
    waitForManagementHealth,
    waitForEdgeRuntimeHealth,
    waitForUpgradeHealth,
} from "../../src/upgrade";

const originalFetch = globalThis.fetch;

const originalUpgradeHealthAttempts = process.env.SUPACLOUD_UPGRADE_HEALTH_ATTEMPTS;
const originalEdgeUpgradeHealthAttempts = process.env.SUPACLOUD_UPGRADE_EDGE_HEALTH_ATTEMPTS;

const ensureHealthTimeout = () => {
  process.env.SUPACLOUD_UPGRADE_HEALTH_ATTEMPTS = "1";
  process.env.SUPACLOUD_UPGRADE_EDGE_HEALTH_ATTEMPTS = "1";
};

afterEach(() => {
  globalThis.fetch = originalFetch;
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

  test("restores activated artifacts when the post-restart health check fails", async () => {
    const events: string[] = [];

    await expect(executeUpgradeTransaction({
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
      "stage",
      "migrate",
      "activate",
      "restart",
      "health",
      "rollback",
      "cleanup",
    ]);
  });

  test("rejects Web Console archives with path traversal entries", () => {
    expect(() => validateWebConsoleArchiveEntries("index.html\n../escape\n"))
      .toThrow("unsafe path");
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
  test("grants only the capabilities needed for embedded privilege drop", () => {
    const dropIn = buildEmbeddedEdgePrivilegeDropIn();
    expect(dropIn).toContain("CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETGID CAP_SETUID");
    expect(dropIn).not.toContain("@keyring");
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
