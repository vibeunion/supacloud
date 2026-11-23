import { afterEach, expect, test } from "bun:test";
import { Type } from "typebox";
import { runCli } from "./cli";
import type { ToolSchema } from "./schema";
import type { ToolResult } from "./tool-server";

const originalExitCode = process.exitCode;

afterEach(() => {
    process.exitCode = originalExitCode;
});

function capture(schema: ToolSchema) {
    const calls: Array<Record<string, unknown>> = [];
    const tools = {
        demo: {
            schema,
            callback: async (args: unknown): Promise<ToolResult> => {
                calls.push(args as Record<string, unknown>);
                return { content: [{ type: "text", text: "ok" }] };
            },
        },
    };
    return { calls, tools };
}

test("kebab-case CLI flags resolve to one snake_case schema field", async () => {
    const { calls, tools } = capture({
        action: Type.Optional(Type.String()),
        dry_run: Type.Optional(Type.Boolean()),
        database_url: Type.Optional(Type.String()),
    });
    await runCli(tools, ["demo", "generate", "--dry-run", "--database-url", "postgresql://db.example/app"]);
    expect(calls).toEqual([{
        action: "generate",
        dry_run: true,
        database_url: "postgresql://db.example/app",
    }]);
});

test("kebab-case and snake_case spellings of one flag are duplicates", async () => {
    const { calls, tools } = capture({
        action: Type.Optional(Type.String()),
        dry_run: Type.Optional(Type.Boolean()),
    });
    await runCli(tools, ["demo", "generate", "--dry-run", "--dry_run"]);
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(1);
});

test("an exact hyphenated schema field keeps its declared name", async () => {
    const { calls, tools } = capture({
        action: Type.Optional(Type.String()),
        "expected-active-version": Type.Optional(Type.String()),
    });
    await runCli(tools, ["demo", "deploy", "--expected-active-version", "3"]);
    expect(calls).toEqual([{ action: "deploy", "expected-active-version": "3" }]);
});

test("database operation ownership accepts a nested suggest/adopt action", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools = {
        db: {
            schema: {
                action: Type.Enum(["operation-ownership", "context"]),
                operation_action: Type.Optional(Type.Enum(["suggest", "adopt"])),
                write: Type.Optional(Type.Boolean()),
            },
            callback: async (args: unknown): Promise<ToolResult> => {
                calls.push(args as Record<string, unknown>);
                return { content: [{ type: "text", text: "ok" }] };
            },
        },
    };
    await runCli(tools, ["db", "operation-ownership", "suggest"]);
    expect(calls).toEqual([{ action: "operation-ownership", operation_action: "suggest" }]);
});
