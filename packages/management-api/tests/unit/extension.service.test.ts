import { describe, test, expect, spyOn } from "bun:test";
import { extensionService, ExtensionInfo } from "../../src/services/extension.service";

describe("ExtensionService", () => {
    test("listExtensions should parse DB output", async () => {
        const mockRows: ExtensionInfo[] = [
            { name: "pg_stat_statements", default_version: "1.10", installed_version: "1.10", comment: "track stats", is_installed: true }
        ];
        
        const mockDb = Object.assign(
            async () => mockRows,
            { close: async () => { } }
        ) as any;
        
        const spy = spyOn(extensionService as any, "getTenantDb").mockReturnValue(mockDb);

        const extensions = await extensionService.listExtensions("testref123");
        expect(extensions).toHaveLength(1);
        expect(extensions[0].name).toBe("pg_stat_statements");

        spy.mockRestore();
    });

    test("enableExtension should return success", async () => {
        const mockDb = Object.assign(
            async () => [],
            { close: async () => { }, unsafe: async () => [] }
        ) as any;
        
        const spy = spyOn(extensionService as any, "getTenantDb").mockReturnValue(mockDb);

        const result = await extensionService.enableExtension("testref123", "postgis");
        expect(result.message).toContain("enabled");

        spy.mockRestore();
    });
});
