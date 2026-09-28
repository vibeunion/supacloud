import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { createProjectStorageRegistry } from "../../src/services/project-storage-registry";
import {
  PROJECT_STORAGE_SECRET,
  ProjectStorageError,
  parseProjectS3Settings,
} from "../../src/services/project-storage-contract";
import type { StorageDriver } from "../../src/services/storage.adapter";

// Real PostgreSQL coordination evidence for the project-storage registry.
// The unit fixture proves the SQL shape; this file proves that two independent
// pool connections actually serialize a first binding against in-flight legacy
// object IO through the advisory locks and never fall back after a failure.
const adminUrl = process.env.PROJECT_STORAGE_CONCURRENCY_TEST_DATABASE_URL;
const schema = `ps_concurrency_${randomUUID().replaceAll("-", "")}`;
const settingsFor = (bucket: string) => ({
  endpoint: "https://s3.example.test",
  region: "us-east-2",
  bucket,
  prefix: "",
  virtualHostedStyle: false,
  accessKeyId: "project-key",
  secretAccessKey: "project-secret",
  enabled: true,
});
const settings = settingsFor("projecta-assets");

function isUnavailable(error: unknown): boolean {
  return error instanceof ProjectStorageError && error.statusCode === 503;
}

let admin: SQL;
let database: SQL;
let hooks: {
  registry: ReturnType<typeof createProjectStorageRegistry>;
  configuredRefs: string[];
};

