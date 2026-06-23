import { describe, expect, test } from "bun:test";
import { SUBCOMMANDS, buildHelp, resolveSubpackageEntry } from "./index";

describe("supacloud dispatcher", () => {
    test("exposes cli and admin subcommands", () => {
        expect(Object.keys(SUBCOMMANDS).sort()).toEqual(["admin", "cli"]);
        expect(SUBCOMMANDS.cli.pkg).toBe("@supacloud/cli");
        expect(SUBCOMMANDS.admin.pkg).toBe("@supacloud/admin");
    });

    test("help lists both subcommands and usage", () => {
        const help = buildHelp();
        expect(help).toContain("supacloud <子命令>");
        expect(help).toContain("cli");
        expect(help).toContain("admin");
        expect(help).toContain("@supacloud/cli");
        expect(help).toContain("@supacloud/admin");
    });

    test("resolveSubpackageEntry returns a path for an installed package", () => {
        // 自身模块必然可解析；验证 resolve 逻辑不抛错
        const entry = resolveSubpackageEntry("bun");
        expect(typeof entry).toBe("string");
    });

    test("resolveSubpackageEntry returns null for a missing package", () => {
        const entry = resolveSubpackageEntry("@supacloud/__definitely_not_a_pkg__");
        expect(entry).toBeNull();
    });
});
