import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

export class ScaffoldError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = "ScaffoldError";
    }
}

export interface ScaffoldWrite {
    readonly path: string;
    readonly content: string;
    /** A registration edit must still match the source used by the compiler. */
    readonly expected?: string;
    readonly overwrite?: boolean;
}

interface FileSnapshot {
    readonly content: string;
    readonly mode: number;
    readonly dev: number;
    readonly ino: number;
}

export interface ScaffoldPlan {
    readonly root: string;
    readonly writes: readonly (ScaffoldWrite & { readonly before: FileSnapshot | null })[];
}

function fsCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export function scaffoldPath(root: string, path: string): string {
    if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path) || win32.isAbsolute(path)) {
        throw new ScaffoldError("SCAFFOLD_PATH_INVALID", "Scaffold paths must be relative to the project root");
    }
    const parts = path.split("/");
    if (parts.some((part) => /[<>:"|?*\u0000-\u001f]/.test(part)
        || /[ .]$/.test(part) && part !== "." && part !== ".."
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
        || part.toLowerCase() === ".git" || part.toLowerCase() === ".supacloud-generate.lock")) {
        throw new ScaffoldError("SCAFFOLD_PATH_INVALID", "Scaffold path is reserved or not portable");
    }
    const target = resolve(root, path);
    const local = relative(root, target);
    if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        throw new ScaffoldError("SCAFFOLD_PATH_INVALID", "Scaffold path is outside the project root");
    }
    return target;
}

/** No constructor, configuration module or application code is evaluated here. */
async function snapshot(root: string, path: string): Promise<FileSnapshot | null> {
    const target = scaffoldPath(root, path);
    const parts = relative(root, target).split(sep);
    let current = root;
    for (const [index, part] of parts.entries()) {
        current = join(current, part);
        let stat;
        try { stat = await lstat(current); }
        catch (error) { if (fsCode(error) === "ENOENT") return null; throw error; }
        if (stat.isSymbolicLink()) throw new ScaffoldError("SCAFFOLD_SYMLINK", `Symbolic links are not scaffold targets: ${current}`);
        if (index < parts.length - 1) {
            if (!stat.isDirectory()) throw new ScaffoldError("SCAFFOLD_PATH_INVALID", `Not a directory: ${current}`);
        } else {
            if (!stat.isFile() || stat.nlink !== 1) {
                throw new ScaffoldError("SCAFFOLD_PATH_INVALID", `Scaffold target must be a regular, unlinked file: ${current}`);
            }
            return { content: await readFile(current, "utf8"), mode: stat.mode, dev: stat.dev, ino: stat.ino };
        }
    }
    return null;
}

