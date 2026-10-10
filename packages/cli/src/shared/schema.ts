import { Type } from "typebox";
import type {
    StaticDecode,
    TObject,
    TSchema,
    TSchemaOptions,
} from "typebox";
import { Value } from "typebox/value";

export type ToolSchema = Record<string, TSchema>;
export type ToolArguments<S extends ToolSchema> = StaticDecode<TObject<S>>;

/** Loosely typed view for reading JSON-Schema keywords off a generated schema. */
type SchemaView = {
    const?: unknown;
    enum?: unknown;
    anyOf?: unknown;
    description?: unknown;
    properties?: unknown;
};

// TypeBox codecs do not receive a path; retain identity to locate output errors.
const DECODE_ID = "~supacloudDecodeId";

class OutputDecodeError extends Error {
    constructor(readonly decodeId: symbol, readonly issues: ReadonlyArray<{ path: string; message: string }>) {
        super(issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n"));
    }
}

function decodeIdOf(schema: TSchema): symbol | undefined {
    const value: unknown = Object.getOwnPropertyDescriptor(schema, DECODE_ID)?.value;
    return typeof value === "symbol" ? value : undefined;
}

function schemaErrorPath(path: string): string {
    return path.replace(/^\//, "").replaceAll("/", ".") || "args";
}

function schemaErrorLines(schema: TSchema, input: unknown): string[] {
    return [...Value.Errors(schema, input)].map(
        (issue) => `- ${schemaErrorPath(issue.instancePath)}: ${issue.message}`,
    );
}

function transformErrorLine(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const path = typeof error === "object"
        && error !== null
        && "instancePath" in error
        && typeof error.instancePath === "string"
        ? schemaErrorPath(error.instancePath)
        : "args";
    return `- ${path}: ${message}`;
}

export function validateToolArguments(schema: ToolSchema, input: unknown): asserts input is Record<string, unknown> {
    const issues = schemaErrorLines(Type.Object(schema, { additionalProperties: false }), input);
    if (issues.length > 0) throw new Error(`Invalid arguments:\n${issues.join("\n")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseToolArguments<S extends ToolSchema>(
    schema: S,
    input: unknown,
): ToolArguments<S> {
    const objectSchema = Type.Object(schema, { additionalProperties: false });
    validateToolArguments(schema, input);

    let decoded: ToolArguments<S>;
    try {
        decoded = Value.Decode(objectSchema, input);
    } catch (error) {
        if (error instanceof OutputDecodeError) {
            const entry = Object.entries(schema).find(([, property]) => decodeIdOf(property) === error.decodeId);
            const path = entry?.[0] ?? "args";
            const issues = error.issues.map((issue) =>
                `- ${issue.path === "args" ? path : `${path}.${issue.path}`}: ${issue.message}`);
            throw new Error(`Invalid arguments:\n${issues.join("\n")}`);
        }
        throw new Error(`Invalid arguments:\n${transformErrorLine(error)}`);
    }
    const decodedFields: unknown = decoded;
    if (!isRecord(decodedFields)) {
        throw new Error("Invalid arguments: decoded value must be an object");
    }
    return decoded;
}

export function stringEnum<const Values extends readonly [string, ...string[]]>(
    values: Values,
    options?: TSchemaOptions,
) {
    return Type.Enum<Array<Values[number]>>([...values], options);
}

/**
 * Merge JSON-Schema options without dropping TypeBox 1.x markers.
 * TypeBox stores `~kind`, `~optional` and `~codec` as non-enumerable own
 * properties, so an object spread would silently discard them.
 */
function mergeSchemaOptions<T extends TSchema>(schema: T, options: TSchemaOptions): T {
    const result = { ...schema };
    Object.setPrototypeOf(result, Object.getPrototypeOf(schema));
    Object.defineProperties(result, Object.getOwnPropertyDescriptors(schema));
    for (const [key, value] of Object.entries(options)) {
        Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return result;
}

export function withDescription<T extends TSchema>(schema: T, description: string): T {
    return mergeSchemaOptions(schema, { description });
}

export function optional<T extends TSchema>(schema: T, description?: string) {
    return Type.Optional(description ? withDescription(schema, description) : schema);
}

export function decodedSchema<TInput extends TSchema, TOutput extends TSchema>(
    inputSchema: TInput,
    outputSchema: TOutput,
    decode: (input: StaticDecode<TInput>) => unknown,
    options?: TSchemaOptions,
) {
    const decodeId = Symbol("decodedSchema");
    const transform = Type.Decode(inputSchema, (input) => {
        const value = decode(input);
        const issues = [...Value.Errors(outputSchema, value)].map((issue) => ({
            path: schemaErrorPath(issue.instancePath), message: issue.message,
        }));
        if (issues.length > 0) throw new OutputDecodeError(decodeId, issues);
        return Value.Decode(outputSchema, value);
    });
    const result = options ? mergeSchemaOptions(transform, options) : transform;
    Object.defineProperty(result, DECODE_ID, { value: decodeId, enumerable: false, configurable: true });
    return result;
}

export function schemaEnumValues(schema: TSchema): string[] {
    const view = schema as SchemaView;
    if (Array.isArray(view.enum)) {
        return view.enum
            .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
            .map((value) => String(value));
    }
    if (typeof view.const === "string" || typeof view.const === "number") {
        return [String(view.const)];
    }
    if (!Array.isArray(view.anyOf)) return [];
    return view.anyOf.flatMap((branch: unknown) => {
        if (typeof branch !== "object" || branch === null || !("const" in branch)) return [];
        const enumValue = (branch as { const: unknown }).const;
        return typeof enumValue === "string" || typeof enumValue === "number"
            ? [String(enumValue)]
            : [];
    });
}

export function schemaDescription(schema: TSchema): string {
    const description = (schema as SchemaView).description;
    return typeof description === "string" ? description : "";
}

export function schemaProperties(schema: TSchema | ToolSchema): ToolSchema {
    const properties = schema && typeof schema === "object" ? (schema as SchemaView).properties : undefined;
    if (typeof properties === "object" && properties !== null) {
        return properties as ToolSchema;
    }
    return schema as ToolSchema;
}
