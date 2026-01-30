import { describe, test, expect, spyOn } from "bun:test";
import { ExtensionService } from "../../src/services/extension.service";
import { shellService } from "../../src/services/shell.service";

describe("ExtensionService", () => {
    test("listExtensions should parse JSON output", async () => {
        const mockData = [
            { name: "pg_stat_statements", is_installed: true, default_version: "1.10", installed_version: "1.10", comment: "track stats" }
        ];
        const spy = spyOn(shellService, "execute").mockResolvedValue({
            success: true,
            output: JSON.stringify(mockData)
        });

        const extensions = await ExtensionService.listExtensions("test-ref");
        expect(extensions).toHaveLength(1);
        expect(extensions[0].name).toBe("pg_stat_statements");
        expect(spy).toHaveBeenCalledWith("extension_manager.sh", ["list", "supa_test-ref"]);

        spy.mockRestore();
    });

    test("enableExtension should call enable command", async () => {
        const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });

        const result = await ExtensionService.enableExtension("test-ref", "postgis");
        expect(result.message).toContain("成功启用");
        expect(spy).toHaveBeenCalledWith("extension_manager.sh", ["enable", "supa_test-ref", "postgis"]);

        spy.mockRestore();
    });
});
