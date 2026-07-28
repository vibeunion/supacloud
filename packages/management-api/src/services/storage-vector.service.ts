import type { SQL } from "bun";
import { getProjectDb, resolveDbName } from "../db";

type DistanceMetric = "cosine" | "euclidean" | "dotproduct";
type VectorMetadata = Record<string, string | number | boolean | Array<string | number | boolean>>;
type VectorData = { float32: number[] };

type BucketRecord = {
  name: string;
  createdAt: Date;
  indexes: Map<string, IndexRecord>;
};

type IndexRecord = {
  bucketName: string;
  name: string;
  dataType: "float32";
  dimension: number;
  distanceMetric: DistanceMetric;
  metadataConfiguration?: { nonFilterableMetadataKeys: string[] };
  createdAt: Date;
  vectors: Map<string, VectorRecord>;
};

type VectorRecord = {
  key: string;
  data: number[];
  metadata?: VectorMetadata;
  updatedAt: Date;
};

export type CreateVectorIndexInput = {
  vectorBucketName: string;
  indexName: string;
  dataType: "float32";
  dimension: number;
  distanceMetric: DistanceMetric;
  metadataConfiguration?: { nonFilterableMetadataKeys: string[] };
};

export type PutVectorsInput = {
  vectorBucketName: string;
  indexName: string;
  vectors: Array<{ key: string; data: VectorData; metadata?: VectorMetadata }>;
};

type VectorLocation = { vectorBucketName: string; indexName: string };
type PageInput = { maxResults?: number; nextToken?: string; prefix?: string };
type SegmentInput = { segmentCount?: number; segmentIndex?: number };

export class StorageVectorError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "StorageVectorError";
  }
}

const mockStores = new Map<string, Map<string, BucketRecord>>();
const initializedDatabases = new Map<string, Promise<void>>();
const MAX_BUCKETS = 100;
const MAX_INDEXES_PER_BUCKET = 10;
const MAX_BATCH_SIZE = 500;
const DEFAULT_LIST_PAGE_SIZE = 100;
const DEFAULT_VECTOR_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;
const MAX_DIMENSION = 4096;
export const MAX_VECTOR_VALUES_PER_INDEX = 1_000_000;
const INDEX_NAME = /^[a-z0-9](?:[a-z0-9.-]{1,61})?[a-z0-9]$/;

export function maxVectorsForDimension(dimension: number): number {
  return Math.max(1, Math.floor(MAX_VECTOR_VALUES_PER_INDEX / dimension));
}

function ensureVectorCapacity(currentCount: number, newKeyCount: number, dimension: number): void {
  const limit = maxVectorsForDimension(dimension);
  if (currentCount + newKeyCount > limit) {
    throw new StorageVectorError(
      `Vector index capacity exceeded: dimension ${dimension} supports at most ${limit} vectors in the experimental exact-scan data plane`,
      409,
      "MaxVectorsExceededException",
    );
  }
}

function badRequest(message: string): never {
  throw new StorageVectorError(message, 400, "ValidationException");
}

function notFound(kind: string, name: string): never {
  throw new StorageVectorError(`${kind} '${name}' was not found`, 404, "ResourceNotFoundException");
}

function conflict(kind: string, name: string): never {
  throw new StorageVectorError(`${kind} '${name}' already exists`, 409, "ConflictException");
}

function validateResourceName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 63 || !INDEX_NAME.test(value)) {
    badRequest(`${field} must be 3-63 lowercase letters, numbers, dots, or hyphens and must start and end with a letter or number`);
  }
  return value;
}

