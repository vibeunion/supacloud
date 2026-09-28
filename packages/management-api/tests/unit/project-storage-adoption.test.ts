import { test, expect } from "bun:test";
import type { SQL } from "bun";
import {
  inventoryProjectObjects,
  migrateProjectObjects,
} from "../../src/services/project-storage-migration";
import { createProjectStorageRegistry, type ProjectStorageDependencies } from "../../src/services/project-storage-registry";
import {
  ProjectStorageError,
  parseProjectS3Settings,
  type ProjectStorageInventory,
} from "../../src/services/project-storage-contract";
import type { StorageDriver } from "../../src/services/storage.adapter";

type Stored = { bytes: Uint8Array; type: string; updated: string };

/** Minimal in-memory StorageDriver covering the adoption surface. */
function memoryDriver(seed: Record<string, Record<string, string>> = {}) {
  const buckets = new Map<string, Map<string, Stored>>();
  for (const [bucket, objects] of Object.entries(seed)) {
    const map = new Map<string, Stored>();
    for (const [key, value] of Object.entries(objects)) {
      map.set(key, { bytes: new TextEncoder().encode(value), type: "text/plain", updated: "2026-01-01T00:00:00.000Z" });
    }
    buckets.set(bucket, map);
  }
  const writes: string[] = [];
  const driver = {
    async createBucket(_ref: string, bucket: string) {
      if (!buckets.has(bucket)) buckets.set(bucket, new Map());
      return true;
    },
    async deleteBucket() { return { success: true as const }; },
    async emptyBucket(_ref: string, bucket: string) { buckets.set(bucket, new Map()); return true; },
    async listBuckets() {
      return [...buckets.keys()].map((id) => ({ id, name: id, public: false, size: "-" }));
    },
    async uploadFile(_ref: string, bucket: string, key: string, data: Uint8Array | ArrayBuffer | Blob | Buffer | ReadableStream, contentType: string) {
      const bytes = data instanceof Uint8Array ? data
        : data instanceof ArrayBuffer ? new Uint8Array(data)
          : new Uint8Array(await new Response(data as BodyInit).arrayBuffer());
      if (!buckets.has(bucket)) buckets.set(bucket, new Map());
      buckets.get(bucket)!.set(key, { bytes, type: contentType, updated: "2026-01-02T00:00:00.000Z" });
      writes.push(`${bucket}/${key}`);
      return true;
    },
    async copyFile(_ref: string, srcBucket: string, srcKey: string, destBucket: string, destKey: string) {
      const source = buckets.get(srcBucket)?.get(srcKey);
      if (!source) return false;
      if (!buckets.has(destBucket)) buckets.set(destBucket, new Map());
      buckets.get(destBucket)!.set(destKey, source);
      return true;
    },
    async deleteFile(_ref: string, bucket: string, key: string) { return buckets.get(bucket)?.delete(key) ?? false; },
    async listFiles(_ref: string, bucket: string) {
      return [...(buckets.get(bucket) ?? new Map()).entries()].map(([name, value]) => ({
        id: name, name, size: `${value.bytes.byteLength} B`, type: "plain", updated: value.updated,
      }));
    },
    async isBucketEmpty(_ref: string, bucket: string) { return (buckets.get(bucket)?.size ?? 0) === 0; },
    async getDownloadResponse(_ref: string, bucket: string, key: string) {
      const value = buckets.get(bucket)?.get(key);
      if (!value) return null;
      return new Response(Uint8Array.from(value.bytes), {
        headers: { "content-type": value.type, "content-length": String(value.bytes.byteLength) },
      });
    },
  };
  return { driver: driver as unknown as StorageDriver, buckets, writes };
}

function fakeDatabase(seed: { projects: string[]; stored?: Map<string, string> }) {
  const stored = seed.stored ?? new Map<string, string>();
  const projects = new Set(seed.projects);
  const query = async (strings: TemplateStringsArray, ...args: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("pg_advisory")) return [];
    if (text.includes("SELECT ref, db_name")) return projects.has(String(args[0])) ? [{ ref: args[0], db_name: `db_${args[0]}` }] : [];
    if (text.includes("SELECT value_encrypted")) return stored.has(String(args[0])) ? [{ value_encrypted: stored.get(String(args[0])) }] : [];
    if (text.includes("SELECT project_ref, value_encrypted")) {
      return [...stored].filter(([ref]) => ref !== args[2]).map(([project_ref, value_encrypted]) => ({ project_ref, value_encrypted }));
    }
    if (text.includes("INSERT INTO project_control_secrets")) { stored.set(String(args[0]), String(args[3])); return []; }
    throw new Error(`Unexpected query: ${text}`);
  };
  const database = Object.assign(query, {
    async begin<T>(callback: (transaction: SQL) => Promise<T>): Promise<T> {
      const snapshot = new Map(stored);
      try { return await callback(database as unknown as SQL); }
      catch (error) { stored.clear(); for (const [key, value] of snapshot) stored.set(key, value); throw error; }
    },
  });
  return { database: database as unknown as SQL, stored };
}

