import { beforeEach, describe, expect, test } from "bun:test";
import {
  StorageVectorError,
  StorageVectorService,
  storageVectorInternals,
} from "../../src/services/storage-vector.service";

const REF = "test_mock";

beforeEach(() => {
  storageVectorInternals.resetMockStore();
});

describe("StorageVectorService", () => {
  test("implements the complete bucket and index lifecycle", async () => {
    await StorageVectorService.createBucket(REF, "embeddings");

    expect(await StorageVectorService.getBucket(REF, "embeddings")).toMatchObject({
      vectorBucket: { vectorBucketName: "embeddings" },
    });
    expect(await StorageVectorService.listBuckets(REF, {})).toMatchObject({
      vectorBuckets: [{ vectorBucketName: "embeddings" }],
    });

    await StorageVectorService.createIndex(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      dataType: "float32",
      dimension: 3,
      distanceMetric: "cosine",
      metadataConfiguration: { nonFilterableMetadataKeys: ["private"] },
    });

    expect(await StorageVectorService.getIndex(REF, "embeddings", "documents-openai")).toMatchObject({
      index: {
        vectorBucketName: "embeddings",
        indexName: "documents-openai",
        dataType: "float32",
        dimension: 3,
        distanceMetric: "cosine",
      },
    });
    expect(await StorageVectorService.listIndexes(REF, { vectorBucketName: "embeddings" })).toMatchObject({
      indexes: [{ vectorBucketName: "embeddings", indexName: "documents-openai" }],
    });

    await expect(StorageVectorService.deleteBucket(REF, "embeddings")).rejects.toBeInstanceOf(StorageVectorError);
    await StorageVectorService.deleteIndex(REF, "embeddings", "documents-openai");
    await StorageVectorService.deleteBucket(REF, "embeddings");
    expect((await StorageVectorService.listBuckets(REF, {})).vectorBuckets).toEqual([]);
  });

  test("puts, gets, lists, queries, filters, and deletes vectors", async () => {
    await StorageVectorService.createBucket(REF, "embeddings");
    await StorageVectorService.createIndex(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      dataType: "float32",
      dimension: 3,
      distanceMetric: "cosine",
    });
    await StorageVectorService.putVectors(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      vectors: [
        { key: "a", data: { float32: [1, 0, 0] }, metadata: { category: "docs", score: 10 } },
        { key: "b", data: { float32: [0, 1, 0] }, metadata: { category: "images", score: 5 } },
        { key: "c", data: { float32: [0.8, 0.2, 0] }, metadata: { category: "docs", score: 20 } },
      ],
    });

    expect(await StorageVectorService.getVectors(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      keys: ["a"],
      returnData: true,
      returnMetadata: true,
    })).toEqual({
      vectors: [{ key: "a", data: { float32: [1, 0, 0] }, metadata: { category: "docs", score: 10 } }],
    });

    const firstPage = await StorageVectorService.listVectors(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      maxResults: 2,
      returnData: false,
      returnMetadata: false,
    });
    expect(firstPage.vectors).toEqual([{ key: "a" }, { key: "b" }]);
    expect(firstPage.nextToken).toBeString();
    expect((await StorageVectorService.listVectors(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      nextToken: firstPage.nextToken,
    })).vectors).toEqual([{ key: "c" }]);

    const [segmentZero, segmentOne] = await Promise.all([
      StorageVectorService.listVectors(REF, {
        vectorBucketName: "embeddings",
        indexName: "documents-openai",
        segmentCount: 2,
        segmentIndex: 0,
      }),
      StorageVectorService.listVectors(REF, {
        vectorBucketName: "embeddings",
        indexName: "documents-openai",
        segmentCount: 2,
        segmentIndex: 1,
      }),
    ]);
    expect([...segmentZero.vectors, ...segmentOne.vectors].map((vector) => vector.key).sort()).toEqual(["a", "b", "c"]);
    expect(segmentZero.vectors.some((left) => segmentOne.vectors.some((right) => left.key === right.key))).toBe(false);
    await expect(StorageVectorService.listVectors(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      segmentCount: 2,
      segmentIndex: 2,
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(StorageVectorService.listVectors(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      segmentIndex: 0,
    })).rejects.toMatchObject({ statusCode: 400 });

    const query = await StorageVectorService.queryVectors(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      queryVector: { float32: [1, 0, 0] },
      topK: 2,
      filter: { $and: [{ category: { $eq: "docs" } }, { score: { $gte: 10 } }] },
      returnDistance: true,
      returnMetadata: true,
    });
    expect(query.vectors.map((vector) => vector.key)).toEqual(["a", "c"]);
    expect(query.vectors[0]?.distance).toBe(0);
    expect(query.vectors[0]?.metadata).toEqual({ category: "docs", score: 10 });

    await StorageVectorService.deleteVectors(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      keys: ["a", "missing"],
    });
    expect((await StorageVectorService.getVectors(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      keys: ["a"],
    })).vectors).toEqual([]);
  });

  test("validates dimensions, limits, duplicate resources, and non-filterable metadata", async () => {
    await StorageVectorService.createBucket(REF, "embeddings");
    await expect(StorageVectorService.createBucket(REF, "embeddings")).rejects.toMatchObject({ statusCode: 409 });

    await StorageVectorService.createIndex(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      dataType: "float32",
      dimension: 3,
      distanceMetric: "euclidean",
      metadataConfiguration: { nonFilterableMetadataKeys: ["private"] },
    });

    await expect(StorageVectorService.putVectors(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      vectors: [{ key: "bad", data: { float32: [1, 2] } }],
    })).rejects.toMatchObject({ statusCode: 400 });

    await expect(StorageVectorService.queryVectors(REF, {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      queryVector: { float32: [1, 2, 3] },
      topK: 5,
      filter: { private: { $eq: "secret" } },
    })).rejects.toMatchObject({ statusCode: 400 });
  });
});
