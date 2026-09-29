import { afterEach, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyScaffoldWrites, planScaffoldWrites } from "./app-scaffold-writes";

const roots: string[] = [];
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "scaffold-writes-"));
    roots.push(root);
    return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("planning is immutable, deterministic and writes no files or directories", async () => {
    const root = await fixture();
    const files = [{ path: "src/b.ts", content: "b" }, { path: "src/a.ts", content: "a" }];
    const plan = await planScaffoldWrites(root, files);
    files[0]!.content = "changed";
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.writes)).toBe(true);
    expect(plan.writes.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await readdir(root)).toEqual([]);
    await applyScaffoldWrites(plan);
    expect(await readFile(join(root, "src/b.ts"), "utf8")).toBe("b");
    expect(await readdir(root)).toEqual(["src"]);
});

test("a conflict anywhere rejects the entire plan before creating earlier files", async () => {
    const root = await fixture();
    await writeFile(join(root, "taken.ts"), "user source");
    await expect(planScaffoldWrites(root, [
        { path: "src/first.ts", content: "first" }, { path: "taken.ts", content: "replacement" },
    ])).rejects.toMatchObject({ code: "SCAFFOLD_EXISTS" });
    expect(await readdir(root)).toEqual(["taken.ts"]);
    expect(await readFile(join(root, "taken.ts"), "utf8")).toBe("user source");
});

for (const path of ["../outside.ts", "/absolute.ts", "C:/outside.ts", "src\\outside.ts", "src/CON.ts", "src/a:stream", ".git/config", "src/a.ts "]) {
    test(`rejects non-project or non-portable target ${path}`, async () => {
        const root = await fixture();
        await expect(planScaffoldWrites(root, [{ path, content: "no" }])).rejects.toMatchObject({ code: "SCAFFOLD_PATH_INVALID" });
        expect(await readdir(root)).toEqual([]);
    });
}

for (const paths of [["a.ts", "a.ts"], ["a.ts", "A.ts"], ["a", "a/b.ts"]]) {
    test(`rejects overlapping plan ${paths.join(", ")}`, async () => {
        const root = await fixture();
        await expect(planScaffoldWrites(root, paths.map(path => ({ path, content: "no" }))))
            .rejects.toMatchObject({ code: "SCAFFOLD_PATH_CONFLICT" });
    });
}

test("a dangling target symlink is not mistaken for an absent file", async () => {
    if (process.platform === "win32") return; // Creating arbitrary symlinks requires Windows privileges.
    const root = await fixture();
    await symlink(join(root, "missing"), join(root, "link.ts"));
    await expect(planScaffoldWrites(root, [{ path: "link.ts", content: "no", overwrite: true }]))
        .rejects.toMatchObject({ code: "SCAFFOLD_SYMLINK" });
});

test("symlinked ancestors cannot redirect generation outside the project", async () => {
    const root = await fixture();
    const outside = await fixture();
    await symlink(outside, join(root, "src"), process.platform === "win32" ? "junction" : "dir");
    await expect(planScaffoldWrites(root, [{ path: "src/resource/file.ts", content: "no" }]))
        .rejects.toMatchObject({ code: "SCAFFOLD_SYMLINK" });
    expect(await readdir(outside)).toEqual([]);
});

test("force refuses hard-linked user files", async () => {
    const root = await fixture();
    await writeFile(join(root, "original.ts"), "original");
    await link(join(root, "original.ts"), join(root, "linked.ts"));
    await expect(planScaffoldWrites(root, [{ path: "linked.ts", content: "no", overwrite: true }]))
        .rejects.toMatchObject({ code: "SCAFFOLD_PATH_INVALID" });
    expect(await readFile(join(root, "original.ts"), "utf8")).toBe("original");
});

test("force replaces a regular file and cleans all temporary files", async () => {
    const root = await fixture();
    await writeFile(join(root, "a.ts"), "old");
    const plan = await planScaffoldWrites(root, [{ path: "a.ts", content: "new", overwrite: true }]);
    await applyScaffoldWrites(plan);
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("new");
    expect(await readdir(root)).toEqual(["a.ts"]);
});

test("registration edits reject a changed source before any output is created", async () => {
    const root = await fixture();
    await writeFile(join(root, "app.module.ts"), "old");
    const plan = await planScaffoldWrites(root, [
        { path: "feature/new.ts", content: "new" },
        { path: "app.module.ts", content: "registered", expected: "old" },
    ]);
    await writeFile(join(root, "app.module.ts"), "concurrent edit");
    await expect(applyScaffoldWrites(plan)).rejects.toMatchObject({ code: "SCAFFOLD_CHANGED" });
    expect(await readdir(root)).toEqual(["app.module.ts"]);
    expect(await readFile(join(root, "app.module.ts"), "utf8")).toBe("concurrent edit");
});

test("a target created after planning is not overwritten", async () => {
    const root = await fixture();
    const plan = await planScaffoldWrites(root, [{ path: "new.ts", content: "generated" }]);
    await writeFile(join(root, "new.ts"), "user");
    await expect(applyScaffoldWrites(plan)).rejects.toMatchObject({ code: "SCAFFOLD_CHANGED" });
    expect(await readFile(join(root, "new.ts"), "utf8")).toBe("user");
});

test("generator lock is respected rather than deleted or stolen", async () => {
    const root = await fixture();
    const plan = await planScaffoldWrites(root, [{ path: "new.ts", content: "generated" }]);
    await writeFile(join(root, ".supacloud-generate.lock"), "another operation");
    await expect(applyScaffoldWrites(plan)).rejects.toMatchObject({ code: "SCAFFOLD_BUSY" });
    expect(await readdir(root)).toEqual([".supacloud-generate.lock"]);
});

test("a handled publication failure rolls back preceding files", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = await fixture();
    await mkdir(join(root, "z-readonly"));
    const plan = await planScaffoldWrites(root, [
        { path: "a-new/first.ts", content: "generated" },
        { path: "z-readonly/last.ts", content: "cannot publish" },
    ]);
    await chmod(join(root, "z-readonly"), 0o555);
    try {
        await expect(applyScaffoldWrites(plan)).rejects.toThrow();
        expect(await readdir(root)).toEqual(["z-readonly"]);
    } finally { await chmod(join(root, "z-readonly"), 0o755); }
});
