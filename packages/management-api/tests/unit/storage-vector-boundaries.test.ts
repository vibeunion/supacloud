import { expect, test } from "bun:test";
import {
  parseStorageVectorInput, storageVectorSchemas, vectorMetadataSchema,
} from "../../src/utils/storage-vector-contract";
import { StorageVectorService, storageVectorInternals } from "../../src/services/storage-vector.service";

const location = { vectorBucketName: "embeddings", indexName: "documents" };
const index = { ...location, dataType: "float32", dimension: 2, distanceMetric: "cosine" };

test.each([
  null, [], "text", { ...index, dimension: "2" }, { ...index, dimension: 1.5 },
  { ...index, distanceMetric: "typo" }, { ...index, dataType: "float64" },
  { ...index, metadataConfiguration: {} },
  { ...index, metadataConfiguration: undefined },
  { ...index, metadataConfiguration: { nonFilterableMetadataKeys: ["a", "a"] } },
].map((value) => ({ value })))("rejects malformed vector index input %#", ({ value }) => {
  expect(() => parseStorageVectorInput(storageVectorSchemas.createIndex, value)).toThrow();
});

test.each([
  { float32: ["1", 2] }, { float32: [NaN, 2] }, { float32: [Infinity, 2] },
  { float32: new Array(2) }, [], null, { float32: [] },
].map((data) => ({ data })))("rejects invalid vector components %#", ({ data }) => {
  expect(() => parseStorageVectorInput(storageVectorSchemas.putVectors, {
    ...location, vectors: [{ key: "one", data }],
  })).toThrow();
});

test.each([
  { "": "empty key" }, { score: Infinity }, { score: NaN },
  { nested: {} }, { values: [null] }, { values: new Array(1) },
  { values: undefined },
].map((value) => ({ value })))("rejects invalid metadata %#", ({ value }) => {
  expect(() => parseStorageVectorInput(vectorMetadataSchema, value)).toThrow();
});

test("omits absent optionals, rejects explicit undefined, and preserves prototype-named JSON data", () => {
  const parsed = parseStorageVectorInput(storageVectorSchemas.listBuckets, {});
  expect(Object.hasOwn(parsed, "nextToken")).toBe(false);
  expect(() => parseStorageVectorInput(storageVectorSchemas.listBuckets, { nextToken: undefined })).toThrow();
  const data: unknown = JSON.parse('{"__proto__":"value","constructor":"label"}');
  expect(parseStorageVectorInput(vectorMetadataSchema, data)["__proto__"]).toBe("value");
});

test("rejects inherited fields, cycles and accessors without evaluating getters", () => {
  expect(() => parseStorageVectorInput(storageVectorSchemas.createIndex, Object.create(index))).toThrow();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => parseStorageVectorInput(storageVectorSchemas.listBuckets, cyclic)).toThrow();
  let reads = 0;
  expect(() => parseStorageVectorInput(storageVectorSchemas.listBuckets, {
    get nextToken() { reads++; return "token"; },
  })).toThrow();
  expect(reads).toBe(0);
  let nested: unknown = { key: "value" };
  for (let depth = 0; depth < 40; depth++) nested = { $and: [nested] };
  expect(() => parseStorageVectorInput(storageVectorSchemas.queryVectors, {
    ...location, queryVector: { float32: [1, 0] }, filter: nested,
  })).toThrow("nesting");
});

