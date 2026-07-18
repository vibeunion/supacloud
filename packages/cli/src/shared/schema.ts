import { Type } from "@sinclair/typebox";
import type {
    SchemaOptions,
    Static,
    StaticDecode,
    TSchema,
} from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export type ToolSchema = Record<string, TSchema>;

function schemaErrorPath(path: string): string {
    return path.replace(/^\//, "").replaceAll("/", ".") || "args";
}

function schemaErrorLines(schema: TSchema, input: unknown): string[] {
    return [...Value.Errors(schema, input)].map(
        (issue) => `- ${schemaErrorPath(issue.path)}: ${issue.message}`,
    );
}

function transformErrorLine(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const path = typeof error === "object"
        && error !== null
        && "path" in error
        && typeof error.path === "string"
        ? schemaErrorPath(error.path)
        : "args";
    return `- ${path}: ${message}`;
}

export function parseToolArguments(schema: ToolSchema, input: unknown): Record<string, unknown> {
    const objectSchema = Type.Object(schema, { additionalProperties: false });
    const issues = schemaErrorLines(objectSchema, input);
    if (issues.length > 0) throw new Error(`Invalid arguments:\n${issues.join("\n")}`);

    try {
        return Value.Decode(objectSchema, input) as Record<string, unknown>;
    } catch (error) {
        throw new Error(`Invalid arguments:\n${transformErrorLine(error)}`);
    }
}

export function stringEnum(
    values: readonly [string, ...string[]],
    options?: SchemaOptions,
): TSchema {
    const enumRecord = Object.fromEntries(values.map((entry) => [entry, entry]));
    return Type.Enum(enumRecord, options);
}

export function withDescription<T extends TSchema>(schema: T, description: string): T {
    return { ...schema, description };
}

export function optional<T extends TSchema>(schema: T, description?: string) {
    return Type.Optional(description ? withDescription(schema, description) : schema);
}

export function decodedSchema<TInput extends TSchema, TOutput extends TSchema>(
    inputSchema: TInput,
    outputSchema: TOutput,
    decode: (input: StaticDecode<TInput>) => unknown,
    options?: SchemaOptions,
) {
    const transform = Type.Transform(inputSchema)
        .Decode((input) => {
            const decoded = decode(input);
            const issues = schemaErrorLines(outputSchema, decoded);
            if (issues.length > 0) throw new Error(issues.join("\n"));
            return decoded as Static<TOutput>;
        })
        .Encode((output) => output as StaticDecode<TInput>);
    return options ? { ...transform, ...options } : transform;
}

export function schemaEnumValues(schema: TSchema): string[] {
    if (!Array.isArray(schema.anyOf)) return [];
    return schema.anyOf.flatMap((branch: unknown) => {
        if (typeof branch !== "object" || branch === null || !("const" in branch)) return [];
        const enumValue = branch.const;
        return typeof enumValue === "string" || typeof enumValue === "number"
            ? [String(enumValue)]
            : [];
    });
}

export function schemaDescription(schema: TSchema): string {
    return typeof schema.description === "string" ? schema.description : "";
}

export function schemaProperties(schema: TSchema | ToolSchema): ToolSchema {
    if ("properties" in schema && typeof schema.properties === "object" && schema.properties !== null) {
        return schema.properties as ToolSchema;
    }
    return schema as ToolSchema;
}
