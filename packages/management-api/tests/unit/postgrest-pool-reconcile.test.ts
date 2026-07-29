import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PostgrestPoolMigrationGate,
  PostgrestPoolReconcileError,
  reconcileManagedPostgrestPool,
  renderManagedPostgrestDbPool,
} from "../../src/services/postgrest-pool-reconcile";

const temporaryDirectories: string[] = [];
const PROJECT_REF = "afemibrarjkvzuuawjfi";
const MANAGED_CONFIG = [
  "# Managed by SupaCloud Management API. Legacy shell tooling must not overwrite this file.",
  "db-uri = \"postgres://secret@example.invalid/database\"",
  "db-pool = 10",
  "log-level = \"warn\"",
  "",
].join("\n");
const LEGACY_CONFIG = [
  `# PostgREST config for tenant: ${PROJECT_REF}`,
  "db-uri = \"postgres://authenticator:secret@example.invalid/database\"",
  "db-schemas = \"public, storage, graphql_public\"",
  "db-extra-search-path = \"public, extensions, auth\"",
  "db-anon-role = \"anon\"",
  "jwt-secret = \"sensitive-jwt-secret\"",
  "",
  "server-port = 54321",
  "server-host = \"0.0.0.0\"",
  "db-pool = 10",
  "db-pool-acquisition-timeout = 10",
  "log-level = \"warn\"",
  "",
  "# P0-10: OpenAPI spec generation (required by Studio Table Editor & API Docs)",
  "openapi-mode = \"follow-privileges\"",
  "openapi-server-proxy-uri = \"https://api.example.invalid/rest/v1\"",
  "",
  "# P0-11: Pre-request function for RLS context injection",
  "db-pre-request = \"public.set_request_context\"",
  "",
  "# P1-7: Row limit protection",
  "db-max-rows = 1000",
  "",
  "# P2-3: Restrict CORS to the tenant's API domain",
  "server-cors-allowed-origins = \"https://api.example.invalid\"",
  "",
  "# P2-4: Tenant-specific listen channel for schema cache invalidation",
  `db-channel = \"pgrst_${PROJECT_REF}\"`,
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
    projectRef: string;
    desiredPool: number;
    projectStatus: string;
    desiredState: "running" | "stopped";
  }> = {},
) {
  return {
    configPath,
    projectRef: overrides.projectRef ?? PROJECT_REF,
    desiredPool: overrides.desiredPool ?? 3,
    projectStatus: overrides.projectStatus ?? "active",
    desiredState: overrides.desiredState ?? "running",
    restartAndWait,
  };
}

describe("managed PostgREST pool rendering", () => {
  test("changes only the managed db-pool line", () => {
    const candidate = renderManagedPostgrestDbPool(MANAGED_CONFIG, 3, PROJECT_REF);

    expect(candidate).toBe(MANAGED_CONFIG.replace("db-pool = 10", "db-pool = 3"));
    expect(candidate).toContain("postgres://secret@example.invalid/database");
  });

  test("does not rewrite unmanaged, matching, or malformed config", () => {
    expect(renderManagedPostgrestDbPool(MANAGED_CONFIG, 10, PROJECT_REF)).toBeNull();
    expect(renderManagedPostgrestDbPool("db-pool = 10\n", 3, PROJECT_REF)).toBeNull();
    expect(() => renderManagedPostgrestDbPool(
      `${MANAGED_CONFIG}db-pool = 4\n`,
      3,
      PROJECT_REF,
    )).toThrow("exactly one db-pool setting");
  });

  test("changes only the canonical legacy db-pool bytes", () => {
    const candidate = renderManagedPostgrestDbPool(LEGACY_CONFIG, 3, PROJECT_REF);

    expect(candidate).toBe(LEGACY_CONFIG.replace("db-pool = 10", "db-pool = 3"));
    expect(candidate).toContain("authenticator:secret@example.invalid");
    expect(candidate).toContain("sensitive-jwt-secret");
    expect(candidate).toContain("P0-10: OpenAPI spec generation");
  });

  test("accepts the optional canonical jwt-aud setting", () => {
    const withAudience = LEGACY_CONFIG.replace(
      'jwt-secret = "sensitive-jwt-secret"',
      'jwt-secret = "sensitive-jwt-secret"\njwt-aud = "authenticated"',
    );

    expect(renderManagedPostgrestDbPool(withAudience, 3, PROJECT_REF))
      .toBe(withAudience.replace("db-pool = 10", "db-pool = 3"));
  });

  test("skips non-canonical legacy ownership candidates without throwing", () => {
    const candidates = [
      LEGACY_CONFIG.replace(PROJECT_REF, "wrong-project-ref"),
      LEGACY_CONFIG.replace("db-max-rows = 1000\n", ""),
      `${LEGACY_CONFIG}\ncustom-setting = \"user-owned\"`,
      `${LEGACY_CONFIG}\ndb-pool = 4`,
      LEGACY_CONFIG.replace(`pgrst_${PROJECT_REF}`, "pgrst_wrong-project-ref"),
      LEGACY_CONFIG.replace('log-level = "warn"', 'log-level = "info"'),
      LEGACY_CONFIG.replace('jwt-secret = "sensitive-jwt-secret"', "jwt-secret = unquoted"),
      LEGACY_CONFIG.replace('db-schemas = "public, storage, graphql_public"', 'db-schemas = ""'),
      LEGACY_CONFIG.replace("server-port = 54321", "server-port = 054321"),
      LEGACY_CONFIG.replace("server-port = 54321", "server-port = 65536"),
      LEGACY_CONFIG.replace("db-pool = 10", "db-pool = 9007199254740992"),
      LEGACY_CONFIG.replace(
        'db-pool = 10',
        'db-pool = 10\njwt-aud = "authenticated"\njwt-aud = "other"',
      ),
      `# PostgREST config for tenant: ${PROJECT_REF}\ndb-pool = 10\n`,
    ];

    for (const candidate of candidates) {
      expect(renderManagedPostgrestDbPool(candidate, 3, PROJECT_REF)).toBeNull();
    }
  });

  test("preserves reordered comments, CRLF, and missing final newline", () => {
    const movedPool = LEGACY_CONFIG
      .replace("\ndb-pool = 10\n", "\n")
      + "\n# User comment\ndb-pool = 10 # operator note";
    const crlf = movedPool.replaceAll("\n", "\r\n");

    expect(renderManagedPostgrestDbPool(crlf, 3, PROJECT_REF))
      .toBe(crlf.replace("db-pool = 10", "db-pool = 3"));
    expect(renderManagedPostgrestDbPool(movedPool, 3, PROJECT_REF))
      .toBe(movedPool.replace("db-pool = 10", "db-pool = 3"));
  });

  test("distinguishes inline comments from hashes inside quoted values", () => {
    const commented = LEGACY_CONFIG
      .replace('jwt-secret = "sensitive-jwt-secret"', 'jwt-secret = "sensitive#jwt-secret" # secret note')
      .replace("db-pool = 10", "db-pool = 10 # pool note");

    expect(renderManagedPostgrestDbPool(commented, 3, PROJECT_REF))
      .toBe(commented.replace("db-pool = 10", "db-pool = 3"));
  });
});

