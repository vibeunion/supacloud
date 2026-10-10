import { expect, test } from "bun:test";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import adminMetadata from "../package.json" with { type: "json" };
import cliMetadata from "../../cli/package.json" with { type: "json" };

test("Admin preparation refreshes public runtime files after a clean file-dependency install", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-admin-runtime-"));
    const cliSource = join(import.meta.dir, "../../cli");
    const cli = join(root, "cli");
    const admin = join(root, "admin");
    const run = (args: string[], cwd = admin): void => {
        const result = Bun.spawnSync([process.execPath, "--no-env-file", ...args], {
            cwd, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(root, "empty-cache") },
            stdout: "pipe", stderr: "pipe",
        });
        if (result.exitCode !== 0) {
            throw new Error(`${args.join(" ")} failed:\n${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`);
        }
    };
    try {
        await mkdir(admin, { recursive: true });
        for (const file of [
            "src/tool-runtime.ts", "src/shared/schema.ts", "src/shared/tool-server.ts",
            "tsconfig.json", "tsconfig.tool-runtime.json",
        ]) {
            const destination = join(cli, file);
            await mkdir(dirname(destination), { recursive: true });
            await copyFile(join(cliSource, file), destination);
        }
        await symlink(join(cliSource, "node_modules"), join(cli, "node_modules"),
            process.platform === "win32" ? "junction" : "dir");
        await cp(join(cliSource, "node_modules/typebox"), join(root, "typebox"), {
            recursive: true, dereference: true,
        });
        await writeFile(join(cli, "package.json"), JSON.stringify({
            name: cliMetadata.name,
            version: cliMetadata.version,
            type: cliMetadata.type,
            exports: { "./tool-runtime": cliMetadata.exports["./tool-runtime"] },
            files: ["dist"],
            scripts: { "build:tool-runtime": cliMetadata.scripts["build:tool-runtime"] },
        }));
        await writeFile(join(admin, "package.json"), JSON.stringify({
            name: "admin-runtime-preparation-fixture",
            type: "module",
            dependencies: { "@supacloud/cli": "file:../cli", typebox: "file:../typebox" },
            scripts: {
                "prepare:tool-runtime": adminMetadata.scripts["prepare:tool-runtime"],
                pretypecheck: adminMetadata.scripts.pretypecheck,
                prebuild: adminMetadata.scripts.prebuild,
            },
        }));
        run(["install", "--offline", "--ignore-scripts"]);
        const lockfile = await readFile(join(admin, "bun.lock"), "utf8");
        const installed = join(admin, "node_modules/@supacloud/cli/dist");
        expect(existsSync(join(installed, "tool-runtime.d.ts"))).toBe(false);
        run(["run", "pretypecheck"]);
        expect(existsSync(join(installed, "tool-runtime.d.ts"))).toBe(true);
        expect(await readFile(join(admin, "bun.lock"), "utf8")).toBe(lockfile);
        run(["--input-type=module", "--eval", `
import {parseToolArguments, stringEnum} from "@supacloud/cli/tool-runtime";
if (parseToolArguments({action: stringEnum(["read"])}, {action: "read"}).action !== "read") {
    throw new Error("Public tool runtime was not refreshed");
}`]);
        await writeFile(join(admin, "consumer.mts"), `
import {registerTool, stringEnum, type ToolServer} from "@supacloud/cli/tool-runtime";
const server: ToolServer = {tool() {}};
registerTool(server, "read", "", {action: stringEnum(["read"])}, async ({action}) => {
    const exact: "read" = action;
    return {content: [{type: "text", text: exact}]};
});
`);
        const types = Bun.spawnSync([join(cliSource, "node_modules/.bin/tsc"), "--noEmit",
            "--strict", "--skipLibCheck", "--target", "ES2022",
            "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.mts"], {
            cwd: admin, stdout: "pipe", stderr: "pipe",
        });
        expect({
            exitCode: types.exitCode,
            diagnostics: new TextDecoder().decode(types.stdout) + new TextDecoder().decode(types.stderr),
        }).toEqual({ exitCode: 0, diagnostics: "" });
        run(["run", "prebuild"]);
        expect(await readFile(join(admin, "bun.lock"), "utf8")).toBe(lockfile);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}, { timeout: 60_000 });