function validateIndexInput(input: CreateVectorIndexInput): void {
  validateResourceName(input.vectorBucketName, "vectorBucketName");
  validateResourceName(input.indexName, "indexName");
  if (input.dataType !== "float32") badRequest("dataType must be 'float32'");
  if (!Number.isInteger(input.dimension) || input.dimension < 1 || input.dimension > MAX_DIMENSION) {
    badRequest(`dimension must be an integer between 1 and ${MAX_DIMENSION}`);
  }
  if (!["cosine", "euclidean", "dotproduct"].includes(input.distanceMetric)) {
    badRequest("distanceMetric must be 'cosine', 'euclidean', or 'dotproduct'");
  }
  const metadataConfiguration = input.metadataConfiguration as unknown;
  if (metadataConfiguration !== undefined && (
    metadataConfiguration === null
    || typeof metadataConfiguration !== "object"
    || Array.isArray(metadataConfiguration)
  )) {
    badRequest("metadataConfiguration must be an object");
  }
  const keys = (metadataConfiguration as { nonFilterableMetadataKeys?: unknown } | undefined)?.nonFilterableMetadataKeys;
  if (keys !== undefined) {
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 10 || new Set(keys).size !== keys.length) {
      badRequest("nonFilterableMetadataKeys must contain 1-10 unique keys");
    }
    if (keys.some((key) => typeof key !== "string" || key.length < 1 || key.length > 63)) {
      badRequest("non-filterable metadata keys must contain 1-63 characters");
    }
  }
}

type FilterPrimitive = string | number | boolean;

function isFilterPrimitive(value: unknown): value is FilterPrimitive {
  return typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function validateFilter(filter: unknown, allowAbsent = true): void {
  if (filter === undefined || filter === null) {
    if (allowAbsent) return;
    badRequest("filter conditions must be non-null objects");
  }
  if (typeof filter !== "object" || Array.isArray(filter)) badRequest("filter must be an object");
  const entries = Object.entries(filter as Record<string, unknown>);
  if (entries.length === 0) badRequest("filter must contain at least one condition");
  for (const [key, condition] of entries) {
    if (key === "$and" || key === "$or") {
      if (!Array.isArray(condition) || condition.length === 0) badRequest(`${key} must be a non-empty array`);
      condition.forEach((child) => validateFilter(child, false));
      continue;
    }
    if (key.startsWith("$")) badRequest(`Unsupported metadata filter operator '${key}'`);
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      const operators = Object.entries(condition as Record<string, unknown>);
      if (operators.length === 0) badRequest("metadata filter condition must not be empty");
      for (const [operator, expected] of operators) {
        if (!["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists"].includes(operator)) {
          badRequest(`Unsupported metadata filter operator '${operator}'`);
        }
        if (["$eq", "$ne"].includes(operator) && !isFilterPrimitive(expected)) {
          badRequest(`${operator} must contain a string, number, or boolean`);
        }
        if (["$gt", "$gte", "$lt", "$lte"].includes(operator)
          && (typeof expected !== "number" || !Number.isFinite(expected))) {
          badRequest(`${operator} must contain a finite number`);
        }
        if (operator === "$in" || operator === "$nin") {
          if (!Array.isArray(expected) || expected.length === 0 || expected.some((value) => !isFilterPrimitive(value))) {
            badRequest(`${operator} must contain a non-empty array of strings, numbers, or booleans`);
          }
        }
        if (operator === "$exists" && typeof expected !== "boolean") {
          badRequest("$exists must contain a boolean");
        }
      }
      continue;
    }
    if (!isFilterPrimitive(condition)) badRequest("metadata filter values must be strings, numbers, or booleans");
  }
}

function validateVectorData(data: unknown, dimension: number, field: string): number[] {
  const values = (data as VectorData | undefined)?.float32;
  if (!Array.isArray(values) || values.length !== dimension) {
    badRequest(`${field}.float32 must contain exactly ${dimension} numbers`);
  }
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    badRequest(`${field}.float32 must contain only finite numbers`);
  }
  return values;
}

function validateVectorKeys(keys: unknown): asserts keys is string[] {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_BATCH_SIZE) {
    badRequest(`keys must contain 1-${MAX_BATCH_SIZE} items`);
  }
  if (keys.some((key) => typeof key !== "string" || key.length < 1 || key.length > 1024)) {
    badRequest("keys must contain only 1-1024 character strings");
  }
}

