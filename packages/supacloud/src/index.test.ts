import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, symlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    SUBCOMMANDS,
    buildHelp,
    buildLatestMetadataUrl,
    createLaunchPlan,
    fetchLatestVersion,
    isAutoUpdateDisabled,
    isMainModule,
    resolveSubpackageEntry,
} from "./index";

describe("supacloud dispatcher", () => {
    test("publishes only the collision-free supacloudctl executable", () => {
        const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        expect(packageJson.bin).toEqual({ supacloudctl: "dist/index.js" });
        expect(packageJson.bin.supacloud).toBeUndefined();
    });

    test("exposes cli and admin subcommands", () => {
        expect(Object.keys(SUBCOMMANDS).sort()).toEqual(["admin", "cli"]);
        expect(SUBCOMMANDS.cli.pkg).toBe("@supacloud/cli");
        expect(SUBCOMMANDS.cli.bin).toBe("supacloud-cli");
        expect(SUBCOMMANDS.admin.pkg).toBe("@supacloud/admin");
        expect(SUBCOMMANDS.admin.bin).toBe("supacloud-admin");
    });

    test("help lists both subcommands and usage", () => {
        const help = buildHelp();
        expect(help).toContain("supacloudctl <子命令>");
        expect(help).not.toContain("supacloud <子命令>");
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

    test("isMainModule treats npm bin symlinks as the main script", () => {
        const dir = mkdtempSync(join(tmpdir(), "supacloud-main-module-"));
        const target = join(dir, "dist-index.js");
        const link = join(dir, "supacloudctl");
        const fd = openSync(target, "w");
        writeSync(fd, "#!/usr/bin/env node\n");
        closeSync(fd);
        symlinkSync(target, link);

        expect(isMainModule(pathToFileURL(target).href, link)).toBe(true);
    });

    test("buildLatestMetadataUrl encodes scoped package names", () => {
        expect(buildLatestMetadataUrl("@supacloud/cli", "https://registry.npmjs.org")).toBe(
            "https://registry.npmjs.org/@supacloud%2Fcli/latest",
        );
    });

    test("fetchLatestVersion parses registry latest metadata", async () => {
        const latest = await fetchLatestVersion(
            "@supacloud/cli",
            {},
            async (input, init) => {
                expect(input).toBe("https://registry.npmjs.org/@supacloud%2Fcli/latest");
                expect(init?.headers).toEqual({ Accept: "application/json" });
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ version: "0.8.0" }),
                };
            },
        );

        expect(latest).toBe("0.8.0");
    });

    test("isAutoUpdateDisabled honors opt-out env vars", () => {
        expect(isAutoUpdateDisabled({})).toBe(false);
        expect(isAutoUpdateDisabled({ SUPACLOUD_NO_AUTO_UPDATE: "1" })).toBe(true);
        expect(isAutoUpdateDisabled({ SUPACLOUD_NO_AUTO_UPDATE: "false" })).toBe(false);
        expect(isAutoUpdateDisabled({ SUPACLOUD_AUTO_UPDATE: "0" })).toBe(true);
    });

    test("createLaunchPlan only reports a newer package and still runs the installed version", async () => {
        const plan = await createLaunchPlan(SUBCOMMANDS.cli, ["status"], {
            env: {},
            fetchLatest: async () => "0.8.0",
            resolveInstalled: () => ({ entry: "/local/cli.js", version: "0.7.0" }),
            nodePath: "/usr/bin/node",
        });

        expect(plan).toEqual({
            mode: "local",
            command: "/usr/bin/node",
            args: ["/local/cli.js", "status"],
            shell: false,
            updateNotice: "@supacloud/cli 0.8.0 可用；当前固定使用已安装版本 0.7.0。请显式运行包管理器更新。",
        });
    });

    test("createLaunchPlan uses local package when registry is not newer", async () => {
        const plan = await createLaunchPlan(SUBCOMMANDS.admin, ["status"], {
            env: {},
            fetchLatest: async () => "0.2.0",
            resolveInstalled: () => ({ entry: "/local/admin.js", version: "0.2.0" }),
            nodePath: "/usr/bin/node",
        });

        expect(plan).toEqual({
            mode: "local",
            command: "/usr/bin/node",
            args: ["/local/admin.js", "status"],
            shell: false,
        });
    });

    test("createLaunchPlan falls back to local package when registry is unreachable", async () => {
        const plan = await createLaunchPlan(SUBCOMMANDS.cli, ["project", "get"], {
            env: {},
            fetchLatest: async () => null,
            resolveInstalled: () => ({ entry: "/local/cli.js", version: "0.7.0" }),
            nodePath: "/usr/bin/node",
        });

        expect(plan.mode).toBe("local");
        expect(plan.args).toEqual(["/local/cli.js", "project", "get"]);
    });

    test("createLaunchPlan skips registry lookup when auto-update is disabled", async () => {
        let fetchCalls = 0;
        const plan = await createLaunchPlan(SUBCOMMANDS.cli, ["status"], {
            env: { SUPACLOUD_NO_AUTO_UPDATE: "1" },
            fetchLatest: async () => {
                fetchCalls += 1;
                return "9.9.9";
            },
            resolveInstalled: () => ({ entry: "/local/cli.js", version: "0.7.0" }),
            nodePath: "/usr/bin/node",
        });

        expect(fetchCalls).toBe(0);
        expect(plan.mode).toBe("local");
    });

    test("createLaunchPlan reports a clear error when latest and local package are unavailable", async () => {
        let message = "";
        try {
            await createLaunchPlan(SUBCOMMANDS.cli, ["status"], {
                env: {},
                fetchLatest: async () => null,
                resolveInstalled: () => null,
            });
        } catch (err) {
            message = err instanceof Error ? err.message : String(err);
        }

        expect(message).toContain("@supacloud/cli 未安装");
    });
});
