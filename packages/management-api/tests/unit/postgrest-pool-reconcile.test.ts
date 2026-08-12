import { describe, expect, mock, test } from "bun:test";
import {
  PostgrestPoolMigrationGate,
  PostgrestPoolReconcileError,
  reconcileManagedPostgrestPool,
  renderManagedPostgrestDbPool,
  type PostgrestPoolGeneration,
  type PostgrestPoolReconcileOperations,
} from "../../src/services/postgrest-pool-reconcile";
import {
  canonicalPostgrestConfig,
  postgrestConfigRevision,
  revisionHex,
} from "../../src/services/runtime-revision";

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

function generation(content: string): PostgrestPoolGeneration {
  const canonicalContent = canonicalPostgrestConfig(content);
  const revision = postgrestConfigRevision(PROJECT_REF, canonicalContent);
  return {
    content: canonicalContent,
    pointerTarget: `${PROJECT_REF}_postgrest.d/${revisionHex(revision)}.conf`,
    revision,
  };
}

function generationHarness(initialContent = MANAGED_CONFIG) {
  let current = generation(initialContent);
  const knownGenerations = new Map([[current.pointerTarget, current]]);
  const restartAndAttest = mock(async (_revision: string) => {});
  const restorePointer = mock(async (previous: PostgrestPoolGeneration) => {
    current = previous;
  });
  const operations: PostgrestPoolReconcileOperations = {
    readCurrentGeneration: async () => current,
    candidateGeneration: (content) => generation(content),
    activateCandidate: async (content, expectedPreviousPointerTarget) => {
      if (current.pointerTarget !== expectedPreviousPointerTarget) {
        throw new Error("pointer changed before activation");
      }
      current = generation(content);
      knownGenerations.set(current.pointerTarget, current);
      return current;
    },
    currentPointerTarget: async () => current.pointerTarget,
    validateGeneration: async (candidate) => {
      if (knownGenerations.get(candidate.pointerTarget)?.revision !== candidate.revision) {
        throw new Error("generation is unavailable");
      }
    },
    restorePointer,
    restartAndAttest,
  };
  return {
    current: () => current,
    installConcurrentGeneration(content: string) {
      current = generation(content);
      knownGenerations.set(current.pointerTarget, current);
    },
    operations,
    restartAndAttest,
    restorePointer,
  };
}

function request(
  operations: PostgrestPoolReconcileOperations,
  overrides: Partial<{
    projectRef: string;
    desiredPool: number;
    projectStatus: string;
    desiredState: "running" | "stopped";
  }> = {},
) {
  return {
    projectRef: overrides.projectRef ?? PROJECT_REF,
    desiredPool: overrides.desiredPool ?? 3,
    projectStatus: overrides.projectStatus ?? "active",
    desiredState: overrides.desiredState ?? "running",
    operations,
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
  test("activates an immutable candidate and remains idempotent", async () => {
    const harness = generationHarness(LEGACY_CONFIG);

    expect(await reconcileManagedPostgrestPool(request(harness.operations)))
      .toEqual({ state: "updated" });
    expect(harness.current().content)
      .toBe(canonicalPostgrestConfig(LEGACY_CONFIG.replace("db-pool = 10", "db-pool = 3")));
    expect(harness.current().pointerTarget).toMatch(
      new RegExp(`^${PROJECT_REF}_postgrest\\.d/[a-f0-9]{64}\\.conf$`),
    );
    expect(await reconcileManagedPostgrestPool(request(harness.operations)))
      .toEqual({ state: "unchanged" });
    expect(harness.restartAndAttest).toHaveBeenCalledTimes(1);
  });

  test("restores and attests the previous generation after candidate failure", async () => {
    const harness = generationHarness();
    const original = harness.current();
    const candidateError = new Error("candidate unhealthy");
    harness.restartAndAttest.mockRejectedValueOnce(candidateError);

    expect(await reconcileManagedPostgrestPool(request(harness.operations)))
      .toEqual({
        state: "rolled_back",
        error: "POSTGREST_POOL_UPDATE_ROLLED_BACK",
        cause: candidateError,
      });
    expect(harness.current()).toEqual(original);
    expect(harness.restorePointer).toHaveBeenCalledWith(original);
    expect(harness.restartAndAttest).toHaveBeenNthCalledWith(1, expect.not.stringMatching(original.revision));
    expect(harness.restartAndAttest).toHaveBeenNthCalledWith(2, original.revision);
  });

  test("preserves both candidate and rollback causes", async () => {
    const harness = generationHarness();
    const candidateError = new Error("candidate unhealthy");
    const rollbackError = new Error("rollback unhealthy");
    harness.restartAndAttest
      .mockRejectedValueOnce(candidateError)
      .mockRejectedValueOnce(rollbackError);

    const failure = await reconcileManagedPostgrestPool(request(harness.operations))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PostgrestPoolReconcileError);
    expect((failure as PostgrestPoolReconcileError).errors).toEqual([
      candidateError,
      rollbackError,
    ]);
  });

  test("does not roll back over a concurrently activated generation", async () => {
    const harness = generationHarness();
    const concurrentContent = MANAGED_CONFIG.replace(
      "log-level = \"warn\"",
      "log-level = \"info\"",
    );
    harness.restartAndAttest.mockImplementationOnce(async () => {
      harness.installConcurrentGeneration(concurrentContent);
      throw new Error("restart failed");
    });

    await expect(
      reconcileManagedPostgrestPool(request(harness.operations)),
    ).rejects.toBeInstanceOf(PostgrestPoolReconcileError);
    expect(harness.current().content).toBe(concurrentContent);
    expect(harness.restorePointer).not.toHaveBeenCalled();
    expect(harness.restartAndAttest).toHaveBeenCalledTimes(1);
  });

  test("skips stopped projects without consulting generation state", async () => {
    const harness = generationHarness();
    const readCurrentGeneration = mock(async () => harness.current());
    harness.operations.readCurrentGeneration = readCurrentGeneration;

    expect(await reconcileManagedPostgrestPool(request(harness.operations, {
      desiredState: "stopped",
    }))).toEqual({ state: "skipped" });
    expect(readCurrentGeneration).not.toHaveBeenCalled();
    expect(harness.restartAndAttest).not.toHaveBeenCalled();
  });

  test("leaves matching, unmanaged, and malformed generations untouched", async () => {
    const matching = generationHarness(MANAGED_CONFIG);
    expect(await reconcileManagedPostgrestPool(request(matching.operations, { desiredPool: 10 })))
      .toEqual({ state: "unchanged" });
    expect(matching.restartAndAttest).not.toHaveBeenCalled();

    const unmanaged = generationHarness("db-pool = 10\n");
    expect(await reconcileManagedPostgrestPool(request(unmanaged.operations)))
      .toEqual({ state: "unchanged" });
    expect(unmanaged.restartAndAttest).not.toHaveBeenCalled();

    const malformed = generationHarness(`${MANAGED_CONFIG}db-pool = 4\n`);
    await expect(reconcileManagedPostgrestPool(request(malformed.operations)))
      .rejects.toThrow("exactly one db-pool setting");
    expect(malformed.restartAndAttest).not.toHaveBeenCalled();
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
