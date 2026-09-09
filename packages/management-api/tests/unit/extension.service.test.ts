// @supacloud-test-isolate
import { beforeEach, describe, expect, mock, test } from "bun:test";

const unsafeCalls: string[] = [];
const taggedCalls: string[] = [];
let beginCalls = 0;
let createExtensionFailure: Error | null = null;
let entrypointFailure: Error | null = null;
let invalidResult: unknown = undefined;

const mockDbFn = Object.assign(
    async (strings: TemplateStringsArray, extension?: string): Promise<unknown> => {
        const sql = strings.join("?");
        taggedCalls.push(sql);
        if (invalidResult !== undefined && sql.includes("pg_available_extensions")) return invalidResult;
        return [{ name: extension ?? "pg_stat_statements", default_version: "1.10", installed_version: "1.10", comment: "track stats", is_installed: true }];
    },
    {
        close: async () => { },
        unsafe: async (sql: string) => {
            unsafeCalls.push(sql);
            if (createExtensionFailure && sql.startsWith("CREATE EXTENSION")) throw createExtensionFailure;
            if (entrypointFailure && sql.includes("$graphql_entrypoint$")) throw entrypointFailure;
            return [{ name: "pg_stat_statements", default_version: "1.10", installed_version: "1.10", comment: "track stats", is_installed: true }];
        },
        begin: async (operation: (transaction: typeof mockDbFn) => Promise<unknown>): Promise<unknown> => {
            beginCalls += 1;
            return operation(mockDbFn);
        },
    }
);

mock.module("../../src/db", () => ({
    getProjectDb: () => mockDbFn,
    resolveDbName: async () => "project_testref123",
    resolvePgrstChannel: (ref: string) => `pgrst_${ref}`,
}));
const { extensionService, parsePigExtensionList } = await import("../../src/services/extension.service");

describe("ExtensionService", () => {
    beforeEach(() => {
        unsafeCalls.length = 0;
        taggedCalls.length = 0;
        beginCalls = 0;
        createExtensionFailure = null;
        entrypointFailure = null;
        invalidResult = undefined;
    });

    test("listExtensions should parse DB output", async () => {
        const extensions = await extensionService.listExtensions("testref123");
        expect(extensions).toHaveLength(1);
        expect(extensions[0]?.name).toBe("pg_stat_statements");
    });

    test("enableExtension should return success", async () => {
        const result = await extensionService.enableExtension("testref123", "postgis");
        expect(result.name).toBe("postgis");
        expect(result.is_installed).toBe(true);
        expect(beginCalls).toBe(1);
        expect(taggedCalls.some((sql) => sql.includes("pg_notify"))).toBe(true);
    });

    test("enableExtension repairs the invoker entrypoint after installing pg_graphql", async () => {
        await extensionService.enableExtension("testref123", "pg_graphql");

        expect(unsafeCalls[0]).toBe('CREATE EXTENSION IF NOT EXISTS "pg_graphql" CASCADE');
        expect(unsafeCalls[1]).toContain("CREATE OR REPLACE FUNCTION graphql_public.graphql");
        expect(unsafeCalls[1]).toContain("SECURITY INVOKER");
        expect(unsafeCalls[1]).toContain("DROP FUNCTION IF EXISTS graphql_public.graphql(text,text,jsonb)");
        expect(unsafeCalls[1]).not.toContain("DROP FUNCTION IF EXISTS graphql_public.graphql(text,text,jsonb,jsonb)");
        expect(beginCalls).toBe(1);
    });

    test("failed extension creation never repairs the entrypoint or sends a schema reload", async () => {
        createExtensionFailure = new Error("extension install failed");

        await expect(extensionService.enableExtension("testref123", "pg_graphql"))
            .rejects.toThrow("extension install failed");

        expect(beginCalls).toBe(1);
        expect(unsafeCalls).toHaveLength(1);
        expect(taggedCalls.some(sql => sql.includes("pg_notify"))).toBe(false);
    });

    test("failed entrypoint repair aborts before schema notification", async () => {
        entrypointFailure = new Error("entrypoint repair failed");
        await expect(extensionService.enableExtension("testref123", "pg_graphql")).rejects.toThrow("entrypoint repair failed");
        expect(beginCalls).toBe(1);
        expect(unsafeCalls).toHaveLength(2);
        expect(taggedCalls.some(sql => sql.includes("pg_notify"))).toBe(false);
    });

    test.each([
        [],
        [{ name: "pg_graphql", default_version: "1.6.1", installed_version: null, comment: "", is_installed: false }],
        [{ name: "pg_graphql", default_version: "1.6.1", installed_version: "1.6.1", comment: "", is_installed: "true" }],
        [{ name: "other", default_version: "1.6.1", installed_version: "1.6.1", comment: "", is_installed: true }],
    ].map(rows => ({ rows })))("rejects invalid database read-back rather than returning synthetic success: %j", async ({ rows }) => {
        invalidResult = rows;
        await expect(extensionService.enableExtension("testref123", "pg_graphql")).rejects.toThrow("extension state");
        expect(taggedCalls.some(sql => sql.includes("pg_notify"))).toBe(false);
    });

    test("disableExtension drops and reloads schema in one transaction", async () => {
        const result = await extensionService.disableExtension("testref123", "postgis");

        expect(result.is_installed).toBe(true);
        expect(beginCalls).toBe(1);
        expect(unsafeCalls).toEqual(['DROP EXTENSION IF EXISTS "postgis" CASCADE']);
        expect(taggedCalls.some((sql) => sql.includes("pg_notify"))).toBe(true);
    });

    test("parsePigExtensionList should ignore psql table footers", () => {
        const extensions = parsePigExtensionList(`
 name               | default_version | installed_version | comment
--------------------+-----------------+-------------------+-------------------------
 pg_graphql         | 1.5             |                   | GraphQL support
 pg_stat_statements | 1.10            | 1.10              | track planning stats
(2 rows)
`);

        expect(extensions).toEqual([
            { name: "pg_graphql", version: "1.5", status: "available", description: "GraphQL support" },
            { name: "pg_stat_statements", version: "1.10", status: "1.10", description: "track planning stats" },
        ]);
    });

    test("parsePigExtensionList should ignore pig banners and unicode table separators", () => {
        const extensions = parsePigExtensionList(`
✓ Found 2 extensions
┌────────────────────┬─────────────────┬───────────────────┬──────────────────────┐
│ Name               │ Default Version │ Installed Version │ Comment              │
├────────────────────┼─────────────────┼───────────────────┼──────────────────────┤
│ pg_graphql         │ 1.5             │                   │ GraphQL support      │
│ pg_stat_statements │ 1.10            │ 1.10              │ track planning stats │
└────────────────────┴─────────────────┴───────────────────┴──────────────────────┘
(2 Rows)
`);

        expect(extensions).toEqual([
            { name: "pg_graphql", version: "1.5", status: "available", description: "GraphQL support" },
            { name: "pg_stat_statements", version: "1.10", status: "1.10", description: "track planning stats" },
        ]);
    });

    test("parsePigExtensionList should ignore non-pipe banners and headers", () => {
        const extensions = parsePigExtensionList(`
Found 2 extensions
Name Status Version Categories Flags Description
pg_graphql available 1.5 analytics - GraphQL support
pg_stat_statements installed 1.10 metrics - track planning stats
`);

        expect(extensions).toEqual([
            { name: "pg_graphql", version: "1.5", status: "available", description: "GraphQL support" },
            { name: "pg_stat_statements", version: "1.10", status: "installed", description: "track planning stats" },
        ]);
    });
});
