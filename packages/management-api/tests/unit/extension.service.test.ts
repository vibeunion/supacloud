import { beforeEach, describe, test, expect, mock } from "bun:test";

const unsafeCalls: string[] = [];

const mockDbFn = Object.assign(
    async (strings: TemplateStringsArray, extension?: string) => {
        const sql = strings.join("?");
        if (extension === "pg_graphql" || sql.includes("pg_graphql")) {
            return [{ name: "pg_graphql", default_version: "1.5", installed_version: null, comment: "GraphQL support", is_installed: false }];
        }
        return [{ name: "pg_stat_statements", default_version: "1.10", installed_version: "1.10", comment: "track stats", is_installed: true }];
    },
    {
        close: async () => { },
        unsafe: async (sql: string) => {
            unsafeCalls.push(sql);
            return [{ name: "pg_stat_statements", default_version: "1.10", installed_version: "1.10", comment: "track stats", is_installed: true }];
        },
    }
);

mock.module("../../src/db", () => ({
    getProjectDb: () => mockDbFn,
    resolveDbName: async () => "project_testref123"
}));

import { extensionService, parsePigExtensionList } from "../../src/services/extension.service";

describe("ExtensionService", () => {
    beforeEach(() => {
        unsafeCalls.length = 0;
    });

    test("listExtensions should parse DB output", async () => {
        const extensions = await extensionService.listExtensions("testref123");
        expect(extensions).toHaveLength(1);
        expect(extensions[0].name).toBe("pg_stat_statements");
    });

    test("enableExtension should return success", async () => {
        const result = await extensionService.enableExtension("testref123", "postgis");
        expect(result.name).toBe("pg_stat_statements");
        expect(result.is_installed).toBe(true);
    });

    test("enableExtension should drop GraphQL fallback before installing pg_graphql", async () => {
        await extensionService.enableExtension("testref123", "pg_graphql");

        expect(unsafeCalls[0]).toContain(
            "DROP FUNCTION IF EXISTS graphql_public.graphql(text, text, jsonb, jsonb)",
        );
        expect(unsafeCalls[0]).toContain(
            "DROP FUNCTION IF EXISTS graphql_public.graphql(text, text, jsonb)",
        );
        expect(unsafeCalls[1]).toBe('CREATE EXTENSION IF NOT EXISTS "pg_graphql" CASCADE');
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
