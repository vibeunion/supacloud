import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildEdgeRuntimeCapacityDropIn,
    backupCurrentBinary,
    captureFileState,
    cleanupBinaryBackup,
    createBinaryBackupState,
    executeUpgradeTransaction,
    normalizeManagementReleaseTag,
    resolveArtifactVerificationMode,
    resolveUpgradeEnvironment,
    resolveGithubEndpointPrefixes,
    resolveEdgeRuntimeCapacityConfig,
    restoreFileState,
    restoreCurrentBinary,
    selectManagementRelease,
    validateWebConsoleArchiveEntries,
    verifyArtifactChecksum,
} from "../../src/upgrade";

describe("upgrade release selection", () => {
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
});

describe("upgrade edge-runtime capacity defaults", () => {
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
