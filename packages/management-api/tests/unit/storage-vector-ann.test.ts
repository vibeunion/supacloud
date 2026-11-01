import { describe, expect, test } from "bun:test";
import {
  DEFAULT_IVFFLAT_LISTS,
  PGVECTOR_ANN_MAX_DIMENSION,
  VECTOR_REGISTRY_SQL,
  buildAnnQuery,
  copyLegacyVectorsSql,
  createAnnIndexSql,
  createVectorDataTableSql,
  distancePlan,
  vectorQueryEngine,
} from "../../src/services/storage-vector-ann";

const INDEX_ID = "ab".repeat(16);

describe("pgvector ANN plan", () => {
  test("keeps the in-memory harness distinct from project ANN", () => {
    expect(vectorQueryEngine("test_mock")).toBe("exact-scan-harness");
    expect(vectorQueryEngine("project_ref")).toBe("pgvector-ann");
  });

  test("builds HNSW and IVFFlat indexes for each distance metric", () => {
    expect(PGVECTOR_ANN_MAX_DIMENSION).toBe(2000);
    expect(createVectorDataTableSql(INDEX_ID, 3)).toContain("embedding vector(3) NOT NULL");
    expect(createAnnIndexSql({ indexId: INDEX_ID, metric: "cosine", algorithm: "hnsw" }))
      .toBe(`CREATE INDEX IF NOT EXISTS vector_ann_${INDEX_ID} ON storage.vector_data_${INDEX_ID} USING hnsw (embedding vector_cosine_ops)`);
    expect(createAnnIndexSql({ indexId: INDEX_ID, metric: "euclidean", algorithm: "ivfflat" }))
      .toContain(`USING ivfflat (embedding vector_l2_ops) WITH (lists = ${DEFAULT_IVFFLAT_LISTS})`);
    expect(createAnnIndexSql({ indexId: INDEX_ID, metric: "dotproduct", algorithm: "ivfflat", lists: 12 }))
      .toContain("USING ivfflat (embedding vector_ip_ops) WITH (lists = 12)");
    expect(() => createAnnIndexSql({ indexId: INDEX_ID, metric: "cosine", algorithm: "hnsw", lists: 12 }))
      .toThrow("ivfflatLists");
    expect(() => createVectorDataTableSql(INDEX_ID, 2001)).toThrow("2000");
    expect(() => createVectorDataTableSql("not-hex", 3)).toThrow("invalid vector index id");
  });

  test("orders by the raw ANN operator and does not scan the legacy JSONB table", () => {
    const cosine = buildAnnQuery({
      indexId: INDEX_ID,
      metric: "cosine",
      queryVector: [1, 0, 0],
      topK: 2,
      filter: { category: "docs" },
    });
    expect(cosine.sql).toContain("ORDER BY embedding <=> $1::vector");
    expect(cosine.sql).toContain("LIMIT $2");
    expect(cosine.sql).not.toContain("ORDER BY CASE");
    expect(cosine.sql).not.toContain("storage.vectors");
    expect(cosine.params[0]).toBe("[1,0,0]");
    expect(cosine.params[1]).toBe(2);
    expect(cosine.sql).not.toContain("docs");
    expect(cosine.params).toContain(JSON.stringify("docs"));

    const dot = buildAnnQuery({
      indexId: INDEX_ID,
      metric: "dotproduct",
      queryVector: [1, 0],
      topK: 1,
    });
    expect(dot.sql).toContain("ORDER BY embedding <#> $1::vector");
    expect(dot.sql).toContain("(1 + (embedding <#> $1::vector)) AS distance");
    expect(distancePlan("euclidean").operator).toBe("<->");
    expect(distancePlan("euclidean").ops).toBe("vector_l2_ops");

    const hostile = buildAnnQuery({
      indexId: INDEX_ID,
      metric: "cosine",
      queryVector: [1, 0, 0],
      topK: 1,
      filter: { "a'); drop table storage.vectors;--": { $eq: "docs" } },
    });
    expect(hostile.sql).not.toContain("drop table");
    expect(hostile.params).toContain("a'); drop table storage.vectors;--");
  });

  test("copies legacy JSONB rows into the pgvector relation instead of querying them", () => {
    expect(VECTOR_REGISTRY_SQL).toContain("ann_ready boolean");
    expect(VECTOR_REGISTRY_SQL).toContain("index_algorithm text");
    expect(VECTOR_REGISTRY_SQL).not.toContain("ORDER BY embedding");
    const copy = copyLegacyVectorsSql(INDEX_ID);
    expect(copy).toContain(`INSERT INTO storage.vector_data_${INDEX_ID}`);
    expect(copy).toContain("FROM storage.vectors");
    expect(copy).toContain("data::text::vector");
    expect(copy).not.toContain("ORDER BY");
  });
});