function validateMetadata(metadata: unknown): asserts metadata is VectorMetadata | undefined {
  if (metadata === undefined) return;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    badRequest("metadata must be an object");
  }
  const entries = Object.entries(metadata);
  if (entries.length > 50) badRequest("metadata must have at most 50 keys");
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 40 * 1024) {
    badRequest("metadata must not exceed 40960 bytes");
  }
  for (const [key, value] of entries) {
    if (!key || typeof value === "object" && !Array.isArray(value)) {
      badRequest("metadata values must be strings, numbers, booleans, or arrays of those primitives");
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item) => !["string", "number", "boolean"].includes(typeof item))) {
      badRequest("metadata values must be strings, numbers, booleans, or arrays of those primitives");
    }
  }
}

function normalizePageSize(value: unknown, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_PAGE_SIZE) {
    badRequest(`maxResults must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  return Number(value);
}

function normalizeStoredDistanceMetric(value: unknown): DistanceMetric {
  return value === "euclidean" || value === "dotproduct" ? value : "cosine";
}

function normalizeSegment(input: SegmentInput): { count: number; index: number } | undefined {
  if (input.segmentCount === undefined && input.segmentIndex === undefined) return undefined;
  if (!Number.isInteger(input.segmentCount) || Number(input.segmentCount) < 1 || Number(input.segmentCount) > 16) {
    badRequest("segmentCount must be an integer between 1 and 16");
  }
  if (!Number.isInteger(input.segmentIndex) || Number(input.segmentIndex) < 0 || Number(input.segmentIndex) >= Number(input.segmentCount)) {
    badRequest("segmentIndex must be an integer between 0 and segmentCount - 1");
  }
  return { count: Number(input.segmentCount), index: Number(input.segmentIndex) };
}

function stableKeyHash(value: string): number {
  // 32 位 FNV-1a：跨进程稳定，适合把 key 确定性地分配到并行扫描分段。
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function encodeNextToken(after: string): string {
  return Buffer.from(JSON.stringify({ after }), "utf8").toString("base64url");
}

function decodeNextToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.after !== "string") throw new Error("invalid");
    return parsed.after;
  } catch {
    badRequest("nextToken is invalid");
  }
}

function epochSeconds(value: Date | string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : undefined;
}

function mockStore(ref: string): Map<string, BucketRecord> {
  let store = mockStores.get(ref);
  if (!store) {
    store = new Map();
    mockStores.set(ref, store);
  }
  return store;
}

async function projectDb(ref: string): Promise<SQL> {
  const dbName = await resolveDbName(ref);
  const db = getProjectDb(dbName);
  let initialization = initializedDatabases.get(dbName);
  if (!initialization) {
    initialization = db.unsafe(`
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
    `).then(() => undefined);
    initializedDatabases.set(dbName, initialization);
  }
  try {
    await initialization;
  } catch (error) {
    initializedDatabases.delete(dbName);
    throw error;
  }
  return db;
}

async function getMockIndex(ref: string, bucketName: string, indexName: string): Promise<IndexRecord> {
  const bucket = mockStore(ref).get(bucketName);
  if (!bucket) notFound("Vector bucket", bucketName);
  const index = bucket.indexes.get(indexName);
  if (!index) notFound("Vector index", indexName);
  return index;
}

async function getDatabaseIndex(ref: string, bucketName: string, indexName: string): Promise<IndexRecord> {
  const db = await projectDb(ref);
  const rows = await db`
    SELECT bucket_name, name, data_type, dimension, distance_metric, metadata_configuration, created_at
    FROM storage.vector_indexes
    WHERE bucket_name = ${bucketName} AND name = ${indexName}
    LIMIT 1
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) notFound("Vector index", indexName);
  return {
    bucketName: String(row.bucket_name),
    name: String(row.name),
    dataType: "float32",
    dimension: Number(row.dimension),
    distanceMetric: normalizeStoredDistanceMetric(row.distance_metric),
    metadataConfiguration: row.metadata_configuration as IndexRecord["metadataConfiguration"],
    createdAt: new Date(row.created_at as string | number | Date),
    vectors: new Map(),
  };
}

async function getIndex(ref: string, bucketName: string, indexName: string): Promise<IndexRecord> {
  return ref === "test_mock"
    ? getMockIndex(ref, bucketName, indexName)
    : getDatabaseIndex(ref, bucketName, indexName);
}

