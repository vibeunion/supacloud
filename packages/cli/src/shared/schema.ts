import { Type } from "typebox";
import type {
    Static,
    StaticDecode,
    TSchema,
    TSchemaOptions,
} from "typebox";
import { Value } from "typebox/value";

export type ToolSchema = Record<string, TSchema>;

/** Loosely typed view for reading JSON-Schema keywords off a generated schema. */
type SchemaView = {
    const?: unknown;
    enum?: unknown;
    anyOf?: unknown;
    description?: unknown;
    properties?: unknown;
};

/**
 * Non-enumerable marker attached by `decodedSchema` so argument validation can
 * re-check the decoded value against its declared output schema and report the
 * owning argument name. TypeBox 1.x codec callbacks do not receive a path.
 */
const OUTPUT_SCHEMA = "~supacloudOutputSchema";

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

export function parseToolArguments(schema: ToolSchema, input: unknown): Record<string, unknown> {
    const objectSchema = Type.Object(schema, { additionalProperties: false });
    const issues = schemaErrorLines(objectSchema, input);
    if (issues.length > 0) throw new Error(`Invalid arguments:\n${issues.join("\n")}`);

    let decoded: Record<string, unknown>;
    try {
        decoded = Value.Decode(objectSchema, input) as Record<string, unknown>;
    } catch (error) {
        throw new Error(`Invalid arguments:\n${transformErrorLine(error)}`);
    }

    const decodedIssues: string[] = [];
    for (const [name, propertySchema] of Object.entries(schema)) {
        const outputSchema = (propertySchema as Record<string, unknown> | undefined)?.[OUTPUT_SCHEMA] as TSchema | undefined;
        if (outputSchema === undefined || decoded[name] === undefined) continue;
        for (const issue of Value.Errors(outputSchema, decoded[name])) {
            const path = schemaErrorPath(issue.instancePath);
            decodedIssues.push(`- ${path === "args" ? name : `${name}.${path}`}: ${issue.message}`);
        }
    }
    if (decodedIssues.length > 0) throw new Error(`Invalid arguments:\n${decodedIssues.join("\n")}`);
    return decoded;
}

export function stringEnum(
    values: readonly [string, ...string[]],
    options?: TSchemaOptions,
): TSchema {
    const enumRecord = Object.fromEntries(values.map((entry) => [entry, entry]));
    return Type.Enum(enumRecord, options);
}

/**
 * Merge JSON-Schema options without dropping TypeBox 1.x markers.
 * TypeBox stores `~kind`, `~optional` and `~codec` as non-enumerable own
 * properties, so an object spread would silently discard them.
 */
function mergeSchemaOptions<T extends TSchema>(schema: T, options: TSchemaOptions): T {
    const result = Object.create(Object.getPrototypeOf(schema)) as T;
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
    const transform = Type.Codec(inputSchema)
        .Decode((input) => decode(input) as Static<TOutput>)
        .Encode((output) => output as StaticDecode<TInput>);
    const result = options ? mergeSchemaOptions(transform, options) : transform;
    Object.defineProperty(result, OUTPUT_SCHEMA, { value: outputSchema, enumerable: false, configurable: true });
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