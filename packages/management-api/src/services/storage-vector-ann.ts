/**
 * pgvector ANN plan for Storage Vector Buckets.
 *
 * QueryVectors on a project database must execute this SQL. The in-memory
 * `test_mock` harness is a separate engine and must not be described as ANN.
 * ANN recall is not measured here; this module only builds the statements.
 */

export const PGVECTOR_ANN_MAX_DIMENSION = 2000;
export const DEFAULT_IVFFLAT_LISTS = 100;
export const MAX_IVFFLAT_LISTS = 32_768;

export const ANN_ALGORITHMS = ["hnsw", "ivfflat"] as const;
export type AnnAlgorithm = (typeof ANN_ALGORITHMS)[number];
export type DistanceMetric = "cosine" | "euclidean" | "dotproduct";
export type VectorQueryEngine = "pgvector-ann" | "exact-scan-harness";

const INDEX_ID = /^[0-9a-f]{32}$/;

export function vectorQueryEngine(ref: string): VectorQueryEngine {
  return ref === "test_mock" ? "exact-scan-harness" : "pgvector-ann";
}

export function newVectorIndexId(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function assertIndexId(indexId: string): string {
  if (!INDEX_ID.test(indexId)) throw new Error("invalid vector index id");
  return indexId;
}

export function vectorDataRelation(indexId: string): string {
  return `vector_data_${assertIndexId(indexId)}`;
}

export function vectorAnnIndex(indexId: string): string {
  return `vector_ann_${assertIndexId(indexId)}`;
}

export function assertAnnDimension(dimension: number): number {
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > PGVECTOR_ANN_MAX_DIMENSION) {
    throw new Error(`pgvector HNSW and IVFFlat indexes require a dimension from 1 to ${PGVECTOR_ANN_MAX_DIMENSION}`);
  }
  return dimension;
}

export function assertAnnAlgorithm(value: unknown): AnnAlgorithm {
  if (value === "hnsw" || value === "ivfflat") return value;
  throw new Error("indexAlgorithm must be 'hnsw' or 'ivfflat'");
}

export function assertIvfflatLists(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_IVFFLAT_LISTS) {
    throw new Error(`ivfflatLists must be an integer from 1 to ${MAX_IVFFLAT_LISTS}`);
  }
  return value;
}

type DistancePlan = {
  operator: "<=>" | "<->" | "<#>";
  ops: "vector_cosine_ops" | "vector_l2_ops" | "vector_ip_ops";
  /** Selected distance matches the Vector Bucket contract. ORDER BY must stay the raw operator. */
  selectSql: string;
};

export function distancePlan(metric: DistanceMetric): DistancePlan {
  switch (metric) {
    case "cosine":
      return {
        operator: "<=>",
        ops: "vector_cosine_ops",
        selectSql: "CASE WHEN (embedding <=> $1::vector) = 'NaN'::double precision THEN 1::double precision ELSE (embedding <=> $1::vector) END",
      };
    case "euclidean":
      return {
        operator: "<->",
        ops: "vector_l2_ops",
        selectSql: "(embedding <-> $1::vector)",
      };
    case "dotproduct":
      // `<#>` is the negative inner product. The API distance remains `1 - inner_product`.
      return {
        operator: "<#>",
        ops: "vector_ip_ops",
        selectSql: "(1 + (embedding <#> $1::vector))",
      };
    default:
      throw new Error("distanceMetric must be 'cosine', 'euclidean', or 'dotproduct'");
  }
}

/**
 * Registry tables. `storage.vectors` is only a legacy import source.
 * ANN rows live in `storage.vector_data_<index_id>`.
 */
export const VECTOR_REGISTRY_SQL = `
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.vector_buckets (
  name text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS storage.vector_indexes (
  bucket_name text NOT NULL REFERENCES storage.vector_buckets(name) ON DELETE CASCADE,
  name text NOT NULL,
  data_type text NOT NULL,
  dimension integer NOT NULL,
  distance_metric text NOT NULL,
  metadata_configuration jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_name, name)
);
CREATE TABLE IF NOT EXISTS storage.vectors (
  bucket_name text NOT NULL,
  index_name text NOT NULL,
  key text NOT NULL,
  data jsonb NOT NULL,
  metadata jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_name, index_name, key),
  FOREIGN KEY (bucket_name, index_name)
    REFERENCES storage.vector_indexes(bucket_name, name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS storage_vectors_listing_idx
  ON storage.vectors(bucket_name, index_name, key);
ALTER TABLE storage.vector_indexes ADD COLUMN IF NOT EXISTS index_id text;
ALTER TABLE storage.vector_indexes ADD COLUMN IF NOT EXISTS index_algorithm text;
ALTER TABLE storage.vector_indexes ADD COLUMN IF NOT EXISTS ivfflat_lists integer;
ALTER TABLE storage.vector_indexes ADD COLUMN IF NOT EXISTS ann_ready boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS storage_vector_indexes_index_id_key
  ON storage.vector_indexes (index_id);
`.trim();