const settings = {
  endpoint: "https://s3.example.test", region: "us-east-2", bucket: "fa-assets", prefix: "",
  virtualHostedStyle: false, accessKeyId: "key", secretAccessKey: "secret", enabled: true,
};

function registryFixture(overrides: Partial<ProjectStorageDependencies> = {}) {
  const source = memoryDriver({ "fa-evidence": { "a.txt": "alpha", "b.txt": "beta" }, "fa-reports": { "r.pdf": "report" } });
  const target = memoryDriver();
  const database = fakeDatabase({ projects: ["fa"] });
  const registry = createProjectStorageRegistry({
    database: database.database,
    getProjectDb: () => database.database,
    encryptSecret: (value) => value,
    decryptSecret: (value) => value,
    allowedOrigins: () => "https://s3.example.test",
    defaultBackend: () => "local",
    createDriver: () => target.driver,
    probe: async () => ({ backend: "s3", reachable: true, listable: true, writable: "not_tested" }),
    inventory: inventoryProjectObjects,
    migrate: migrateProjectObjects,
    ...overrides,
  });
  return { registry, source, target, database };
}

test("inventory counts objects and changes its fingerprint when a source object changes", async () => {
  const source = memoryDriver({ bucket: { "a.txt": "alpha", "b.txt": "beta" } });
  const first = await inventoryProjectObjects("fa", source.driver);
  expect(first.objects).toBe(2);
  expect(first.buckets).toBe(1);
  const again = await inventoryProjectObjects("fa", source.driver);
  expect(again.fingerprint).toBe(first.fingerprint);
  source.buckets.get("bucket")!.get("a.txt")!.updated = "2030-01-01T00:00:00.000Z";
  const changed = await inventoryProjectObjects("fa", source.driver);
  expect(changed.fingerprint).not.toBe(first.fingerprint);
});

test("migrate copies and content-type-preserves every object, and fails closed on a bad copy", async () => {
  const source = memoryDriver({ bucket: { "a.txt": "alpha" } });
  const target = memoryDriver();
  await migrateProjectObjects("fa", source.driver, target.driver, await inventoryProjectObjects("fa", source.driver));
  expect([...(target.buckets.get("bucket") ?? new Map()).keys()]).toEqual(["a.txt"]);
  const copied = await target.driver.getDownloadResponse("fa", "bucket", "a.txt");
  expect(await copied!.text()).toBe("alpha");
  expect(copied!.headers.get("content-type")).toBe("text/plain");

  const bad = memoryDriver();
  const corrupt = bad.driver;
  corrupt.getDownloadResponse = async () => new Response(new TextEncoder().encode("different"), { headers: { "content-type": "text/plain" } });
  await expect(
    migrateProjectObjects("fa", source.driver, corrupt, await inventoryProjectObjects("fa", source.driver)),
  ).rejects.toThrow("STORAGE_BACKEND_UNAVAILABLE");
});

test("adopt copies existing objects, verifies them and then writes the binding", async () => {
  const { registry, target, database, source } = registryFixture();
  const result = await registry.adopt("fa", settings, null, source.driver);
  expect(result.configured).toBe(true);
  expect(result.adopted.objects).toBe(3);
  expect([...(target.buckets.get("fa-evidence") ?? new Map()).keys()].sort()).toEqual(["a.txt", "b.txt"]);
  expect(database.stored.has("fa")).toBe(true);
});

test("adopt aborts without binding when the source changes during the copy", async () => {
  const source = memoryDriver({ bucket: { "a.txt": "alpha" } });
  let mutated = false;
  const { registry, database } = registryFixture({
    migrate: async (ref, from, to, inventory) => {
      await migrateProjectObjects(ref, from, to, inventory);
      if (!mutated) { mutated = true; from.uploadFile(ref, "bucket", "late.txt", new TextEncoder().encode("late"), "text/plain"); }
    },
  });
  await expect(registry.adopt("fa", settings, null, source.driver)).rejects.toThrow("STORAGE_ADOPTION_SOURCE_CHANGED");
  expect(database.stored.has("fa")).toBe(false);
});

test("adopt requires a first binding, a disjoint namespace and a bounded inventory", async () => {
  const existing = registryFixture();
  existing.database.stored.set("fa", JSON.stringify({
    ...parseProjectS3Settings(settings), version: 1, projectRef: "fa", revision: crypto.randomUUID(),
  }));
  await expect(existing.registry.adopt("fa", settings, null, existing.source.driver)).rejects.toThrow("STORAGE_CONFIG_CONFLICT");

  const overlapping = registryFixture();
  overlapping.database.stored.set("other", JSON.stringify({
    ...parseProjectS3Settings(settings), version: 1, projectRef: "other", revision: crypto.randomUUID(),
  }));
  const held = overlapping.registry.adopt("fa", settings, null, overlapping.source.driver);
  await expect(held).rejects.toThrow("STORAGE_CONFIG_CONFLICT");

  const huge: ProjectStorageInventory = { buckets: 1, objects: 10001, fingerprint: "x", entries: [] };
  const limited = registryFixture({ inventory: async () => huge });
  await expect(limited.registry.adopt("fa", settings, null, limited.source.driver))
    .rejects.toThrow("STORAGE_ADOPTION_LIMIT");
});