import { expect, spyOn, test } from "bun:test";
import { Type } from "typebox";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import { runCli } from "./cli";
import { decodedSchema, optional, stringEnum, withDescription, type ToolArguments, type ToolSchema } from "./schema";
import { registerTool, type ToolCallback, type ToolInvocation, type ToolResult, type ToolServer, type ToolTextContent } from "./tool-server";
import { HttpTransport } from "./transports/http";
import { registerDatabaseTools } from "./tools/database-tools";

interface CapturedTool {
    schema: ToolSchema;
    callback: ToolInvocation;
}

function capture(register: (server: ToolServer) => void): CapturedTool {
    let tool: CapturedTool | undefined;
    const server: ToolServer = {
        tool(_name, _description, schema, callback) {
            tool = { schema, callback };
        },
    };
    register(server);
    if (!tool) throw new Error("tool was not registered");
    return tool;
}

test("CLI decodes a non-idempotent codec exactly once and preserves the encoded input", async () => {
    let decodeCount = 0;
    const schema = {
        action: stringEnum(["get"]),
        hostname: decodedSchema(
            Type.String(),
            Type.String({ minLength: 1 }),
            (input) => {
                decodeCount += 1;
                return `${input}.decoded`;
            },
        ),
    };
    let received: string | undefined;
    const tool = capture((server) => registerTool(server, "test", "test", schema, async (args) => {
        received = args.hostname;
        return { content: [{ type: "text", text: args.hostname }] };
    }));

    const output = spyOn(console, "log").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
        await runCli({ test: tool }, ["test", "get", "--hostname", "example.com"]);
        expect(process.exitCode).toBe(0);
        expect(output).toHaveBeenCalledWith("example.com.decoded");
    } finally {
        output.mockRestore();
        process.exitCode = previousExitCode;
    }
    expect(decodeCount).toBe(1);
    expect(received).toBe("example.com.decoded");
});

test("rejects invalid, missing, and unknown arguments before the callback", async () => {
    let callbackCount = 0;
    const schema = {
        action: stringEnum(["list", "get"]),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
    };
    const tool = capture((server) => registerTool(server, "validate", "validate", schema, async () => {
        callbackCount += 1;
        return { content: [{ type: "text", text: "ok" }] };
    }));

    for (const input of [
        null, [], 42, { action: "delete" }, { limit: 1 },
        { action: "list", limit: 0 }, { action: "list", unexpected: true },
    ]) await expect(tool.callback(input)).rejects.toThrow("Invalid arguments");
    expect(callbackCount).toBe(0);
});

test("reports decoded output errors under the owning argument", async () => {
    const schema = {
        count: decodedSchema(
            Type.String(),
            Type.Integer({ minimum: 1 }),
            () => "not-a-number",
        ),
    };
    const tool = capture((server) => registerTool(server, "decoded-output", "decoded output", schema, async () => ({
        content: [{ type: "text", text: "unreachable" }],
    })));

    await expect(tool.callback({ count: "1" })).rejects.toThrow("- count: must be integer");
});

test("preserves the server method receiver", async () => {
    let invocation: ToolInvocation | undefined;
    interface ReceiverServer extends ToolServer {
        registered: boolean;
    }
    const server: ReceiverServer = {
        registered: false,
        tool(this: { registered: boolean }, _name: string, _description: string, _schema: ToolSchema, handler: ToolInvocation) {
            this.registered = true;
            invocation = handler;
        },
    };
    registerTool(server, "receiver", "receiver", {}, async () => ({
        content: [{ type: "text", text: "ok" }],
    }));
    expect(server.registered).toBe(true);
    if (!invocation) throw new Error("tool was not registered");
    await expect(invocation({})).resolves.toEqual({
        content: [{ type: "text", text: "ok" }],
    });
});

test("rejects a result mutated to violate its declared protocol", async () => {
    const content: ToolTextContent = { type: "text", text: "valid" };
    const result: ToolResult = { content: [content] };
    Object.defineProperty(content, "text", { value: 12 });
    const tool = capture((server) => registerTool(server, "invalid-result", "invalid result", {}, async () => result));
    await expect(tool.callback({})).rejects.toThrow("Invalid result from tool 'invalid-result'");
});

test("preserves enum, optional and codec output types without callback annotations", async () => {
    const schema = {
        action: stringEnum(["list", "get"]),
        count: optional(decodedSchema(Type.String(), Type.Integer(), Number)),
    };
    const tool = capture((server) => registerTool(server, "inference", "inference", schema, async (args) => {
        const action: "list" | "get" = args.action;
        const count: number | undefined = args.count;
        return { content: [{ type: "text", text: `${action}:${count ?? "absent"}` }] };
    }));
    await expect(tool.callback({ action: "list" })).resolves.toEqual({
        content: [{ type: "text", text: "list:absent" }],
    });
    await expect(tool.callback({ action: "get", count: "5" })).resolves.toEqual({
        content: [{ type: "text", text: "get:5" }],
    });
});

test("optional codec metadata survives descriptions and reports nested output paths", async () => {
    const schema = {
        config: optional(withDescription(decodedSchema(
            Type.String(),
            Type.Object({ count: Type.Integer() }),
            () => ({ count: "bad" }),
        ), "Config")),
    };
    const tool = capture((server) => registerTool(server, "paths", "paths", schema, async () => ({
        content: [{ type: "text", text: "ok" }],
    })));
    await expect(tool.callback({ config: "{}" })).rejects.toThrow("- config.count: must be integer");
});