export function createVectorDataTableSql(indexId: string, dimension: number): string {
  const relation = vectorDataRelation(indexId);
  const width = assertAnnDimension(dimension);
  return `CREATE TABLE IF NOT EXISTS storage.${relation} (
  key text PRIMARY KEY,
  embedding vector(${width}) NOT NULL,
  metadata jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;
}

export function createAnnIndexSql(input: {
  indexId: string;
  metric: DistanceMetric;
  algorithm: AnnAlgorithm;
  lists?: number;
}): string {
  const relation = vectorDataRelation(input.indexId);
  const index = vectorAnnIndex(input.indexId);
  const { ops } = distancePlan(input.metric);
  if (input.algorithm === "hnsw") {
    if (input.lists !== undefined) throw new Error("ivfflatLists is only valid for ivfflat");
    return `CREATE INDEX IF NOT EXISTS ${index} ON storage.${relation} USING hnsw (embedding ${ops})`;
  }
  const lists = assertIvfflatLists(input.lists ?? DEFAULT_IVFFLAT_LISTS);
  return `CREATE INDEX IF NOT EXISTS ${index} ON storage.${relation} USING ivfflat (embedding ${ops}) WITH (lists = ${lists})`;
}

export function dropVectorDataTableSql(indexId: string): string {
  return `DROP TABLE IF EXISTS storage.${vectorDataRelation(indexId)}`;
}

export function copyLegacyVectorsSql(indexId: string): string {
  return `INSERT INTO storage.${vectorDataRelation(indexId)} (key, embedding, metadata, updated_at)
SELECT key, data::text::vector, metadata, updated_at
FROM storage.vectors
WHERE bucket_name = $1 AND index_name = $2
ON CONFLICT (key) DO NOTHING`;
}

export function formatVectorLiteral(values: number[]): string {
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("vector values must be finite numbers");
  }
  return `[${values.join(",")}]`;
}

export function parseVectorText(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((item) => Number(item));
  const text = String(value).trim();
  if (!text.startsWith("[") || !text.endsWith("]")) throw new Error("pgvector value was not a vector literal");
  if (text.length === 2) return [];
  return text.slice(1, -1).split(",").map((item) => Number(item.trim()));
}

type FilterPrimitive = string | number | boolean;

function bind(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function equalitySql(key: string, expected: FilterPrimitive, params: unknown[]): string {
  const keyRef = bind(params, key);
  const valueRef = bind(params, JSON.stringify(expected));
  return `(
    metadata @> jsonb_build_object(${keyRef}, ${valueRef}::jsonb)
    OR (
      jsonb_typeof(metadata -> ${keyRef}) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(metadata -> ${keyRef}) AS elem
        WHERE elem = ${valueRef}::jsonb
      )
    )
  )`;
}

function comparisonSql(key: string, operator: ">" | ">=" | "<" | "<=", expected: number, params: unknown[]): string {
  const keyRef = bind(params, key);
  const valueRef = bind(params, expected);
  return `(
    jsonb_typeof(metadata -> ${keyRef}) = 'number'
    AND (metadata ->> ${keyRef})::double precision ${operator} ${valueRef}::double precision
  )`;
}

function membershipSql(key: string, expected: FilterPrimitive[], params: unknown[], negated: boolean): string {
  const keyRef = bind(params, key);
  const listRef = bind(params, JSON.stringify(expected));
  const match = `EXISTS (
    SELECT 1 FROM jsonb_array_elements(${listRef}::jsonb) AS expected
    WHERE metadata @> jsonb_build_object(${keyRef}, expected)
      OR (
        jsonb_typeof(metadata -> ${keyRef}) = 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(metadata -> ${keyRef}) AS elem
          WHERE elem = expected
        )
      )
  )`;
  return negated ? `(NOT ${match})` : match;
}

function conditionSql(key: string, condition: unknown, params: unknown[]): string {
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    return Object.entries(condition as Record<string, unknown>).map(([operator, expected]) => {
      switch (operator) {
        case "$eq":
          return equalitySql(key, expected as FilterPrimitive, params);
        case "$ne":
          return `(NOT ${equalitySql(key, expected as FilterPrimitive, params)})`;
        case "$gt":
          return comparisonSql(key, ">", expected as number, params);
        case "$gte":
          return comparisonSql(key, ">=", expected as number, params);
        case "$lt":
          return comparisonSql(key, "<", expected as number, params);
        case "$lte":
          return comparisonSql(key, "<=", expected as number, params);
        case "$in":
          return membershipSql(key, expected as FilterPrimitive[], params, false);
        case "$nin":
          return membershipSql(key, expected as FilterPrimitive[], params, true);
        case "$exists": {
          const keyRef = bind(params, key);
          return expected === true ? `jsonb_exists(metadata, ${keyRef})` : `(NOT jsonb_exists(metadata, ${keyRef}))`;
        }
        default:
          throw new Error(`Unsupported metadata filter operator '${operator}'`);
      }
    }).join(" AND ");
  }
  return equalitySql(key, condition as FilterPrimitive, params);
}

export function compileMetadataFilter(filter: unknown, params: unknown[]): string {
  if (filter === undefined || filter === null) return "TRUE";
  if (typeof filter !== "object" || Array.isArray(filter)) throw new Error("filter must be an object");
  const parts = Object.entries(filter as Record<string, unknown>).map(([key, condition]) => {
    if (key === "$and" || key === "$or") {
      if (!Array.isArray(condition) || condition.length === 0) throw new Error(`${key} must be a non-empty array`);
      const children = condition.map((child) => `(${compileMetadataFilter(child, params)})`);
      return `(${children.join(key === "$and" ? " AND " : " OR ")})`;
    }
    if (key.startsWith("$")) throw new Error(`Unsupported metadata filter operator '${key}'`);
    return `(${conditionSql(key, condition, params)})`;
  });
  if (parts.length === 0) throw new Error("filter must contain at least one condition");
  return parts.join(" AND ");
}

export function buildAnnQuery(input: {
  indexId: string;
  metric: DistanceMetric;
  queryVector: number[];
  topK: number;
  filter?: unknown;
}): { sql: string; params: unknown[] } {
  if (!Number.isInteger(input.topK) || input.topK < 1) throw new Error("topK must be a positive integer");
  const relation = vectorDataRelation(input.indexId);
  const plan = distancePlan(input.metric);
  const params: unknown[] = [formatVectorLiteral(input.queryVector), input.topK];
  const where = compileMetadataFilter(input.filter, params);
  return {
    sql: `SELECT key, metadata, ${plan.selectSql} AS distance
