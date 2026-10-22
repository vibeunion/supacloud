import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const categories = ["business", "database", "config", "glue", "generated", "tests"] as const;
type Category = typeof categories[number];
type Inventory = { ref: string; files: { path: string; category: Category }[] };
type Entry = Inventory["files"][number] & { blob: string; nonblankLines: number };

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inventory(value: unknown): Inventory {
    if (!record(value) || Object.keys(value).some(key => !["ref", "files"].includes(key))
        || typeof value["ref"] !== "string" || !/^[a-f0-9]{40}$/.test(value["ref"])
        || !Array.isArray(value["files"]) || value["files"].length === 0 || value["files"].length > 2000) {
        throw new Error("Expected a full commit SHA and 1-2000 explicitly classified files");
    }
    const files = value["files"].map(item => {
        if (!record(item) || Object.keys(item).some(key => !["path", "category"].includes(key))
            || typeof item["path"] !== "string" || !/^[A-Za-z0-9_. /-]+$/.test(item["path"])
            || item["path"].startsWith("/") || item["path"].startsWith("-")
            || item["path"].split("/").some(part => !part || part === "." || part === "..")
            || typeof item["category"] !== "string" || !categories.some(category => category === item["category"])) {
            throw new Error("Invalid file path or category");
        }
        return { path: item["path"], category: item["category"] as Category };
    });
    if (new Set(files.map(item => item.path)).size !== files.length) throw new Error("Duplicate inventory path");
    return { ref: value["ref"], files };
}

async function git(root: string, args: string[]): Promise<Buffer> {
    const result = await execute("git", ["-C", root, ...args], {
        encoding: "buffer", maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
}

async function measure(root: string, input: Inventory) {
    const commit = (await git(root, ["rev-parse", "--verify", `${input.ref}^{commit}`])).toString().trim();
    if (commit !== input.ref) throw new Error("Inventory ref must identify a commit, not a tag object");
    const entries: Entry[] = [];
    for (const file of [...input.files].sort((a, b) => a.path.localeCompare(b.path))) {
        const tree = (await git(root, ["ls-tree", "-z", commit, "--", `:(literal)${file.path}`])).toString();
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(tree);
        if (!match || match[3] !== file.path) throw new Error(`Expected a tracked regular file: ${file.path}`);
        const bytes = await git(root, ["cat-file", "blob", match[2]!]);
        if (bytes.includes(0)) throw new Error(`Binary file is not source: ${file.path}`);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        entries.push({ ...file, blob: match[2]!, nonblankLines: text.split(/\r?\n/).filter(line => line.trim()).length });
    }
    const totals = Object.fromEntries(categories.map(category => {
        const selected = entries.filter(file => file.category === category);
        return [category, { files: selected.length, nonblankLines: selected.reduce((sum, file) => sum + file.nonblankLines, 0) }];
    })) as Record<Category, { files: number; nonblankLines: number }>;
    const handwritten = entries.filter(file => file.category !== "generated" && file.category !== "tests");
    return {
        commit, files: entries, totals,
        handwrittenProduction: {
            files: handwritten.length,
            nonblankLines: handwritten.reduce((sum, file) => sum + file.nonblankLines, 0),
        },
    };
}

/** Count reviewed customer inventories from Git objects, never the dirty checkout. */
export async function measureFeatureSlice(root: string, value: unknown) {
    if (!record(value) || value["version"] !== 1
        || Object.keys(value).some(key => !["version", "before", "after"].includes(key))) {
        throw new Error("Expected version 1, before and after inventories");
    }
    const before = await measure(root, inventory(value["before"]));
    const after = await measure(root, inventory(value["after"]));
    return {
        version: 1,
        evidence: "git-source-counts-for-reviewed-inventory-not-business-acceptance",
        rule: "nonblank physical UTF-8 lines including comments; generated code and tests reported separately",
        before, after,
        delta: {
            handwrittenFiles: after.handwrittenProduction.files - before.handwrittenProduction.files,
            handwrittenNonblankLines: after.handwrittenProduction.nonblankLines - before.handwrittenProduction.nonblankLines,
        },
        unmeasured: [
            "inventory completeness", "functional equivalence", "first real database acceptance duration",
            "first-check failures", "authorization/tenant/idempotency/version/state defects",
            "async recovery duration", "release and stateful upgrade duration",
        ],
    };
}

if (import.meta.main) {
    const [root, path, ...extra] = process.argv.slice(2);
    if (!root || !path || extra.length) {
        throw new Error("Usage: bun scripts/feature-slice-metrics.ts <customer-repository> <reviewed-inventory.json>");
    }
    const input = await readFile(path, "utf8");
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Inventory exceeds 1 MiB");
    console.log(JSON.stringify(await measureFeatureSlice(root, JSON.parse(input)), null, 2));
}
