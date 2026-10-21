import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireValue } from "../../test-helpers";
import { appStarterFiles } from "./app-starter";
import { appTemplateFiles, type StarterTemplate } from "./app-starter-templates";

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function build(root: string): Promise<void> {
    const child = Bun.spawn([process.execPath, "--no-env-file", "run", "build"], {
        cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ code, errors: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, errors: "" });
}

test.each(["minimal", "http", "command", "edge"] satisfies StarterTemplate[])(
    "%s starter keeps backend bundles separate from frontend cleanup and publication",
    async (template) => {
        const files = template === "command" ? appStarterFiles("isolated-build")
            : appTemplateFiles("isolated-build", template, {
                "@supacloud/js": "^0.0.0", "@supabase/supabase-js": "^0.0.0",
            });
        const manifest = JSON.parse(requireValue(files["package.json"])) as {
            scripts: Record<string, string>;
        };
        expect(files[".gitignore"]?.split("\n")).toContain("output/supacloud/");
        expect(files[".gitignore"]?.split("\n")).not.toContain("generated/");
        expect(files["README.md"]).toContain("output/supacloud/application.js");
        expect(manifest.scripts["build"]).toContain("bun run compile && bun run typecheck && bun build");
        if (template === "command") expect(manifest.scripts["build"]).toStartWith("bun run db:check && ");

        const root = await mkdtemp(join(tmpdir(), "starter-output-"));
        roots.push(root);
        await mkdir(join(root, "src"));
        await mkdir(join(root, "scripts"));
        // Exercise the real emitted build script with only the upstream gates stubbed.
        // This fixture verifies bundling/output ownership, not compiler or DB correctness.
        for (const gate of ["compile", "typecheck", "db:check"]) {
            if (manifest.scripts[gate]) manifest.scripts[gate] = "bun --no-env-file scripts/gate.ts";
        }
        await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", private: true, scripts: manifest.scripts }));
        await writeFile(join(root, "scripts/gate.ts"), "export {};\n");
        await writeFile(join(root, "src/application.ts"), 'export const serverOnly = "BACKEND_ONLY_FIXTURE";\n');
        await mkdir(join(root, "generated"));
        await writeFile(join(root, "generated/application.ts"), "// compiler-owned sentinel\n");

        await build(root);
        const bundlePath = join(root, "output/supacloud/application.js");
        const backend = await readFile(bundlePath, "utf8");
        expect(backend).toContain("BACKEND_ONLY_FIXTURE");
        expect(await readdir(root)).not.toContain("dist");

        // Emulate a frontend build's emptyOutDir, then inspect its publication root.
        await mkdir(join(root, "dist"), { recursive: true });
        await writeFile(join(root, "dist/stale.js"), "stale");
        await rm(join(root, "dist"), { recursive: true });
        await mkdir(join(root, "dist"));
        await writeFile(join(root, "dist/index.html"), "<main>frontend</main>");
        expect(await readFile(bundlePath, "utf8")).toBe(backend);

        // The opposite build order must also leave the public frontend tree untouched.
        await build(root);
        expect(await readdir(join(root, "dist"))).toEqual(["index.html"]);
        expect(await readFile(join(root, "dist/index.html"), "utf8")).toBe("<main>frontend</main>");
        expect(await readFile(bundlePath, "utf8")).toBe(backend);
        expect(await readFile(join(root, "generated/application.ts"), "utf8")).toBe("// compiler-owned sentinel\n");
    },
);
