import { describe, test, expect, spyOn } from "bun:test";
import { extensionService, type ExtensionInfo } from "../../src/services/extension.service";

/** Type-safe mock for a SQL-like DB connection */
interface MockDb {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    close: () => Promise<void>;
    unsafe?: (query: string) => Promise<unknown[]>;
}

function createMockDb(rows: unknown[] = []): MockDb {
    const fn = Object.assign(
        async () => rows,
        {
            close: async () => { },
            unsafe: async () => rows,
        }
    );
    return fn as unknown as MockDb;
}

describe("ExtensionService", () => {
    test("listExtensions should parse DB output", async () => {
        const mockRows: ExtensionInfo[] = [
            { name: "pg_stat_statements", default_version: "1.10", installed_version: "1.10", comment: "track stats", is_installed: true }
        ];

        const mockDb = createMockDb(mockRows);

        // Use bracket notation to access private method for testing
        const spy = spyOn(
            extensionService as unknown as { getTenantDb: () => any },
            "getTenantDb"
        ).mockReturnValue(mockDb);

        const extensions = await extensionService.listExtensions("testref123");
        expect(extensions).toHaveLength(1);
        expect(extensions[0].name).toBe("pg_stat_statements");

        spy.mockRestore();
    });

    test("enableExtension should return success", async () => {
        const mockDb = createMockDb();

        const spy = spyOn(
            extensionService as unknown as { getTenantDb: () => any },
            "getTenantDb"
        ).mockReturnValue(mockDb);

        const result = await extensionService.enableExtension("testref123", "postgis");
        expect(result.message).toContain("enabled");

        spy.mockRestore();
    });
});