function sameFile(a: FileSnapshot | null, b: FileSnapshot | null): boolean {
    return a === null ? b === null : b !== null && a.content === b.content && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

/** Preflight the complete set before creating any directory or file. */
export async function planScaffoldWrites(root: string, writes: readonly ScaffoldWrite[]): Promise<ScaffoldPlan> {
    const canonical = await realpath(resolve(root));
    const targets = new Set<string>();
    const planned: Array<ScaffoldWrite & { before: FileSnapshot | null }> = [];
    for (const write of writes) {
        const target = scaffoldPath(canonical, write.path);
        // Also reject case-folded duplicates, so a plan has the same meaning on Windows/macOS.
        const key = target.toLowerCase();
        if (targets.has(key) || [...targets].some((other) => key.startsWith(`${other}${sep}`) || other.startsWith(`${key}${sep}`))) {
            throw new ScaffoldError("SCAFFOLD_PATH_CONFLICT", `Conflicting scaffold target: ${write.path}`);
        }
        targets.add(key);
        const before = await snapshot(canonical, write.path);
        if (write.expected !== undefined && before?.content !== write.expected) {
            throw new ScaffoldError("SCAFFOLD_CHANGED", `Registration target changed: ${write.path}`);
        }
        if (before && !write.overwrite && write.expected === undefined) {
            throw new ScaffoldError("SCAFFOLD_EXISTS", `File already exists: ${target}（使用 --force 覆盖单文件；resource 不覆盖）`);
        }
        planned.push(Object.freeze({ ...write, before: before && Object.freeze(before) }));
    }
    // New declarations precede registration edits. Order is deterministic.
    planned.sort((a, b) => Number(a.before !== null) - Number(b.before !== null) || a.path.localeCompare(b.path, "en"));
    return Object.freeze({ root: canonical, writes: Object.freeze(planned) });
}

/**
 * Serializes generator writers and rolls back handled write failures. This is
 * not a crash-atomic filesystem transaction or a sandbox against hostile local
 * writers. Concurrent edits detected during validation are never overwritten.
 */
export async function applyScaffoldWrites(plan: ScaffoldPlan): Promise<void> {
    const lockPath = join(plan.root, ".supacloud-generate.lock");
    const lock = await open(lockPath, "wx").catch((error: unknown) => {
        if (fsCode(error) === "EEXIST") throw new ScaffoldError("SCAFFOLD_BUSY", "Another generator owns .supacloud-generate.lock; no files written");
        throw error;
    });
    const directories: string[] = [];
    const applied: Array<{ write: ScaffoldPlan["writes"][number]; after: FileSnapshot }> = [];
    const temporary: string[] = [];
    try {
        if (await realpath(plan.root) !== plan.root) throw new ScaffoldError("SCAFFOLD_CHANGED", "Project root changed");
        for (const write of plan.writes) {
            if (!sameFile(write.before, await snapshot(plan.root, write.path))) {
                throw new ScaffoldError("SCAFFOLD_CHANGED", `Scaffold target changed after planning: ${write.path}`);
            }
        }
        for (const write of plan.writes) {
            const target = scaffoldPath(plan.root, write.path);
            let current = plan.root;
            for (const part of relative(plan.root, dirname(target)).split(sep).filter(Boolean)) {
                current = join(current, part);
                try { await mkdir(current); directories.push(current); }
                catch (error) { if (fsCode(error) !== "EEXIST") throw error; }
                const stat = await lstat(current);
                if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ScaffoldError("SCAFFOLD_CHANGED", `Directory changed: ${current}`);
            }
            if (!sameFile(write.before, await snapshot(plan.root, write.path))) {
                throw new ScaffoldError("SCAFFOLD_CHANGED", `Scaffold target changed during generation: ${write.path}`);
            }
            const pending = `${target}.supacloud-${randomUUID()}`;
            const file = await open(pending, "wx", write.before?.mode);
            temporary.push(pending);
            let after: FileSnapshot;
            try {
                if (write.before) await file.chmod(write.before.mode);
                await file.writeFile(write.content, "utf8");
                const stat = await file.stat();
                after = { content: write.content, mode: stat.mode, dev: stat.dev, ino: stat.ino };
            } finally { await file.close(); }
            if (!sameFile(write.before, await snapshot(plan.root, write.path))) {
                throw new ScaffoldError("SCAFFOLD_CHANGED", `Scaffold target changed before publication: ${write.path}`);
            }
            if (write.before) await rename(pending, target);
            else await link(pending, target); // Atomic, exclusive publication; never overwrite a new target.
            applied.push({ write, after });
            if (!write.before) await unlink(pending);
        }
    } catch (error) {
        const failures: unknown[] = [];
        for (const { write, after } of applied.reverse()) {
            try {
                const current = await snapshot(plan.root, write.path);
                if (!sameFile(after, current)) throw new ScaffoldError("SCAFFOLD_CHANGED", `Rollback preserved an independently changed file: ${write.path}`);
                const target = scaffoldPath(plan.root, write.path);
                if (!write.before) await unlink(target);
                else {
                    const pending = `${target}.supacloud-${randomUUID()}`;
                    const file = await open(pending, "wx", write.before.mode);
                    temporary.push(pending);
                    try { await file.chmod(write.before.mode); await file.writeFile(write.before.content, "utf8"); } finally { await file.close(); }
                    await rename(pending, target);
                }
            } catch (rollbackError) { failures.push(rollbackError); }
        }
        if (failures.length) throw new AggregateError([error, ...failures], "Scaffold failed; some changed files require manual recovery", { cause: error });
        throw error;
    } finally {
        for (const path of temporary) await unlink(path).catch(() => {});
        for (const path of directories.reverse()) await rmdir(path).catch(() => {});
        await lock.close();
        await unlink(lockPath);
    }
}
