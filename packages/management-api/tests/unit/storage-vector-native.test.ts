// @supacloud-test-isolate
import { expect, mock, test } from "bun:test";
import { withNativePostgres } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "vector storage validates real PostgreSQL rows and rejects corrupted persisted values",
  async () => withNativePostgres(async (database) => {
    mock.module("../../src/db", () => ({
      getProjectDb: () => database,
      resolveDbName: async (ref: string) => ref,
    }));
    const { StorageVectorService } = await import("../../src/services/storage-vector.service");
    const ref = "fixture";
    const location = { vectorBucketName: "embeddings", indexName: "documents" };
    await StorageVectorService.createBucket(ref, "embeddings");
    await StorageVectorService.createIndex(ref, {
      ...location, dataType: "float32", dimension: 2, distanceMetric: "cosine",
      metadataConfiguration: { nonFilterableMetadataKeys: ["private"] },
    });
    await StorageVectorService.putVectors(ref, {
      ...location, vectors: [
        { key: "one", data: { float32: [1, 0] }, metadata: { kind: "document" } },
        { key: "two", data: { float32: [0, 1] } },
      ],
    });
    const jsonTypes: unknown = await database`
      SELECT jsonb_typeof(data) AS data_type, jsonb_typeof(metadata) AS metadata_type
      FROM storage.vectors WHERE key = 'one'
    `;
    expect(jsonTypes).toEqual([{ data_type: "array", metadata_type: "object" }]);
    expect((await StorageVectorService.getIndex(ref, "embeddings", "documents")).index.metadataConfiguration)
      .toEqual({ nonFilterableMetadataKeys: ["private"] });
    expect(await StorageVectorService.getVectors(ref, { ...location, keys: ["two", "one"], returnData: true, returnMetadata: true }))
      .toEqual({ vectors: [
        { key: "two", data: { float32: [0, 1] } },
        { key: "one", data: { float32: [1, 0] }, metadata: { kind: "document" } },
      ] });
    expect(await StorageVectorService.queryVectors(ref, {
      ...location, queryVector: { float32: [1, 0] }, returnDistance: true, topK: 1,
    })).toEqual({ vectors: [{ key: "one", distance: 0 }] });
    expect((await StorageVectorService.listBuckets(ref, {})).vectorBuckets.map((bucket) => bucket.vectorBucketName))
      .toEqual(["embeddings"]);
    expect((await StorageVectorService.listIndexes(ref, { vectorBucketName: "embeddings" })).indexes.map((index) => index.indexName))
      .toEqual(["documents"]);
    await database`UPDATE storage.vector_indexes SET distance_metric = 'invalid'`;
    await expect(StorageVectorService.getIndex(ref, "embeddings", "documents")).rejects.toMatchObject({
      statusCode: 500, code: "InternalError",
    });
    await database`UPDATE storage.vector_indexes SET distance_metric = 'cosine'`;
    await database`UPDATE storage.vectors SET data = '["1", 0]'::jsonb WHERE key = 'one'`;
    await expect(StorageVectorService.queryVectors(ref, { ...location, queryVector: { float32: [1, 0] } }))
      .rejects.toMatchObject({ statusCode: 500 });
    await database`UPDATE storage.vectors SET data = '[1, 0]'::jsonb WHERE key = 'one'`;
    await database`
      UPDATE storage.vectors
      SET data = ${JSON.stringify([1, 0])}::jsonb, metadata = ${JSON.stringify({ kind: "legacy" })}::jsonb
      WHERE key = 'one'
    `;
    expect((await StorageVectorService.getVectors(ref, {
      ...location, keys: ["one"], returnData: true, returnMetadata: true,
    })).vectors).toEqual([{ key: "one", data: { float32: [1, 0] }, metadata: { kind: "legacy" } }]);
    await StorageVectorService.deleteVectors(ref, { ...location, keys: ["one", "two"] });
    expect((await StorageVectorService.listVectors(ref, location)).vectors).toEqual([]);
    await StorageVectorService.deleteIndex(ref, "embeddings", "documents");
    await StorageVectorService.deleteBucket(ref, "embeddings");
    expect((await StorageVectorService.listBuckets(ref, {})).vectorBuckets).toEqual([]);
  }),
  40_000,
);
