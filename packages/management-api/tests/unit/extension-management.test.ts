import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { readFileSync } from "node:fs";
import * as dbModule from "../../src/db";
import * as auth from "../../src/middleware/auth";
import { databaseExtensionRoutes, extensionRoutes } from "../../src/routes/extensions";
import { extensionCatalog } from "../../src/services/extension-catalog";
import { assertExtensionMutation, extensionIdentifier, extensionOperationFailure } from "../../src/services/extension-policy";
import { extensionService } from "../../src/services/extension.service";
import { registerDatabaseTools } from "../../../cli/src/shared/tools/database-tools";
import { HttpTransport } from "../../../cli/src/shared/transports/http";
import { executionMode } from "../../../cli/src/shared/execution-policy";

const calls: string[] = [];
let enabled = false;
let ready = false;
let failure: Error | null = null;
let confirmState = true;
const db = Object.assign(
    async (strings: TemplateStringsArray, name?: string) => {
        const query = strings.join("?");
        if (query.includes("AS ready")) return [{ ready }];
        if (query.includes("pg_notify")) return [];
        if (!confirmState) return [];
        return [{
            name: name || "pg_trgm",
            installed_version: enabled ? "1.6" : null,
            default_version: "1.6",
            is_installed: enabled,
            comment: "",
        }];
    },
    {
        unsafe: async (query: string) => {
            calls.push(query);
            if (failure) throw failure;
            if (query.startsWith("CREATE EXTENSION")) enabled = true;
            if (query.startsWith("DROP EXTENSION")) enabled = false;
            return [];
        },
        begin: async <T>(operation: (transaction: typeof db) => Promise<T>): Promise<T> => operation(db),
    },
);
const dbSpy = spyOn(dbModule, "getProjectDb").mockImplementation(() => db as never);
const refSpy = spyOn(dbModule, "resolveDbName").mockResolvedValue("extension_test");
const channelSpy = spyOn(dbModule, "resolvePgrstChannel").mockReturnValue("pgrst_extension_test");
const authSpy = spyOn(auth, "requireProjectOrAdminAuth").mockResolvedValue(undefined);
const app = new Elysia().use(databaseExtensionRoutes).use(extensionRoutes);

interface ToolResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
}
function cli(http: HttpTransport, readOnly = false) {
    let callback: ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
    registerDatabaseTools({
        tool(name: string, _description: string, _schema: unknown, handler: typeof callback) {
            if (name === "database") callback = handler;
        },
    }, http, { projectRef: "project_test", readOnly });
    if (!callback) throw new Error("database tool not registered");
    return callback;
}

beforeEach(() => {
    calls.length = 0;
    enabled = false;
    ready = false;
    failure = null;
    confirmState = true;
    authSpy.mockResolvedValue(undefined);
});
afterAll(() => {
    dbSpy.mockRestore();
    refSpy.mockRestore();
    channelSpy.mockRestore();
    authSpy.mockRestore();
});