test("TypeBox optional cloning preserves codec diagnostics without custom wrappers", async () => {
    const schema = {
        count: withDescription(Type.Optional(decodedSchema(Type.String(), Type.Integer(), () => "bad")), "Count"),
    };
    const tool = capture((server) => registerTool(server, "paths", "paths", schema, async () => ({ content: [] })));
    await expect(tool.callback({ count: "1" })).rejects.toThrow("- count: must be integer");
});

const rowFixtures: Array<{ action: string; row: Record<string, unknown> }> = [
    { action: "list_tables", row: { schema: "public", table: "orders" } },
    { action: "describe_columns", row: { column_name: "id", data_type: "uuid", is_nullable: "NO", column_default: null } },
    { action: "list_indexes", row: { indexname: "orders_pkey", indexdef: "CREATE UNIQUE INDEX orders_pkey ON orders (id)" } },
    { action: "list_constraints", row: { name: "orders_pkey", type: "p", definition: "PRIMARY KEY (id)" } },
    { action: "list_extensions", row: { name: "vector", version: "1.0", schema: "public" } },
    { action: "rls_status", row: { tablename: "orders", rls_enabled: true } },
    { action: "rls_policies", row: { policyname: "owner", cmd: "ALL", permissive: "PERMISSIVE", roles: ["public"], qual: "true", with_check: null } },
    { action: "list_auth_users", row: { id: "user-one", email: null, role: "authenticated", created_at: "2026-10-10" } },
    { action: "get_auth_user", row: { id: "user-one", email: null, role: "authenticated", created_at: "2026-10-10" } },
    { action: "connections", row: { pid: 42, usename: "postgres", client_addr: null, state: "active", query: "SELECT 1" } },
    { action: "stats", row: { schemaname: "public", table_name: "orders", row_count: "4", total_size: "1 MB", table_size: "1 MB", index_size: "0 MB" } },
];

test.each(rowFixtures)("database $action parses its response without unchecked row types", async ({ action, row }) => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ rows: [row] }), { headers: { "Content-Type": "application/json" } }),
    );
    try {
        const http = new HttpTransport({ baseUrl: "https://management.test", token: "test-token" });
        const tool = capture((server) => registerDatabaseTools(server, http));
        const result = await tool.callback({ action, ref: "project", table: "orders", user_id: "user-one" });
        expect(result.isError).not.toBe(true);
        expect(result.content[0]?.text.length).toBeGreaterThan(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
        fetchMock.mockRestore();
    }
});

test.each(rowFixtures)("database $action rejects malformed response rows", async ({ action }) => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ rows: [null] }), { headers: { "Content-Type": "application/json" } }),
    );
    try {
        const http = new HttpTransport({ baseUrl: "https://management.test", token: "test-token" });
        const tool = capture((server) => registerDatabaseTools(server, http));
        await expect(tool.callback({ action, ref: "project", table: "orders", user_id: "user-one" }))
            .rejects.toThrow("Invalid database response");
    } finally {
        fetchMock.mockRestore();
    }
});

test("CLI production sources contain no explicit any or checking suppressions", async () => {
    const root = resolve(import.meta.dir, "..");
    const files = await readdir(root, { recursive: true });
    const failures: string[] = [];
    for (const file of files) {
        if (!file.endsWith(".ts") || /\.(test|spec)\.ts$/.test(file)) continue;
        const text = await readFile(resolve(root, file), "utf8");
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node): void => {
            if (node.kind === ts.SyntaxKind.AnyKeyword) failures.push(`${file}: explicit any`);
            ts.forEachChild(node, visit);
        };
        visit(source);
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
        for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
            if ((kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia)
                && /@ts-(ignore|nocheck|expect-error)\b/.test(scanner.getTokenText())) {
                failures.push(`${file}: suppressed checking`);
            }
        }
    }
    expect(failures).toEqual([]);
});

test("CLI rejects duplicate or extra flags before invoking or decoding", async () => {
    let decodeCount = 0;
    let callbackCount = 0;
    const schema = {
        action: stringEnum(["get"]),
        value: decodedSchema(Type.String(), Type.String(), (input) => {
            decodeCount += 1;
            return input;
        }),
    };
    const tool = capture((server) => registerTool(server, "test", "test", schema, async () => {
        callbackCount += 1;
        return { content: [{ type: "text", text: "ok" }] };
    }));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
        await runCli({ test: tool }, ["test", "get", "--value", "one", "--value", "two"]);
        expect(process.exitCode).toBe(1);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining("Duplicate CLI flag"));
        await runCli({ test: tool }, ["test", "get", "--value", "one", "--extra"]);
        expect(process.exitCode).toBe(1);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining("Invalid arguments"));
    } finally {
        errors.mockRestore();
        process.exitCode = previousExitCode;
    }
    expect(decodeCount).toBe(0);
    expect(callbackCount).toBe(0);
});

// These fixtures must be rejected by the package typecheck, without widening S.
function negativeTypeFixtures(server: ToolServer): void {
    const schema = { count: Type.Integer() };
    const correct: ToolCallback<ToolArguments<typeof schema>> = async () => ({
        content: [{ type: "text", text: "ok" }],
    });
    registerTool(server, "correct", "correct", schema, correct);
    // @ts-expect-error A callback cannot reinterpret a schema number as a string.
    registerTool(server, "wrong-args", "wrong args", schema, async (_args: { count: string }) => ({ content: [] }));
    // @ts-expect-error Text content must include its text field.
    registerTool(server, "wrong-result", "wrong result", schema, async () => ({ content: [{ type: "text" }] }));
}

void negativeTypeFixtures;
