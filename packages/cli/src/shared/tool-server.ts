import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseToolArguments, type ToolArguments, type ToolSchema } from "./schema.js";

export interface ToolTextContent {
    readonly type: "text";
    readonly text: string;
}

export interface ToolResult {
    content: ToolTextContent[];
    readonly isError?: boolean;
}

export type ToolCallback<TArgs, TResult extends ToolResult = ToolResult> = (args: TArgs) => Promise<TResult>;
export type ToolInvocation = (args: unknown) => Promise<ToolResult>;

export interface ToolServer {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: ToolInvocation,
    ) => void;
}

const resultSchema = Type.Object({
    content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() })),
    isError: Type.Optional(Type.Boolean()),
});

export function registerTool<S extends ToolSchema, TResult extends ToolResult = ToolResult>(
    server: ToolServer,
    name: string,
    description: string,
    schema: S,
    callback: ToolCallback<NoInfer<ToolArguments<S>>, TResult>,
): void {
    server.tool(name, description, schema, async (input) => {
        const args = parseToolArguments(schema, input);
        const result = await callback(args);
        if (!Value.Check(resultSchema, result)) throw new Error(`Invalid result from tool '${name}'`);
        return result;
    });
}