function comparePrimitive(left: unknown, operator: string, right: unknown): boolean {
  const leftValues = Array.isArray(left) ? left : [left];
  switch (operator) {
    case "$eq": return leftValues.some((value) => value === right);
    case "$ne": return leftValues.every((value) => value !== right);
    case "$gt": return !Array.isArray(left) && typeof left === "number" && typeof right === "number" && left > right;
    case "$gte": return !Array.isArray(left) && typeof left === "number" && typeof right === "number" && left >= right;
    case "$lt": return !Array.isArray(left) && typeof left === "number" && typeof right === "number" && left < right;
    case "$lte": return !Array.isArray(left) && typeof left === "number" && typeof right === "number" && left <= right;
    case "$in": return Array.isArray(right) && leftValues.some((value) => right.includes(value));
    case "$nin": return Array.isArray(right) && leftValues.every((value) => !right.includes(value));
    case "$exists": return Boolean(right) === (left !== undefined);
    default: badRequest(`Unsupported metadata filter operator '${operator}'`);
  }
}

function matchesFilter(metadata: VectorMetadata | undefined, filter: unknown): boolean {
  if (filter === undefined || filter === null) return true;
  if (typeof filter !== "object" || Array.isArray(filter)) badRequest("filter must be an object");
  const record = filter as Record<string, unknown>;
  return Object.entries(record).every(([key, condition]) => {
    if (key === "$and") {
      if (!Array.isArray(condition)) badRequest("$and must be an array");
      return condition.every((child) => matchesFilter(metadata, child));
    }
    if (key === "$or") {
      if (!Array.isArray(condition)) badRequest("$or must be an array");
      return condition.some((child) => matchesFilter(metadata, child));
    }
    if (key.startsWith("$")) badRequest(`Unsupported metadata filter operator '${key}'`);

    const value = metadata?.[key];
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      return Object.entries(condition as Record<string, unknown>)
        .every(([operator, expected]) => comparePrimitive(value, operator, expected));
    }
    return comparePrimitive(value, "$eq", condition);
  });
}

function collectFilterKeys(filter: unknown, keys = new Set<string>()): Set<string> {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return keys;
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value)) value.forEach((child) => collectFilterKeys(child, keys));
    } else if (key === "$not") {
      collectFilterKeys(value, keys);
    } else if (!key.startsWith("$")) {
      keys.add(key);
    }
  }
  return keys;
}

