import { test } from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "bun";
import type { StorageDriver } from "../../src/services/storage.adapter";
import { createProjectStorageInventory } from "../../src/services/project-storage-inventory";
import { inventoryProjectObjects, migrateProjectObjects } from "../../src/services/project-storage-migration";
import { ProjectStorageError, PROJECT_STORAGE_ADOPTION_MAX_OBJECTS } from "../../src/services/project-storage-contract";

function fixture(count = 1001) {
  const state = {
    buckets: [{ id: "files" }, { id: "empty" }],
    objects: Array.from({ length: count }, (_, i) => ({ bucket_id: "files", name: `nested/${i}.txt` })),
    pending: false, multipart: false, databaseFailure: false, missing: false,
    reads: [] as string[], listCalls: 0, limit: 0,
  };
  const database = (async (strings: TemplateStringsArray, ...args: unknown[]) => {
    const query = strings.join("?");
    if (state.databaseFailure) throw new Error("internal-secret-do-not-leak");
    if (query.includes("SELECT db_name")) { assert.equal(args[0], "projecta"); return [{ db_name: "tenant_a" }]; }
    if (query.includes("system_tus_uploads")) return [{ occupied: state.pending }];
    if (query.includes("storage.s3_multipart_uploads")) return [{ occupied: state.multipart }];
    if (query.includes("FROM storage.buckets")) return state.buckets;
    if (query.includes("FROM storage.objects")) { state.limit = Number(args[0]); return state.objects.slice(0, state.limit); }
    throw new Error(`Unexpected query: ${query}`);
  }) as unknown as SQL;
  const inventory = createProjectStorageInventory({ database, getProjectDb(name) { assert.equal(name, "tenant_a"); return database; } });
  const source = {
    async listBuckets() { state.listCalls++; return [{ id: "files", name: "files", public: false, size: "-" }]; },
    async listFiles() { state.listCalls++; return state.objects.slice(0, 1000).map((object) => ({ id: object.name, name: object.name, size: "1", type: "txt" })); },
    async getDownloadResponse(ref: string, bucket: string, key: string) {
      assert.equal(ref, "projecta"); assert.equal(bucket, "files"); state.reads.push(key);
      return state.missing ? null : new Response(key, { headers: { "content-type": "text/plain" } });
    },
  } as unknown as StorageDriver;
  return { state, source, inventory };
}

const errorCode = (code: string) => (error: unknown) => error instanceof ProjectStorageError && error.code === code;

test("authoritative inventory includes objects beyond a truncated S3 page and empty buckets", async () => {
  const { state, source, inventory } = fixture();
  const truncated = await inventoryProjectObjects("projecta", source);
  assert.equal(truncated.objects, 1000); // Reproduces the previous adoption omission.
  state.reads.length = 0; state.listCalls = 0;
  const complete = await inventory("projecta", source);
  assert.equal(complete.objects, 1001); assert.equal(complete.buckets, 2);
  assert.equal(state.listCalls, 0); assert.equal(state.reads.length, 1001);
  assert.ok(complete.entries.some((entry) => entry.key === "nested/1000.txt"));
  assert.equal(state.limit, PROJECT_STORAGE_ADOPTION_MAX_OBJECTS + 1);
  const copied: string[] = [];
  const target = {
    async uploadFile(_ref: string, _bucket: string, key: string) { copied.push(key); return true; },
    getDownloadResponse: source.getDownloadResponse,
  } as unknown as StorageDriver;
  await migrateProjectObjects("projecta", source, target, complete);
  assert.equal(copied.length, 1001); assert.ok(copied.includes("nested/1000.txt"));
});

test("driver listing errors cannot masquerade as an empty adoption inventory", async () => {
  const { source, inventory } = fixture(2);
  source.listBuckets = async () => []; source.listFiles = async () => [];
  assert.equal((await inventory("projecta", source)).objects, 2);
});

test("metadata lookup failures are sanitized and do not read source objects", async () => {
  const { state, source, inventory } = fixture(1); state.databaseFailure = true;
  await assert.rejects(inventory("projecta", source), errorCode("STORAGE_BACKEND_UNAVAILABLE"));
  assert.deepEqual(state.reads, []);
});

test("missing source objects abort instead of accepting a partial inventory", async () => {
  const { state, source, inventory } = fixture(2); state.missing = true;
  await assert.rejects(inventory("projecta", source), errorCode("STORAGE_BACKEND_UNAVAILABLE"));
});

test("pending resumable or multipart uploads block adoption before source IO", async () => {
  for (const flag of ["pending", "multipart"] as const) {
    const { state, source, inventory } = fixture(1); state[flag] = true;
    await assert.rejects(inventory("projecta", source), errorCode("STORAGE_CONFIG_CONFLICT"));
    assert.deepEqual(state.reads, []);
  }
});

test("the object cap is enforced before body reads", async () => {
  const { state, source, inventory } = fixture(PROJECT_STORAGE_ADOPTION_MAX_OBJECTS + 1);
  await assert.rejects(inventory("projecta", source), errorCode("STORAGE_ADOPTION_LIMIT"));
  assert.deepEqual(state.reads, []);
});

test("catalogue drift changes the fingerprint and unknown buckets fail closed", async () => {
  const { state, source, inventory } = fixture(1);
  const first = await inventory("projecta", source);
  state.objects.push({ bucket_id: "files", name: "late.txt" });
  assert.notEqual((await inventory("projecta", source)).fingerprint, first.fingerprint);
  state.objects.push({ bucket_id: "unknown", name: "hidden.txt" });
  await assert.rejects(inventory("projecta", source), errorCode("STORAGE_CONFIG_UNAVAILABLE"));
});
