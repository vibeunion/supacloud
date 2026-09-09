import { getSchemaValidator, type TSchema, type UnwrapSchema } from "elysia";

export class SchemaContractError extends Error {
  readonly code = "SCHEMA_CONTRACT_INVALID";

  constructor() {
    super("Schema contract validation failed");
    this.name = "SchemaContractError";
  }
}

/** Shares Elysia's validation and transformation semantics without trusting a caller-supplied result type. */
export function createSchemaDecoder<const Schema extends TSchema>(schema: Schema) {
  const validator = getSchemaValidator(schema, { coerce: false, normalize: false });
  return (value: unknown): UnwrapSchema<Schema> => {
    try {
      return validator.parse(value);
    } catch {
      throw new SchemaContractError();
    }
  };
}

/**
 * The body and response schemas are also route options. The decoder fields
 * structurally implement @supacloud/app's HttpContract without a runtime import.
 */
export function defineJsonContract<const Input extends TSchema, const Result extends TSchema>(
  schemas: { body: Input; response: Result },
  request: (input: NoInfer<UnwrapSchema<Input>>) => {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    body?: unknown;
  },
) {
  return Object.freeze({
    ...schemas,
    input: createSchemaDecoder(schemas.body),
    result: createSchemaDecoder(schemas.response),
    request,
  });
}