describe("managed PostgREST pool reconciliation", () => {
  test("reconciles canonical legacy config once and remains idempotent", async () => {
    const configPath = await temporaryConfig(LEGACY_CONFIG);
    const restartAndWait = mock(async () => {});

    expect(await reconcileManagedPostgrestPool(request(configPath, restartAndWait)))
      .toEqual({ state: "updated" });
    expect(await readFile(configPath, "utf8"))
      .toBe(LEGACY_CONFIG.replace("db-pool = 10", "db-pool = 3"));
    expect(await reconcileManagedPostgrestPool(request(configPath, restartAndWait)))
      .toEqual({ state: "unchanged" });
    expect(restartAndWait).toHaveBeenCalledTimes(1);
  });

  test("restores the exact canonical legacy config after health failure", async () => {
    const configPath = await temporaryConfig(LEGACY_CONFIG);
    const restartAndWait = mock(async () => {});
    restartAndWait.mockRejectedValueOnce(new Error("candidate unhealthy"));

    expect(await reconcileManagedPostgrestPool(request(configPath, restartAndWait)))
      .toEqual({
        state: "rolled_back",
        error: "POSTGREST_POOL_UPDATE_ROLLED_BACK",
        cause: expect.any(Error),
      });
    expect(await readFile(configPath, "utf8")).toBe(LEGACY_CONFIG);
    expect(restartAndWait).toHaveBeenCalledTimes(2);
  });

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

  test("does not roll back over a concurrently regenerated config", async () => {
    const configPath = await temporaryConfig();
    const regeneratedConfig = MANAGED_CONFIG.replace(
      "log-level = \"warn\"",
      "log-level = \"info\"",
    );
    const restartAndWait = mock(async () => {
      await writeFile(configPath, regeneratedConfig);
      throw new Error("restart failed");
    });

    await expect(
      reconcileManagedPostgrestPool(request(configPath, restartAndWait)),
    ).rejects.toBeInstanceOf(PostgrestPoolReconcileError);
    expect(await readFile(configPath, "utf8")).toBe(regeneratedConfig);
    expect(restartAndWait).toHaveBeenCalledTimes(1);
  });
});

describe("PostgREST pool migration circuit breaker", () => {
  test("stops the current multi-tenant sweep and backs off the failed pool version", () => {
    let now = 1_000;
    const gate = new PostgrestPoolMigrationGate(10_000, () => now);
    const restartedRefs: string[] = [];

    gate.beginSweep(3);
    for (const ref of ["tenant-a", "tenant-b", "tenant-c"]) {
      if (!gate.canAttempt()) continue;
      restartedRefs.push(ref);
      gate.recordFailure(3);
    }
    expect(restartedRefs).toEqual(["tenant-a"]);

    expect(gate.beginSweep(3)).toBe(false);
    now += 10_000;
    expect(gate.beginSweep(3)).toBe(true);
    gate.recordFailure(3);
    expect(gate.beginSweep(4)).toBe(true);
  });
});
