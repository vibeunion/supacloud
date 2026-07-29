import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PostgrestPoolReconcileError,
  reconcileManagedPostgrestPool,
  renderManagedPostgrestDbPool,
} from "../../src/services/postgrest-pool-reconcile";

const temporaryDirectories: string[] = [];
const MANAGED_CONFIG = [
  "# Managed by SupaCloud Management API. Legacy shell tooling must not overwrite this file.",
  "db-uri = \"postgres://secret@example.invalid/database\"",
  "db-pool = 10",
  "log-level = \"warn\"",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function temporaryConfig(content = MANAGED_CONFIG): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "supacloud-postgrest-pool-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "tenant.conf");
  await writeFile(configPath, content, { mode: 0o640 });
  await chmod(configPath, 0o640);
  return configPath;
}

function request(
  configPath: string,
  restartAndWait: () => Promise<void>,
  overrides: Partial<{
    desiredPool: number;
    projectStatus: string;
    desiredState: "running" | "stopped";
  }> = {},
) {
  return {
    configPath,
    desiredPool: overrides.desiredPool ?? 3,
    projectStatus: overrides.projectStatus ?? "active",
    desiredState: overrides.desiredState ?? "running",
    restartAndWait,
  };
}

describe("managed PostgREST pool rendering", () => {
  test("changes only the managed db-pool line", () => {
    const candidate = renderManagedPostgrestDbPool(MANAGED_CONFIG, 3);

    expect(candidate).toBe(MANAGED_CONFIG.replace("db-pool = 10", "db-pool = 3"));
    expect(candidate).toContain("postgres://secret@example.invalid/database");
  });

  test("does not rewrite unmanaged, matching, or malformed config", () => {
    expect(renderManagedPostgrestDbPool(MANAGED_CONFIG, 10)).toBeNull();
    expect(renderManagedPostgrestDbPool("db-pool = 10\n", 3)).toBeNull();
    expect(() => renderManagedPostgrestDbPool(
      `${MANAGED_CONFIG}db-pool = 4\n`,
      3,
    )).toThrow("exactly one db-pool setting");
  });
});

describe("managed PostgREST pool reconciliation", () => {
  test("updates, health-checks, preserves metadata, and becomes idempotent", async () => {
    const configPath = await temporaryConfig();
    const before = await stat(configPath);
    const restartAndWait = mock(async () => {});

    const first = await reconcileManagedPostgrestPool(
      request(configPath, restartAndWait),
    );
    const after = await stat(configPath);

    expect(first).toEqual({ state: "updated" });
    expect(await readFile(configPath, "utf8")).toContain("db-pool = 3");
    expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(restartAndWait).toHaveBeenCalledTimes(1);

    const second = await reconcileManagedPostgrestPool(
      request(configPath, restartAndWait),
    );
    expect(second).toEqual({ state: "unchanged" });
    expect(restartAndWait).toHaveBeenCalledTimes(1);
  });

  test("honors an explicit pool override without restarting", async () => {
    const configPath = await temporaryConfig();
    const restartAndWait = mock(async () => {});

    const result = await reconcileManagedPostgrestPool(
      request(configPath, restartAndWait, { desiredPool: 10 }),
    );

    expect(result).toEqual({ state: "unchanged" });
    expect(restartAndWait).not.toHaveBeenCalled();
  });

  test("does not read or start a stopped project", async () => {
    const restartAndWait = mock(async () => {});
    const result = await reconcileManagedPostgrestPool(
      request("/path/does/not/exist", restartAndWait, {
        desiredState: "stopped",
      }),
    );

    expect(result).toEqual({ state: "skipped" });
    expect(restartAndWait).not.toHaveBeenCalled();
  });

  test("restores the exact previous config after candidate health failure", async () => {
    const configPath = await temporaryConfig();
    const before = await stat(configPath);
    const restartAndWait = mock(async () => {});
    restartAndWait.mockRejectedValueOnce(new Error("candidate unhealthy"));

    const result = await reconcileManagedPostgrestPool(
      request(configPath, restartAndWait),
    );
    const after = await stat(configPath);

    expect(result).toEqual({
      state: "rolled_back",
      error: "POSTGREST_POOL_UPDATE_ROLLED_BACK",
      cause: expect.any(Error),
    });
    expect(await readFile(configPath, "utf8")).toBe(MANAGED_CONFIG);
    expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(restartAndWait).toHaveBeenCalledTimes(2);

    const retry = await reconcileManagedPostgrestPool(
      request(configPath, restartAndWait),
    );
    expect(retry).toEqual({ state: "updated" });
    expect(restartAndWait).toHaveBeenCalledTimes(3);
  });

  test("fails explicitly when the restored runtime is still unhealthy", async () => {
    const configPath = await temporaryConfig();
    const restartAndWait = mock(async () => {
      throw new Error("unhealthy");
    });

    await expect(
      reconcileManagedPostgrestPool(request(configPath, restartAndWait)),
    ).rejects.toBeInstanceOf(PostgrestPoolReconcileError);
    expect(await readFile(configPath, "utf8")).toBe(MANAGED_CONFIG);
    expect(restartAndWait).toHaveBeenCalledTimes(2);
  });

  test("does not modify unmanaged or malformed managed files", async () => {
    const unmanaged = "db-pool = 10\n";
    const unmanagedPath = await temporaryConfig(unmanaged);
    const unmanagedRestart = mock(async () => {});
    expect(await reconcileManagedPostgrestPool(
      request(unmanagedPath, unmanagedRestart),
    )).toEqual({ state: "unchanged" });
    expect(await readFile(unmanagedPath, "utf8")).toBe(unmanaged);
    expect(unmanagedRestart).not.toHaveBeenCalled();

    const malformed = `${MANAGED_CONFIG}db-pool = 4\n`;
    const malformedPath = await temporaryConfig(malformed);
    const malformedRestart = mock(async () => {});
    await expect(
      reconcileManagedPostgrestPool(request(malformedPath, malformedRestart)),
    ).rejects.toThrow("exactly one db-pool setting");
    expect(await readFile(malformedPath, "utf8")).toBe(malformed);
    expect(malformedRestart).not.toHaveBeenCalled();

    const missingPoolPath = await temporaryConfig(
      MANAGED_CONFIG.replace("db-pool = 10\n", ""),
    );
    const missingPoolRestart = mock(async () => {});
    await expect(
      reconcileManagedPostgrestPool(request(missingPoolPath, missingPoolRestart)),
    ).rejects.toThrow("exactly one db-pool setting");
    expect(missingPoolRestart).not.toHaveBeenCalled();
  });

  test("preserves both candidate and rollback causes", async () => {
    const configPath = await temporaryConfig();
    const candidateError = new Error("candidate unhealthy");
    const rollbackError = new Error("rollback unhealthy");
    const restartAndWait = mock(async () => {
      throw restartAndWait.mock.calls.length === 1 ? candidateError : rollbackError;
    });

    const failure = await reconcileManagedPostgrestPool(request(configPath, restartAndWait))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PostgrestPoolReconcileError);
    expect((failure as PostgrestPoolReconcileError).errors).toEqual([
      candidateError,
      rollbackError,
    ]);
  });
});
