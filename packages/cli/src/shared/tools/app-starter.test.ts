import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appStarterFiles, initializeAppProject } from "./app-starter";

const roots: string[] = [];
async function directory(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "app-starter-"));
    roots.push(root);
    return root;
}
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("initialization does not touch an existing project or its secrets", async () => {
    const root = await directory();
    await writeFile(join(root, ".env"), "SENTINEL=synthetic\n");
    await expect(initializeAppProject({ root, name: "example" })).rejects.toThrow("empty directory");
    expect(await readdir(root)).toEqual([".env"]);
    expect(await readFile(join(root, ".env"), "utf8")).toBe("SENTINEL=synthetic\n");
});

test("initialization permits an existing git directory and refuses subsequent overwrites", async () => {
    const root = await directory();
    await mkdir(join(root, ".git"));
    const result = await initializeAppProject({ root, name: "example" });
    expect(result.files).toContain("scripts/environment.ts");
    await expect(initializeAppProject({ root, name: "example" })).rejects.toThrow("empty directory");
});

test("initialization rejects unsafe names and symlink roots", async () => {
    const root = await directory();
    for (const name of ["../escape", "not valid", "BadName", "a".repeat(101)]) {
        await expect(initializeAppProject({ root, name })).rejects.toThrow("kebab-case");
    }
    expect(await readdir(root)).toEqual([]);
    const link = join(await directory(), "link");
    await symlink(root, link);
    await expect(initializeAppProject({ root: link, name: "example" })).rejects.toThrow("real directory");
    expect(await readdir(root)).toEqual([]);
});

test("compiler dependencies and demo adapters stay outside the production entry", () => {
    const files = appStarterFiles("example");
    const manifest = JSON.parse(files["package.json"]);
    expect(manifest.dependencies["@supacloud/compiler"]).toBeUndefined();
    expect(manifest.devDependencies["@supacloud/compiler"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(files["src/application.ts"]).not.toContain("@supacloud/compiler");
    expect(files["src/application.ts"]).not.toContain("createMemorySandbox");
    expect(files[".gitignore"]).toContain("!.env.test");
    expect(files[".gitignore"]).not.toContain("generated");
});

test("the generated environment test suite runs without installing dependencies", async () => {
    const root = await directory();
    const files = appStarterFiles("example");
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "tests"));
    for (const name of ["scripts/environment.ts", "tests/environment.test.ts", "bunfig.toml"]) {
        await writeFile(join(root, name), files[name]);
    }
    const child = Bun.spawn([process.execPath, "--no-env-file", "test"], {
        cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ status, output: status === 0 ? "" : stdout + stderr }).toEqual({ status: 0, output: "" });
});

test("starter documents external unified identity without adding an identity runtime", () => {
    const files = appStarterFiles("example");
    const readme = files["README.md"];
    expect(readme).toContain("use SupAuth as the external user center");
    expect(readme).toContain("exports createSupAuthApp(identity, adapters)");
    expect(files["src/application.ts"]).toContain("requestContext: createSupAuthRequestContext(identity)");
    expect(readme).toContain("configured issuer and audience");
    expect(readme).toContain("application-local membership");
    expect(readme).toContain("never fall back to the demo identity");
    expect(readme).toContain("Recheck business authorization on idempotent replay");
    expect(readme).toContain("tests do not require SupAuth credentials");
    const manifest = JSON.parse(files["package.json"]);
    expect(Object.keys(manifest.dependencies).some((name) => name.startsWith("@supauth/"))).toBe(false);
});