beforeAll(async () => {
  if (!adminUrl) return;
  admin = new SQL(adminUrl, { max: 1 });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS storage`);
  await admin.unsafe(`CREATE TABLE IF NOT EXISTS storage.buckets (id text)`);
  await admin.unsafe(`CREATE TABLE IF NOT EXISTS storage.objects (id text)`);
  await admin.unsafe(`CREATE TABLE IF NOT EXISTS storage.s3_multipart_uploads (id text)`);
  await admin.unsafe(
    `CREATE TABLE ${schema}.projects (
       ref text PRIMARY KEY,
       db_name text NOT NULL,
       status text NOT NULL,
       deleted_at timestamptz
     )`,
  );
  await admin.unsafe(
    `CREATE TABLE ${schema}.project_control_secrets (
       project_ref text NOT NULL,
       scope text NOT NULL,
       name text NOT NULL,
       value_encrypted text NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT NOW(),
       PRIMARY KEY (project_ref, scope, name)
     )`,
  );
  await admin.unsafe(`CREATE TABLE ${schema}.system_tus_uploads (ref text)`);
  await admin.unsafe(`CREATE TABLE ${schema}.system_signed_uploads (ref text)`);

  // The registry issues unqualified names, so every pooled connection must
  // resolve them inside the isolated schema instead of mutating public.
  const scopedUrl = `${adminUrl}${adminUrl.includes("?") ? "&" : "?"}options=-csearch_path%3D${schema}`;
  database = new SQL(scopedUrl, { max: 4 });

  const configuredRefs: string[] = [];
  const registry = createProjectStorageRegistry({
    database,
    getProjectDb: () => database,
    encryptSecret: (value) => value,
    decryptSecret: (value) => value,
    allowedOrigins: () => "https://s3.example.test",
    defaultBackend: () => "legacy",
    createDriver: (configuration) => {
      configuredRefs.push(configuration.projectRef);
      return { tag: "configured" } as unknown as StorageDriver;
    },
    probe: async () => ({ backend: "s3", reachable: true, listable: true, writable: "not_tested" }),
  });
  hooks = { registry, configuredRefs };

  await database`INSERT INTO projects (ref, db_name, status, deleted_at) VALUES ('projecta', 'db_a', 'active', NULL)`;
});

afterAll(async () => {
  if (database) await database.close({ timeout: 1 });
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.close({ timeout: 1 });
  }
});

const timeout = 15_000;

test.skipIf(!adminUrl)(
  "a first binding waits for in-flight legacy IO and later operations use the configured backend",
  async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let legacyCalls = 0;

    const legacy = { tag: "legacy" } as unknown as StorageDriver;
    const legacyOperation = hooks.registry.withDriver("projecta", legacy, async () => {
      legacyCalls += 1;
      signalStarted();
      await gate;
      return "legacy";
    });
    await started;

    const binding = hooks.registry.put("projecta", settings, null);
    // The binding must block on the exclusive advisory lock while the legacy
    // operation holds the shared lock inside its still-open transaction.
    const observed = await Promise.race([
      binding.then(() => "settled" as const),
      Bun.sleep(400).then(() => "blocked" as const),
    ]);
    expect(observed).toBe("blocked");

    release();
    expect(await legacyOperation).toBe("legacy");
    const bound = await binding;
    expect(bound.configured).toBe(true);

    // A subsequent operation must resolve the configured driver; the fallback
    // (legacy) driver may never be used once a binding exists.
    let resolved: StorageDriver | undefined;
    await hooks.registry.withDriver("projecta", legacy, async (driver) => { resolved = driver; });
    expect(legacyCalls).toBe(1);
    expect((resolved as unknown as { tag: string }).tag).toBe("configured");
  },
  timeout,
);

test.skipIf(!adminUrl)(
  "an operation that starts after the binding uses the configured backend without waiting",
  async () => {
    const before = hooks.configuredRefs.length;
    let resolved: StorageDriver | undefined;
    const value = await hooks.registry.withDriver("projecta", { tag: "legacy" } as unknown as StorageDriver, async (driver) => {
      resolved = driver;
      return "configured";
    });
    expect(value).toBe("configured");
    expect((resolved as unknown as { tag: string }).tag).toBe("configured");
    expect(hooks.configuredRefs.length).toBe(before + 1);
  },
  timeout,
);

test.skipIf(!adminUrl)(
  "concurrent first bindings on separate connections have a single winner",
  async () => {
    await database`INSERT INTO projects (ref, db_name, status, deleted_at) VALUES ('projectc', 'db_c', 'active', NULL)`;
    const first = hooks.registry.put("projectc", settingsFor("projectc-assets"), null);
    const second = hooks.registry.put("projectc", settingsFor("projectc-assets"), null);
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const failure = rejected[0] as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(ProjectStorageError);
    expect((failure.reason as ProjectStorageError).statusCode).toBe(409);
  },
  timeout,
);

test.skipIf(!adminUrl)(
  "a corrupt binding fails closed without ever invoking the legacy fallback",
  async () => {
    await database`INSERT INTO projects (ref, db_name, status, deleted_at) VALUES ('projectb', 'db_b', 'active', NULL)`;
    await database`
      INSERT INTO project_control_secrets (project_ref, scope, name, value_encrypted)
      VALUES ('projectb', ${PROJECT_STORAGE_SECRET.scope}, ${PROJECT_STORAGE_SECRET.name}, 'not-valid-json')
    `;
    let fallbackCalls = 0;
    let failure: unknown;
    try {
      await hooks.registry.withDriver("projectb", {} as StorageDriver, async () => {
        fallbackCalls += 1;
        return "legacy";
      });
    } catch (error) {
      failure = error;
    }
    expect(isUnavailable(failure)).toBe(true);
    expect(fallbackCalls).toBe(0);
  },
  timeout,
);

test.skipIf(!adminUrl)(
  "a corrupt binding of another project does not brick unrelated first bindings",
  async () => {
    // projectb already holds an unreadable binding from the previous test. A
    // fresh project must still be bindable; overlap scanning may not fail the
    // whole operation because one unrelated project row is corrupt.
    await database`INSERT INTO projects (ref, db_name, status, deleted_at) VALUES ('projectd', 'db_d', 'active', NULL)`;
    const bound = await hooks.registry.put("projectd", settingsFor("projectd-assets"), null);
    expect(bound.configured).toBe(true);
  },
  timeout,
);

test.skipIf(!adminUrl)("documents the accepted normalization used by the binding helper", () => {
  expect(parseProjectS3Settings(settings).endpoint).toBe("https://s3.example.test");
});