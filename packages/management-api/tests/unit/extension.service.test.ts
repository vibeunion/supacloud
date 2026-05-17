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

import { extensionService } from "../../src/services/extension.service";

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
});
