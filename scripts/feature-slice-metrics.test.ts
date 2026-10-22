import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureFeatureSlice } from "./feature-slice-metrics";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "feature-metrics-"));
    roots.push(root);
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Fixture");
    await writeFile(join(root, "approval.ts"), "// comment\n\nexport const approval = 1;\n");
    await writeFile(join(root, "approval.sql"), "SELECT 1;\n");
    await writeFile(join(root, "generated.ts"), "export {};\n");
    await writeFile(join(root, "fixture.test.ts"), "// test\n");
    await writeFile(join(root, "binary"), Buffer.from([0, 1]));
    await symlink("approval.ts", join(root, "link.ts"));
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "before");
    const before = git("rev-parse", "HEAD");
    await writeFile(join(root, "approval.ts"), "export const approval = 1;\n");
    git("add", "approval.ts");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "after");
    const after = git("rev-parse", "HEAD");
    return { root, before, after };
}

test("counts immutable customer snapshots with database, generated and tests separated", async () => {
    const f = await fixture();
    const files = [
        { path: "approval.ts", category: "glue" },
        { path: "approval.sql", category: "database" },
        { path: "generated.ts", category: "generated" },
        { path: "fixture.test.ts", category: "tests" },
    ];
    await writeFile(join(f.root, "approval.ts"), "dirty\ncheckout\nmust\nnot\ncount\n");
    const result = await measureFeatureSlice(f.root, {
        version: 1, before: { ref: f.before, files }, after: { ref: f.after, files },
    });
    expect(result.before.handwrittenProduction).toEqual({ files: 2, nonblankLines: 3 });
    expect(result.after.handwrittenProduction).toEqual({ files: 2, nonblankLines: 2 });
    expect(result.delta).toEqual({ handwrittenFiles: 0, handwrittenNonblankLines: -1 });
    expect(result.after.totals.generated).toEqual({ files: 1, nonblankLines: 1 });
    expect(result.after.totals.tests).toEqual({ files: 1, nonblankLines: 1 });
    expect(result.unmeasured).toContain("functional equivalence");
});

test("rejects ambiguous refs, duplicate counts, untracked paths, symlinks and binary files", async () => {
    const f = await fixture();
    const valid = { ref: f.before, files: [{ path: "approval.ts", category: "glue" }] };
    for (const before of [
        { ...valid, ref: "HEAD" },
        { ...valid, files: [] },
        { ...valid, files: [...valid.files, ...valid.files] },
        ...["../approval.ts", "/approval.ts", "missing.ts", "link.ts", "binary"].map(path => ({
            ...valid, files: [{ path, category: "glue" }],
        })),
        { ...valid, files: [{ path: "approval.ts", category: "excluded" }] },
    ]) {
        await expect(measureFeatureSlice(f.root, { version: 1, before, after: valid })).rejects.toThrow();
    }
});