FROM storage.${relation}
WHERE ${where}
ORDER BY embedding ${plan.operator} $1::vector
LIMIT $2`,
    params,
  };
}

export function upsertVectorSql(indexId: string): string {
  return `INSERT INTO storage.${vectorDataRelation(indexId)} (key, embedding, metadata, updated_at)
VALUES ($1, $2::vector, $3::jsonb, now())
ON CONFLICT (key) DO UPDATE
SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = now()`;
}

export function countVectorsSql(indexId: string): string {
  return `SELECT count(*)::integer AS count FROM storage.${vectorDataRelation(indexId)}`;
}

export function selectVectorKeysSql(indexId: string, keyCount: number): string {
  if (!Number.isInteger(keyCount) || keyCount < 1) throw new Error("keyCount must be a positive integer");
  const placeholders = Array.from({ length: keyCount }, (_, index) => `$${index + 1}`).join(", ");
  return `SELECT key FROM storage.${vectorDataRelation(indexId)} WHERE key IN (${placeholders})`;
}

export function deleteVectorKeysSql(indexId: string, keyCount: number): string {
  if (!Number.isInteger(keyCount) || keyCount < 1) throw new Error("keyCount must be a positive integer");
  const placeholders = Array.from({ length: keyCount }, (_, index) => `$${index + 1}`).join(", ");
  return `DELETE FROM storage.${vectorDataRelation(indexId)} WHERE key IN (${placeholders})`;
}

export function listVectorRowsSql(indexId: string): string {
  return `SELECT key, embedding::text AS embedding, metadata, updated_at
FROM storage.${vectorDataRelation(indexId)}
ORDER BY key ASC`;
}