test("rejects malformed stored rows without coercing them into valid records", () => {
  const row = {
    bucket_name: "embeddings", name: "documents", data_type: "float32", dimension: 2,
    distance_metric: "cosine", metadata_configuration: null, created_at: new Date(),
  };
  expect(storageVectorInternals.storedIndex(row).dimension).toBe(2);
  for (const value of [
    { ...row, dimension: "2" }, { ...row, dimension: 0 },
    { ...row, distance_metric: "unknown" }, { ...row, data_type: "float64" },
    { ...row, created_at: "invalid" }, { ...row, metadata_configuration: {} },
  ]) {
    expect(() => storageVectorInternals.storedIndex(value)).toThrow("Invalid stored");
  }
  const vector = { key: "one", data: [1, 0], metadata: null, updated_at: new Date() };
  expect(storageVectorInternals.storedVector(vector, 2).data).toEqual([1, 0]);
  for (const value of [
    { ...vector, data: ["1", 0] }, { ...vector, data: [1] },
    { ...vector, data: '["1",0]' }, { ...vector, data: [Infinity, 0] },
    { ...vector, key: 1 }, { ...vector, metadata: { x: null } },
  ]) {
    expect(() => storageVectorInternals.storedVector(value, 2)).toThrow("Invalid stored");
  }
  for (const value of [null, {}, [null], [{}], [{ count: "1" }], [{ count: -1 }]]) {
    expect(() => storageVectorInternals.databaseCount(value)).toThrow("Invalid stored");
  }
  expect(storageVectorInternals.databaseCount([{ count: 2 }])).toBe(2);
  expect(storageVectorInternals.storedVector({
    ...vector, data: "[1,0]", metadata: '{"label":"legacy"}',
  }, 2)).toMatchObject({ data: [1, 0], metadata: { label: "legacy" } });
  expect(storageVectorInternals.storedIndex({
    ...row, metadata_configuration: '{"nonFilterableMetadataKeys":["private"]}',
  }).metadataConfiguration).toEqual({ nonFilterableMetadataKeys: ["private"] });
});

test("distance checks dimensions, sparse values and overflow instead of producing NaN", () => {
  const distance = storageVectorInternals.distance;
  expect(distance("euclidean", [1, 2], [4, 6])).toBe(5);
  expect(() => distance("cosine", [1, 2], [1])).toThrow("dimensions");
  expect(() => distance("cosine", new Array<number>(2), [1, 0])).toThrow("finite");
  expect(() => distance("dotproduct", [1e308], [1e308])).toThrow("numeric range");
  expect(storageVectorInternals.matchesFilter({}, { constructor: { $exists: true } })).toBe(false);
});

test("snapshots input before awaiting and does not expose mutable stored references", async () => {
  const ref = "test_mock";
  storageVectorInternals.resetMockStore();
  await StorageVectorService.createBucket(ref, location.vectorBucketName);
  await StorageVectorService.createIndex(ref, {
    ...location, dataType: "float32", dimension: 2, distanceMetric: "cosine",
    metadataConfiguration: { nonFilterableMetadataKeys: ["private"] },
  });
  const input = { ...location, vectors: [{ key: "one", data: { float32: [1, 0] }, metadata: { tags: ["original"] } }] };
  const pending = StorageVectorService.putVectors(ref, input);
  for (const vector of input.vectors) {
    vector.data.float32[0] = NaN;
    vector.metadata.tags.push("changed");
  }
  await pending;
  const output = await StorageVectorService.getVectors(ref, { ...location, keys: ["one"], returnData: true, returnMetadata: true });
  expect(output.vectors).toEqual([{ key: "one", data: { float32: [1, 0] }, metadata: { tags: ["original"] } }]);
  for (const vector of output.vectors) {
    if (vector.data) vector.data.float32[0] = 999;
    if (vector.metadata) vector.metadata.tags = ["external"];
  }
  const indexOutput = await StorageVectorService.getIndex(ref, location.vectorBucketName, location.indexName);
  indexOutput.index.metadataConfiguration?.nonFilterableMetadataKeys.push("external");
  expect((await StorageVectorService.getIndex(ref, location.vectorBucketName, location.indexName))
    .index.metadataConfiguration?.nonFilterableMetadataKeys).toEqual(["private"]);
  expect((await StorageVectorService.getVectors(ref, { ...location, keys: ["one"], returnData: true, returnMetadata: true })).vectors)
    .toEqual([{ key: "one", data: { float32: [1, 0] }, metadata: { tags: ["original"] } }]);
});
