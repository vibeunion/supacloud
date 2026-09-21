import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export class StorageVectorError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
    this.name = "StorageVectorError";
  }
}

const resourceName = Type.String({
  minLength: 3, maxLength: 63, pattern: "^[a-z0-9](?:[a-z0-9.-]{1,61})?[a-z0-9]$",
});
const key = Type.String({ minLength: 1, maxLength: 1024 });
const primitive = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);
export const vectorDataSchema = Type.Object({
  float32: Type.Array(Type.Number(), { minItems: 1, maxItems: 4096 }),
});
export const vectorMetadataSchema = Type.Record(
  Type.String({ pattern: "^.+$" }),
  Type.Union([primitive, Type.Array(primitive)]),
  { maxProperties: 50, additionalProperties: false },
);
export const vectorMetadataConfigurationSchema = Type.Object({
  nonFilterableMetadataKeys: Type.Array(Type.String({ minLength: 1, maxLength: 63 }), {
    minItems: 1, maxItems: 10, uniqueItems: true,
  }),
});
export const vectorDistanceMetricSchema = Type.Union([
  Type.Literal("cosine"), Type.Literal("euclidean"), Type.Literal("dotproduct"),
]);

const bucket = { vectorBucketName: resourceName };
const location = { ...bucket, indexName: resourceName };
const page = {
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  nextToken: Type.Optional(Type.String()),
  prefix: Type.Optional(Type.String()),
};
const returns = {
  returnData: Type.Optional(Type.Boolean()),
  returnMetadata: Type.Optional(Type.Boolean()),
};
const keys = Type.Array(key, { minItems: 1, maxItems: 500 });

export const storageVectorSchemas = {
  bucket: Type.Object(bucket),
  location: Type.Object(location),
  listBuckets: Type.Object(page),
  createIndex: Type.Object({
    ...location,
    dataType: Type.Literal("float32"),
    dimension: Type.Integer({ minimum: 1, maximum: 4096 }),
    distanceMetric: vectorDistanceMetricSchema,
    metadataConfiguration: Type.Optional(vectorMetadataConfigurationSchema),
  }),
  listIndexes: Type.Object({ ...bucket, ...page }),
  putVectors: Type.Object({
    ...location,
    vectors: Type.Array(Type.Object({
      key, data: vectorDataSchema, metadata: Type.Optional(vectorMetadataSchema),
    }), { minItems: 1, maxItems: 500 }),
  }),
  deleteVectors: Type.Object({ ...location, keys }),
  getVectors: Type.Object({ ...location, keys, ...returns }),
  listVectors: Type.Object({
    ...location, ...page, ...returns,
    segmentCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    segmentIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })),
  }),
  queryVectors: Type.Object({
    ...location,
    queryVector: vectorDataSchema,
    topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    filter: Type.Optional(Type.Unknown()),
    returnDistance: Type.Optional(Type.Boolean()),
    returnMetadata: Type.Optional(Type.Boolean()),
  }),
};

export type DistanceMetric = Static<typeof vectorDistanceMetricSchema>;
export type VectorData = Static<typeof vectorDataSchema>;
export type VectorMetadata = Static<typeof vectorMetadataSchema>;
export type CreateVectorIndexInput = Static<typeof storageVectorSchemas.createIndex>;
export type PutVectorsInput = Static<typeof storageVectorSchemas.putVectors>;
export type VectorLocation = Static<typeof storageVectorSchemas.location>;
export type PageInput = Static<typeof storageVectorSchemas.listBuckets>;
export type GetVectorsInput = Static<typeof storageVectorSchemas.getVectors>;
export type ListVectorsInput = Static<typeof storageVectorSchemas.listVectors>;
export type QueryVectorsInput = Static<typeof storageVectorSchemas.queryVectors>;

// Copy JSON values before an async boundary. Reject sparse arrays, cycles, undefined,
// accessors and inherited state instead of turning them into valid-looking input.
function copyJson(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (depth > 32) throw new StorageVectorError("request nesting exceeds 32 levels", 400, "ValidationException");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new StorageVectorError("request must contain finite JSON values", 400, "ValidationException");
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw new StorageVectorError("request must contain plain JSON objects", 400, "ValidationException");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !("value" in descriptor)) {
          throw new StorageVectorError("request arrays must not be sparse or contain accessors", 400, "ValidationException");
        }
        output.push(copyJson(descriptor.value, ancestors, depth + 1));
      }
      return output;
    }
    const output: Array<[string, unknown]> = [];
    for (const name of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !("value" in descriptor)) {
        throw new StorageVectorError("request objects must not contain accessors", 400, "ValidationException");
      }
      output.push([name, copyJson(descriptor.value, ancestors, depth + 1)]);
    }
    return Object.fromEntries(output);
  } finally {
    ancestors.delete(value);
  }
}

export function parseStorageVectorInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  const snapshot = copyJson(value);
  if (!Value.Check(schema, snapshot)) {
    throw new StorageVectorError("Invalid vector request fields", 400, "ValidationException");
  }
  return snapshot;
}