function distance(metric: DistanceMetric, left: number[], right: number[]): number {
  if (metric === "euclidean") {
    return Math.sqrt(left.reduce((sum, value, index) => sum + (value - right[index]!) ** 2, 0));
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  if (metric === "dotproduct") return 1 - dot;
  if (leftNorm === 0 || rightNorm === 0) return 1;
  return 1 - dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function shapeVector(
  record: VectorRecord,
  returnData = false,
  returnMetadata = false,
): { key: string; data?: VectorData; metadata?: VectorMetadata } {
  return {
    key: record.key,
    ...(returnData ? { data: { float32: record.data } } : {}),
    ...(returnMetadata && record.metadata !== undefined ? { metadata: record.metadata } : {}),
  };
}

async function loadVectors(ref: string, location: VectorLocation): Promise<VectorRecord[]> {
  if (ref === "test_mock") return [...(await getMockIndex(ref, location.vectorBucketName, location.indexName)).vectors.values()];
  await getDatabaseIndex(ref, location.vectorBucketName, location.indexName);
  const db = await projectDb(ref);
  const rows = await db`
    SELECT key, data, metadata, updated_at
    FROM storage.vectors
    WHERE bucket_name = ${location.vectorBucketName} AND index_name = ${location.indexName}
    ORDER BY key ASC
  `;
  return rows.map((row: Record<string, unknown>) => ({
    key: String(row.key),
    data: Array.isArray(row.data) ? row.data.map(Number) : JSON.parse(String(row.data)),
    metadata: row.metadata as VectorMetadata | undefined,
    updatedAt: new Date(row.updated_at as string | number | Date),
  }));
}

export class StorageVectorService {
  static async createBucket(ref: string, vectorBucketName: string): Promise<void> {
    const name = validateResourceName(vectorBucketName, "vectorBucketName");
    if (ref === "test_mock") {
      const store = mockStore(ref);
      if (store.has(name)) conflict("Vector bucket", name);
      if (store.size >= MAX_BUCKETS) throw new StorageVectorError("Maximum vector bucket count exceeded", 409, "MaxBucketsExceededException");
      store.set(name, { name, createdAt: new Date(), indexes: new Map() });
      return;
    }
    const db = await projectDb(ref);
    const [{ count }] = await db`SELECT count(*)::integer AS count FROM storage.vector_buckets`;
    if (Number(count) >= MAX_BUCKETS) throw new StorageVectorError("Maximum vector bucket count exceeded", 409, "MaxBucketsExceededException");
    try {
      await db`INSERT INTO storage.vector_buckets (name) VALUES (${name})`;
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "23505") conflict("Vector bucket", name);
      throw error;
    }
  }

  static async deleteBucket(ref: string, vectorBucketName: string): Promise<void> {
    const name = validateResourceName(vectorBucketName, "vectorBucketName");
    if (ref === "test_mock") {
      const store = mockStore(ref);
      const bucket = store.get(name);
      if (!bucket) notFound("Vector bucket", name);
      if (bucket.indexes.size > 0) throw new StorageVectorError(`Vector bucket '${name}' is not empty`, 409, "VectorBucketNotEmpty");
      store.delete(name);
      return;
    }
    const db = await projectDb(ref);
    const indexRows = await db`SELECT 1 FROM storage.vector_indexes WHERE bucket_name = ${name} LIMIT 1`;
    if (indexRows.length > 0) throw new StorageVectorError(`Vector bucket '${name}' is not empty`, 409, "VectorBucketNotEmpty");
    const result = await db`DELETE FROM storage.vector_buckets WHERE name = ${name} RETURNING name`;
    if (result.length === 0) notFound("Vector bucket", name);
  }

  static async getBucket(ref: string, vectorBucketName: string) {
    const name = validateResourceName(vectorBucketName, "vectorBucketName");
    if (ref === "test_mock") {
      const bucket = mockStore(ref).get(name);
      if (!bucket) notFound("Vector bucket", name);
      return { vectorBucket: { vectorBucketName: name, creationTime: epochSeconds(bucket.createdAt) } };
    }
    const db = await projectDb(ref);
    const rows = await db`SELECT name, created_at FROM storage.vector_buckets WHERE name = ${name} LIMIT 1`;
    if (!rows[0]) notFound("Vector bucket", name);
    return { vectorBucket: { vectorBucketName: name, creationTime: epochSeconds(rows[0].created_at as Date) } };
  }

  static async listBuckets(ref: string, input: PageInput) {
    const maxResults = normalizePageSize(input.maxResults, DEFAULT_LIST_PAGE_SIZE);
    const after = decodeNextToken(input.nextToken);
    const prefix = typeof input.prefix === "string" ? input.prefix : "";
    let buckets: Array<{ name: string; createdAt: Date }>;
    if (ref === "test_mock") {
      buckets = [...mockStore(ref).values()].map((bucket) => ({ name: bucket.name, createdAt: bucket.createdAt }));
    } else {
      const db = await projectDb(ref);
      const rows = await db`
        SELECT name, created_at FROM storage.vector_buckets
        WHERE name LIKE ${`${prefix}%`} AND name > ${after ?? ""}
        ORDER BY name ASC LIMIT ${maxResults + 1}
      `;
      buckets = rows.map((row: Record<string, unknown>) => ({ name: String(row.name), createdAt: new Date(row.created_at as Date) }));
    }
    const filtered = buckets.filter((bucket) => bucket.name.startsWith(prefix) && (!after || bucket.name > after)).sort((a, b) => a.name.localeCompare(b.name));
    const page = filtered.slice(0, maxResults);
    return {
      vectorBuckets: page.map((bucket) => ({ vectorBucketName: bucket.name, creationTime: epochSeconds(bucket.createdAt) })),
      ...(filtered.length > maxResults && page.at(-1) ? { nextToken: encodeNextToken(page.at(-1)!.name) } : {}),
    };
  }

  static async createIndex(ref: string, input: CreateVectorIndexInput): Promise<void> {
    validateIndexInput(input);
    if (ref === "test_mock") {
      const bucket = mockStore(ref).get(input.vectorBucketName);
      if (!bucket) notFound("Vector bucket", input.vectorBucketName);
      if (bucket.indexes.has(input.indexName)) conflict("Vector index", input.indexName);
      if (bucket.indexes.size >= MAX_INDEXES_PER_BUCKET) throw new StorageVectorError("Maximum vector index count exceeded", 409, "MaxIndexesExceededException");
      bucket.indexes.set(input.indexName, {
        bucketName: input.vectorBucketName,
        name: input.indexName,
        dataType: input.dataType,
        dimension: input.dimension,
        distanceMetric: input.distanceMetric,
        metadataConfiguration: input.metadataConfiguration,
        createdAt: new Date(),
        vectors: new Map(),
      });
      return;
    }
    const db = await projectDb(ref);
    const buckets = await db`SELECT 1 FROM storage.vector_buckets WHERE name = ${input.vectorBucketName} LIMIT 1`;
    if (!buckets[0]) notFound("Vector bucket", input.vectorBucketName);
    const [{ count }] = await db`SELECT count(*)::integer AS count FROM storage.vector_indexes WHERE bucket_name = ${input.vectorBucketName}`;
    if (Number(count) >= MAX_INDEXES_PER_BUCKET) throw new StorageVectorError("Maximum vector index count exceeded", 409, "MaxIndexesExceededException");
    try {
      await db`
        INSERT INTO storage.vector_indexes
          (bucket_name, name, data_type, dimension, distance_metric, metadata_configuration)
        VALUES
          (${input.vectorBucketName}, ${input.indexName}, ${input.dataType}, ${input.dimension}, ${input.distanceMetric}, ${input.metadataConfiguration ? JSON.stringify(input.metadataConfiguration) : null}::jsonb)
      `;
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "23505") conflict("Vector index", input.indexName);
      throw error;
    }
  }

  static async deleteIndex(ref: string, vectorBucketName: string, indexName: string): Promise<void> {
    validateResourceName(vectorBucketName, "vectorBucketName");
    validateResourceName(indexName, "indexName");
    if (ref === "test_mock") {
      const bucket = mockStore(ref).get(vectorBucketName);
      if (!bucket) notFound("Vector bucket", vectorBucketName);
      if (!bucket.indexes.delete(indexName)) notFound("Vector index", indexName);
      return;
    }
    const db = await projectDb(ref);
    const rows = await db`DELETE FROM storage.vector_indexes WHERE bucket_name = ${vectorBucketName} AND name = ${indexName} RETURNING name`;
    if (!rows[0]) notFound("Vector index", indexName);
  }

  static async getIndex(ref: string, vectorBucketName: string, indexName: string) {
    validateResourceName(vectorBucketName, "vectorBucketName");
    validateResourceName(indexName, "indexName");
    const index = await getIndex(ref, vectorBucketName, indexName);
    return {
      index: {
        vectorBucketName: index.bucketName,
        indexName: index.name,
        dataType: index.dataType,
        dimension: index.dimension,
        distanceMetric: index.distanceMetric,
        ...(index.metadataConfiguration ? { metadataConfiguration: index.metadataConfiguration } : {}),
        creationTime: epochSeconds(index.createdAt),
      },
    };
  }

  static async listIndexes(ref: string, input: PageInput & { vectorBucketName: string }) {
    validateResourceName(input.vectorBucketName, "vectorBucketName");
    const maxResults = normalizePageSize(input.maxResults, DEFAULT_LIST_PAGE_SIZE);
    const after = decodeNextToken(input.nextToken);
    const prefix = typeof input.prefix === "string" ? input.prefix : "";
    let indexes: IndexRecord[];
    if (ref === "test_mock") {
      const bucket = mockStore(ref).get(input.vectorBucketName);
      if (!bucket) notFound("Vector bucket", input.vectorBucketName);
      indexes = [...bucket.indexes.values()];
    } else {
      const db = await projectDb(ref);
      const buckets = await db`SELECT 1 FROM storage.vector_buckets WHERE name = ${input.vectorBucketName} LIMIT 1`;
      if (!buckets[0]) notFound("Vector bucket", input.vectorBucketName);
      const rows = await db`
        SELECT bucket_name, name, data_type, dimension, distance_metric, metadata_configuration, created_at
        FROM storage.vector_indexes
        WHERE bucket_name = ${input.vectorBucketName} AND name LIKE ${`${prefix}%`} AND name > ${after ?? ""}
        ORDER BY name ASC LIMIT ${maxResults + 1}
      `;
      indexes = rows.map((row: Record<string, unknown>) => ({
        bucketName: String(row.bucket_name), name: String(row.name), dataType: "float32",
        dimension: Number(row.dimension), distanceMetric: normalizeStoredDistanceMetric(row.distance_metric),
        metadataConfiguration: row.metadata_configuration as IndexRecord["metadataConfiguration"],
        createdAt: new Date(row.created_at as Date), vectors: new Map(),
      }));
    }
    const filtered = indexes.filter((index) => index.name.startsWith(prefix) && (!after || index.name > after)).sort((a, b) => a.name.localeCompare(b.name));
    const page = filtered.slice(0, maxResults);
    return {
      indexes: page.map((index) => ({
        vectorBucketName: index.bucketName,
        indexName: index.name,
        creationTime: epochSeconds(index.createdAt),
      })),
      ...(filtered.length > maxResults && page.at(-1) ? { nextToken: encodeNextToken(page.at(-1)!.name) } : {}),
    };
  }

  static async putVectors(ref: string, input: PutVectorsInput): Promise<void> {
    if (!Array.isArray(input.vectors) || input.vectors.length < 1 || input.vectors.length > MAX_BATCH_SIZE) {
      badRequest(`vectors must contain 1-${MAX_BATCH_SIZE} items`);
    }
    const index = await getIndex(ref, input.vectorBucketName, input.indexName);
    const normalized = input.vectors.map((vector, position) => {
      if (!vector || typeof vector.key !== "string" || vector.key.length < 1 || vector.key.length > 1024) badRequest(`vectors[${position}].key is invalid`);
      validateMetadata(vector.metadata);
      return { key: vector.key, data: validateVectorData(vector.data, index.dimension, `vectors[${position}].data`), metadata: vector.metadata };
    });
    if (new Set(normalized.map((vector) => vector.key)).size !== normalized.length) badRequest("vector keys must be unique within a batch");
    if (ref === "test_mock") {
      const newKeyCount = normalized.filter((vector) => !index.vectors.has(vector.key)).length;
      ensureVectorCapacity(index.vectors.size, newKeyCount, index.dimension);
      const now = new Date();
      normalized.forEach((vector) => index.vectors.set(vector.key, { ...vector, updatedAt: now }));
      return;
    }
    const db = await projectDb(ref);
    await db.begin(async (tx) => {
      await tx`
        SELECT 1 FROM storage.vector_indexes
        WHERE bucket_name = ${input.vectorBucketName} AND name = ${input.indexName}
        FOR UPDATE
      `;
      const [{ count }] = await tx`
        SELECT count(*)::integer AS count FROM storage.vectors
        WHERE bucket_name = ${input.vectorBucketName} AND index_name = ${input.indexName}
      `;
      const existingRows = await tx`
        SELECT key FROM storage.vectors
        WHERE bucket_name = ${input.vectorBucketName}
          AND index_name = ${input.indexName}
          AND key IN ${tx(normalized.map((vector) => vector.key))}
      `;
      ensureVectorCapacity(Number(count), normalized.length - existingRows.length, index.dimension);
      for (const vector of normalized) {
        await tx`
          INSERT INTO storage.vectors (bucket_name, index_name, key, data, metadata, updated_at)
          VALUES (${input.vectorBucketName}, ${input.indexName}, ${vector.key}, ${JSON.stringify(vector.data)}::jsonb, ${vector.metadata ? JSON.stringify(vector.metadata) : null}::jsonb, now())
          ON CONFLICT (bucket_name, index_name, key)
          DO UPDATE SET data = EXCLUDED.data, metadata = EXCLUDED.metadata, updated_at = now()
        `;
      }
    });
  }

  static async deleteVectors(ref: string, input: VectorLocation & { keys: string[] }): Promise<void> {
    validateVectorKeys(input.keys);
    const index = await getIndex(ref, input.vectorBucketName, input.indexName);
    if (ref === "test_mock") {
      input.keys.forEach((key) => index.vectors.delete(key));
      return;
    }
    const db = await projectDb(ref);
    await db`DELETE FROM storage.vectors WHERE bucket_name = ${input.vectorBucketName} AND index_name = ${input.indexName} AND key IN ${db(input.keys)}`;
  }

  static async getVectors(ref: string, input: VectorLocation & { keys: string[]; returnData?: boolean; returnMetadata?: boolean }) {
    validateVectorKeys(input.keys);
    const wanted = new Set(input.keys);
    const vectors = (await loadVectors(ref, input)).filter((vector) => wanted.has(vector.key));
    const order = new Map(input.keys.map((key, index) => [key, index]));
    vectors.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
    return { vectors: vectors.map((vector) => shapeVector(vector, input.returnData, input.returnMetadata)) };
  }

  static async listVectors(ref: string, input: VectorLocation & PageInput & SegmentInput & { returnData?: boolean; returnMetadata?: boolean }) {
    const maxResults = normalizePageSize(input.maxResults, DEFAULT_VECTOR_PAGE_SIZE);
    const after = decodeNextToken(input.nextToken);
    const segment = normalizeSegment(input);
    const vectors = (await loadVectors(ref, input))
      .filter((vector) => !segment || stableKeyHash(vector.key) % segment.count === segment.index)
      .filter((vector) => !after || vector.key > after)
      .sort((a, b) => a.key.localeCompare(b.key));
    const page = vectors.slice(0, maxResults);
    return {
      vectors: page.map((vector) => shapeVector(vector, input.returnData, input.returnMetadata)),
      ...(vectors.length > maxResults && page.at(-1) ? { nextToken: encodeNextToken(page.at(-1)!.key) } : {}),
    };
  }

  static async queryVectors(ref: string, input: VectorLocation & {
    queryVector: VectorData;
    topK?: number;
    filter?: unknown;
    returnDistance?: boolean;
    returnMetadata?: boolean;
  }) {
    const index = await getIndex(ref, input.vectorBucketName, input.indexName);
    const query = validateVectorData(input.queryVector, index.dimension, "queryVector");
    validateFilter(input.filter);
    const topK = input.topK ?? 10;
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) badRequest("topK must be an integer between 1 and 100");
    const nonFilterable = new Set(index.metadataConfiguration?.nonFilterableMetadataKeys ?? []);
    for (const key of collectFilterKeys(input.filter)) {
      if (nonFilterable.has(key)) badRequest(`Metadata key '${key}' is configured as non-filterable`);
    }
    const vectors = (await loadVectors(ref, input))
      .filter((vector) => matchesFilter(vector.metadata, input.filter))
      .map((vector) => ({ vector, distance: distance(index.distanceMetric, query, vector.data) }))
      .sort((a, b) => a.distance - b.distance || a.vector.key.localeCompare(b.vector.key))
      .slice(0, topK);
    return {
      vectors: vectors.map(({ vector, distance: vectorDistance }) => ({
        key: vector.key,
        ...(input.returnDistance ? { distance: vectorDistance } : {}),
        ...(input.returnMetadata && vector.metadata !== undefined ? { metadata: vector.metadata } : {}),
      })),
    };
  }
}

export const storageVectorInternals = {
  resetMockStore() {
    mockStores.clear();
  },
  matchesFilter,
  distance,
  decodeNextToken,
  stableKeyHash,
};