describe("extension management safety", () => {
    test.each(["pg_trgm", "uuid-ossp", "pg_durable"])("accepts quoted extension identifier %s", (name) => {
        expect(extensionIdentifier(name)).toBe(name);
    });
    test.each(["", "../pg_trgm", 'pg_trgm"; DROP TABLE x;', "--help", "a".repeat(64)])("rejects invalid identifier %s", (name) => {
        expect(() => extensionIdentifier(name)).toThrow();
    });
    test.each(["pgmq", "pg_cron", "pg_durable", "pg_net", "supabase_vault", "pgsodium", "timescaledb"])("preserves state owned by %s", async (name) => {
        await expect(extensionService.disableExtension("project_test", name)).rejects.toThrow("reviewed backup");
        expect(calls).toEqual([]);
    });
    test("does not treat pgflow as a native extension", () => {
        expect(() => assertExtensionMutation("pgflow", true)).toThrow("SQL workflow component");
        expect(() => assertExtensionMutation("pgflow", false)).toThrow("SQL workflow component");
    });
    test("validates durable preload and database before enabling", async () => {
        await expect(extensionService.enableExtension("project_test", "pg_durable")).rejects.toThrow("pg_durable.database");
        expect(calls).toEqual([]);
        ready = true;
        expect((await extensionService.enableExtension("project_test", "pg_durable")).is_installed).toBe(true);
    });
    test("reads back enable/disable and never cascades deletion", async () => {
        expect((await extensionService.enableExtension("project_test", "pg_trgm")).installed_version).toBe("1.6");
        expect((await extensionService.disableExtension("project_test", "pg_trgm")).installed_version).toBeNull();
        expect(calls).toEqual([
            'CREATE EXTENSION IF NOT EXISTS "pg_trgm" CASCADE',
            'DROP EXTENSION IF EXISTS "pg_trgm" RESTRICT',
        ]);
    });
    test.each([true, false])("missing readback does not fabricate success (enable=%s)", async (enable) => {
        confirmState = false;
        const operation = enable ? extensionService.enableExtension : extensionService.disableExtension;
        await expect(operation.call(extensionService, "project_test", "pg_trgm")).rejects.toThrow("could not be confirmed");
    });
    test("maps a dependency failure without exposing raw SQL", () => {
        expect(extensionOperationFailure({ code: "2BP01", detail: "private SQL" })).toEqual({
            status: 409,
            message: "Extension is still in use. Remove or migrate dependent objects explicitly before disabling it. No dependencies were deleted.",
        });
    });
    test("catalog separates missing packages, protected data and workflow setup", () => {
        const catalog = extensionCatalog([
            { name: "pg_trgm", default_version: "1", installed_version: null, is_installed: false, comment: "" },
            { name: "pgmq", default_version: "1", installed_version: "1", is_installed: true, comment: "" },
            { name: "pg_durable", default_version: "1", installed_version: null, is_installed: false, comment: "" },
        ], { durable_ready: false, pgflow_schema: true });
        expect(catalog.find((row) => row.name === "pg_trgm")).toMatchObject({ available: true, can_enable: true });
        expect(catalog.find((row) => row.name === "pgmq")).toMatchObject({ can_disable: false });
        expect(catalog.find((row) => row.name === "vector")).toMatchObject({ available: false, can_enable: false });
        expect(catalog.find((row) => row.name === "pg_durable")).toMatchObject({ can_enable: false });
        expect(catalog.find((row) => row.name === "pgflow")).toMatchObject({ kind: "workflow", is_installed: false, can_disable: false, schema: "pgflow" });
    });
    test.each(["/database/extensions", "/extensions"])("API %s returns dependency conflict", async (path) => {
        failure = Object.assign(new Error("private SQL"), { code: "2BP01" });
        const res = await app.handle(new Request(`http://localhost/v1/projects/project_test${path}`, {
            method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "pg_trgm" }),
        }));
        expect(res.status).toBe(409);
        expect(await res.text()).not.toContain("private SQL");
        expect(calls).toEqual(['DROP EXTENSION IF EXISTS "pg_trgm" RESTRICT']);
    });
    test("API rejects a noncanonical pgflow schema before SQL execution", async () => {
        const res = await app.handle(new Request("http://localhost/v1/projects/project_test/database/extensions", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "pgflow", schema: "custom" }),
        }));
        expect(res.status).toBe(400);
        expect(calls).toEqual([]);
    });
    test("catalog has the same project authorization boundary", async () => {
        authSpy.mockResolvedValueOnce({ status: 403, body: { error: "Not authorized" } });
        const res = await app.handle(new Request("http://localhost/v1/projects/project_test/database/extensions/catalog"));
        expect(res.status).toBe(403);
    });
});

describe("extension CLI", () => {
    test.each(["enable_extension", "disable_extension"])("%s is classified as a write", (action) => {
        expect(executionMode("database", action, {})).toBe("write");
    });
    test("catalog is classified as a read", () => {
        expect(executionMode("database", "extension_catalog", {})).toBe("read");
    });
    test.each(["enable_extension", "disable_extension"])("%s is blocked in read-only mode", async (action) => {
        const http = new HttpTransport({ baseUrl: "http://localhost", token: "test" });
        const result = await cli(http, true)({ action, extension: "pg_trgm" });
        expect(result.isError).toBe(true);
    });
    test.each(["enable_extension", "disable_extension"])("%s uses the project extension API", async (action) => {
        const http = new HttpTransport({ baseUrl: "http://localhost", token: "test" });
        const enabling = action === "enable_extension";
        const mutation = spyOn(http, enabling ? "postReleaseMutation" : "deleteReleaseMutation").mockResolvedValue({
            ok: true, status: 200,
            data: { name: "pg_trgm", is_installed: enabling, installed_version: enabling ? "1.6" : null },
        });
        try {
            const result = await cli(http)({ action, extension: "pg_trgm" });
            expect(result.isError).not.toBe(true);
            expect(mutation).toHaveBeenCalledWith("/v1/projects/project_test/database/extensions", { name: "pg_trgm" });
        } finally {
            mutation.mockRestore();
        }
    });
    test.each([null, {}, { name: "vector", is_installed: true, installed_version: "1" }])("rejects malformed success receipt %j", async (data) => {
        const http = new HttpTransport({ baseUrl: "http://localhost", token: "test" });
        const mutation = spyOn(http, "postReleaseMutation").mockResolvedValue({ ok: true, status: 200, data });
        try {
            expect((await cli(http)({ action: "enable_extension", extension: "pg_trgm" })).isError).toBe(true);
        } finally {
            mutation.mockRestore();
        }
    });
    test("rejects invalid refs before dispatch", async () => {
        const http = new HttpTransport({ baseUrl: "http://localhost", token: "test" });
        await expect(cli(http)({ action: "enable_extension", extension: "pg_trgm", ref: "../other" })).rejects.toThrow();
    });
    test("console uses API, real capabilities and invalidation instead of arbitrary SQL", () => {
        const source = readFileSync(new URL("../../../web-console/src/routes/project/[ref]/database/extensions/+page.svelte", import.meta.url), "utf8");
        expect(source).not.toContain("CREATE EXTENSION");
        expect(source).not.toContain("DROP EXTENSION");
        expect(source).not.toContain("setQueryData");
        expect(source).toContain("invalidateQueries");
        expect(source).toContain("!ext.can_enable");
        expect(source).toContain('method: isEnabling ? "POST" : "DELETE"');
    });
});
