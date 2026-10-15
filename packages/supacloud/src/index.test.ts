import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, symlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    SUBCOMMANDS,
    buildHelp,
    buildLatestMetadataUrl,
    checkUpdate,
    createLaunchPlan,
    fetchLatestVersion,
    isAutoUpdateDisabled,
    isAutoUpdateEnabled,
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
        expect(SUBCOMMANDS.cli.bin).toBe("supacloud");
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
        expect(help).toContain("check-update");
        expect(help).toContain("普通分发默认不访问 npm");
    });

    test("resolveSubpackageEntry returns a path for an installed package", () => {
        // Own module is guaranteed to resolve; verify resolve logic does not throw
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

    test("automatic update checks are opt-in", () => {
        expect(isAutoUpdateEnabled({})).toBe(false);
        expect(isAutoUpdateEnabled({ SUPACLOUD_AUTO_UPDATE: "1" })).toBe(true);
        expect(isAutoUpdateEnabled({ SUPACLOUD_AUTO_UPDATE: "true" })).toBe(true);
        expect(isAutoUpdateEnabled({ SUPACLOUD_AUTO_UPDATE: "1", SUPACLOUD_NO_AUTO_UPDATE: "1" })).toBe(false);
    });

    test("createLaunchPlan only reports a newer package and still runs the installed version", async () => {
        const plan = await createLaunchPlan(SUBCOMMANDS.cli, ["status"], {
            env: { SUPACLOUD_AUTO_UPDATE: "1" },
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

    test("createLaunchPlan does not claim an installed package is missing when its version metadata is unreadable", async () => {
        const plan = await createLaunchPlan(SUBCOMMANDS.cli, ["status"], {
            env: { SUPACLOUD_AUTO_UPDATE: "1" },
            fetchLatest: async () => "0.8.0",
            resolveInstalled: () => ({ entry: "/local/cli.js", version: null }),
        });

        expect(plan.updateNotice).toContain("已安装版本无法识别");
        expect(plan.updateNotice).not.toContain("请先通过包管理器显式安装");
    });

    test("createLaunchPlan uses local package when registry is not newer", async () => {
        const plan = await createLaunchPlan(SUBCOMMANDS.admin, ["status"], {
            env: { SUPACLOUD_AUTO_UPDATE: "1" },
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
            env: { SUPACLOUD_AUTO_UPDATE: "1" },
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

    test("createLaunchPlan is local-only by default", async () => {
        let fetchCalls = 0;
        const plan = await createLaunchPlan(SUBCOMMANDS.cli, ["status"], {
            env: {},
            fetchLatest: async () => {
                fetchCalls += 1;
                return "9.9.9";
            },
            resolveInstalled: () => ({ entry: "/local/cli.js", version: "0.7.0" }),
            nodePath: "/usr/bin/node",
        });

        expect(fetchCalls).toBe(0);
        expect(plan.updateNotice).toBeUndefined();
        expect(plan.args).toEqual(["/local/cli.js", "status"]);
    });

    test("checkUpdate explicitly queries the registry", async () => {
        let fetchCalls = 0;
        const result = await checkUpdate(SUBCOMMANDS.cli, {
            env: {},
            fetchLatest: async () => {
                fetchCalls += 1;
                return "0.8.0";
            },
            resolveInstalled: () => ({ entry: "/local/cli.js", version: "0.7.0" }),
        });

        expect(fetchCalls).toBe(1);
        expect(result).toEqual({
            packageName: "@supacloud/cli",
            currentVersion: "0.7.0",
            latestVersion: "0.8.0",
            status: "update_available",
        });
    });

    test("checkUpdate reports registry and installation failures", async () => {
        const unavailable = await checkUpdate(SUBCOMMANDS.admin, {
            fetchLatest: async () => null,
            resolveInstalled: () => ({ entry: "/local/admin.js", version: "0.4.0" }),
        });
        const missing = await checkUpdate(SUBCOMMANDS.cli, {
            fetchLatest: async () => "9.9.9",
            resolveInstalled: () => null,
        });

        expect(unavailable.status).toBe("registry_unavailable");
        expect(missing.status).toBe("not_installed");
    });

    test("createLaunchPlan reports a clear error when latest and local package are unavailable", async () => {
        let message = "";
        let fetchCalls = 0;
        try {
            await createLaunchPlan(SUBCOMMANDS.cli, ["status"], {
                env: {},
                fetchLatest: async () => {
                    fetchCalls += 1;
                    return null;
                },
                resolveInstalled: () => null,
            });
        } catch (err) {
            message = err instanceof Error ? err.message : String(err);
        }

        expect(message).toContain("@supacloud/cli 未安装");
        expect(fetchCalls).toBe(0);
    });
});

// Exercise the executable boundary, not just the launch-plan helpers under Bun.
test("installed supacloudctl selects Bun for both child CLIs and preserves argv and exit codes", async () => {
    const { chmodSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const root = mkdtempSync(join(tmpdir(), "supacloud-installed-bin-"));
    try {
        writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
        const dist = join(root, "dist");
        const build = await Bun.build({
            entrypoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
            outdir: dist,
            target: "node",
        });
        expect(build.success).toBe(true);
        const entry = join(dist, "index.js");
        expect(readFileSync(entry, "utf8").split("\n", 1)[0]).toBe("#!/usr/bin/env bun");
        chmodSync(entry, 0o755);

        // Local leaf-package fixtures prove which runtime and argv the dispatcher
        // actually forwards without installing or contacting a registry.
        for (const subcommand of ["cli", "admin"]) {
            const packageRoot = join(root, "node_modules", "@supacloud", subcommand);
            mkdirSync(packageRoot, { recursive: true });
            writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
                name: `@supacloud/${subcommand}`, version: "1.0.0", type: "module", main: "index.js",
            }));
            writeFileSync(join(packageRoot, "index.js"), `
                const args = process.argv.slice(2);
                console.log(JSON.stringify({
                    subcommand: ${JSON.stringify(subcommand)},
                    bun: typeof Bun !== "undefined",
                    args,
                }));
                process.exitCode = args.includes("--fail") ? 23 : 0;
            `);
        }

        const bin = join(root, "bin");
        mkdirSync(bin);
        symlinkSync(process.execPath, join(bin, "bun"));
        const linkedEntry = join(bin, "supacloudctl");
        symlinkSync(entry, linkedEntry);
        const env = { PATH: bin, HOME: root, SUPACLOUD_NO_AUTO_UPDATE: "1" };
        const invoke = (args: string[]) => spawnSync(linkedEntry, args, {
            cwd: root, env, encoding: "utf8", timeout: 5_000,
        });

        const help = invoke(["--help"]);
        expect(help.error).toBeUndefined();
        expect(help.status).toBe(0);
        expect(help.stderr).toContain("supacloudctl");
        for (const subcommand of ["cli", "admin"]) {
            for (const fail of [false, true]) {
                const args = ["status", "--label=a b;not-a-shell", ...(fail ? ["--fail"] : [])];
                const result = invoke([subcommand, ...args]);
                expect(result.error).toBeUndefined();
                expect(result.status).toBe(fail ? 23 : 0);
                expect(result.stderr).toBe("");
                const payload: unknown = JSON.parse(result.stdout);
                expect(payload).toEqual({ subcommand, bun: true, args });
            }
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}, 30_000);
