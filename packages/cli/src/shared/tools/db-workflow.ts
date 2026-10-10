import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
    assertApplicationRoleRestricted, readDatabaseRole, renderDatabaseRoleGuardSql,
    renderReverseSnapshot, reverseDatabase, type QueryExecutor,
} from "@supacloud/db";
import { parseDatabaseSourcesConfig } from "@supacloud/db/source-contracts";
import {
    buildOfficialSupabaseArgs, createOfficialSupabaseEnvironment, resolveOfficialSupabaseCommand,
    type SupabaseCliArgs,
} from "./supabase-cli-tools";

export type DbWorkflowAction = "reverse" | "diff" | "plan" | "apply" | "role_check" | "role_sql";
export interface DbWorkflowArguments {
    action: DbWorkflowAction;
    root?: string;
    schema?: string;
    database_url?: string;
    schema_dir?: string;
    db_major_version?: number;
    out?: string;
    dir?: string;
    ref?: string;
    approved_digest?: string;
    application_role?: string;
    migration_role?: string;
    database?: string;
}
interface ToolResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}
export interface DbWorkflowOptions {
    environment?: NodeJS.ProcessEnv;
    projectRef?: string;
    apiUrl?: string;
    runDatabase?: () => ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
    spawn?: (args: string[], root: string, environment: NodeJS.ProcessEnv) => Promise<number>;
    connect?: (url: string) => { executor: QueryExecutor; close(): Promise<void> };
}
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const result = (value: unknown, isError = false): ToolResult => ({
    isError, content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});
const schemas = (value?: string) => value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? ["public"];

/** Bounded paths only: candidates may not replace schemas, SQL sources or history. */
async function projectPath(root: string, path: string): Promise<string> {
    if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error("Use a normalized project-relative path");
    }
    let current = root;
    for (const part of path.split("/")) {
        current = join(current, part);
        try {
            if ((await lstat(current)).isSymbolicLink()) throw new Error("Symlink workflow paths are forbidden");
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
    }
    return current;
}
async function exists(path: string): Promise<boolean> {
    try { await lstat(path); return true; } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}
async function boundary(root: string) {
    const config = join(root, "database.sources.json");
    return await exists(config)
        ? parseDatabaseSourcesConfig(JSON.parse(await readFile(await projectPath(root, "database.sources.json"), "utf8")))
        : undefined;
}
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
async function candidatePath(root: string, path: string): Promise<string> {
    const config = await boundary(root);
    const protectedPaths = [
        ".git", "node_modules", "src", "migrations", "supabase/migrations", "supabase/schemas",
        ...(config ? [...config.schema, config.functions, config.migrations, config.contracts, ...config.consumers] : ["db/schema.ts", "db/functions"]),
    ];
    if (protectedPaths.some((source) => overlaps(source, path))) throw new Error("Candidate output overlaps maintained sources or migrations");
    return projectPath(root, path);
}

function connect(url: string) {
    const client = new Bun.SQL(url);
    const wrap = (connection: Pick<typeof client, "unsafe">): QueryExecutor => ({
        async query<T>(text: string, parameters?: unknown[]): Promise<T[]> {
            const values = (parameters ?? []).map((value) => {
                if (!Array.isArray(value)) return value;
                if (!value.every((item): item is string => typeof item === "string")) throw new Error("Expected catalog schema identifiers");
                return client.array(value, "TEXT");
            });
            return await connection.unsafe<T[]>(text, values);
        },
    });
    return {
        executor: {
            ...wrap(client),
            transaction: async <T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T> => {
                const value = await client.begin(async (connection) => ({ value: await work(wrap(connection)) }));
                return value.value;
            },
        } satisfies QueryExecutor,
        close: () => client.close({ timeout: 0 }),
    };
}
async function withDatabase<T>(
    args: DbWorkflowArguments, options: DbWorkflowOptions, work: (executor: QueryExecutor, url: string) => Promise<T>,
): Promise<T> {
    const url = args.database_url ?? (options.environment ?? process.env).DATABASE_URL;
    if (!url) throw new Error("Select DATABASE_URL or --database_url explicitly");
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("Expected a valid PostgreSQL URL"); }
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Expected a PostgreSQL URL");
    const connection = (options.connect ?? connect)(url);
    try { return await work(connection.executor, url); }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const safeMessage = message.replaceAll(url, "<redacted>").replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "<redacted>");
        throw new Error(`Database workflow failed; inspect the selected target with credentials redacted: ${safeMessage}`);
    }
    finally { await connection.close(); }
}
async function runOfficial(
    root: string, workdir: string, args: SupabaseCliArgs, environment: NodeJS.ProcessEnv, options: DbWorkflowOptions,
): Promise<void> {
    const command = [...resolveOfficialSupabaseCommand(root, environment),
        ...buildOfficialSupabaseArgs({ ...args, workdir })];
    const safeEnvironment = createOfficialSupabaseEnvironment(environment);
    // Do not forward control-plane or application credentials to the schema generator.
    delete safeEnvironment.SUPABASE_ACCESS_TOKEN;
    if (args.db_url) safeEnvironment.PGOPTIONS = "-c default_transaction_read_only=on";
    let code: number;
    if (options.spawn) code = await options.spawn(command, workdir, safeEnvironment);
    else {
        const child = Bun.spawn(command, { cwd: workdir, env: safeEnvironment, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        const timeout = setTimeout(() => child.kill(), 300_000);
        try { code = await child.exited; } finally { clearTimeout(timeout); }
    }
    if (code !== 0) throw new Error(`Official Supabase candidate generation failed (exit ${code}); no candidate was published. Select a compatible pinned CLI; no fallback engine is used.`);
}
async function initializeCandidate(stage: string, majorVersion = 17): Promise<void> {
    if (![15, 16, 17, 18].includes(majorVersion)) throw new Error("Select a supported PostgreSQL major version (15-18)");
    await mkdir(join(stage, "supabase/migrations"), { recursive: true });
    await mkdir(join(stage, "supabase/schemas"), { recursive: true });
    await writeFile(join(stage, "supabase/config.toml"), [
        `project_id = "supacloud-candidate-${hash(stage).slice(0, 12)}"`,
        "[db]", `major_version = ${majorVersion}`,
        "[db.migrations]", 'schema_paths = ["./schemas/**/*.sql"]', "",
    ].join("\n"));
}
async function copySqlSources(root: string, source: string, destination: string): Promise<number> {
    const path = await projectPath(root, source);
    let count = 0;
    await mkdir(destination, { recursive: true });
    for (const name of (await readdir(path)).sort()) {
        const file = await projectPath(root, `${source}/${name}`);
        const state = await lstat(file);
        if (state.isDirectory()) count += await copySqlSources(root, `${source}/${name}`, join(destination, name));
        else if (state.isFile() && name.endsWith(".sql")) {
            await writeFile(join(destination, name), await readFile(file));
            count++;
        }
    }
    return count;
}

async function reverse(args: DbWorkflowArguments, root: string, options: DbWorkflowOptions): Promise<ToolResult> {
    const out = await candidatePath(root, args.out ?? "output/database-audit/reverse");
    if (await exists(out)) throw new Error("Reverse output already exists; choose a fresh --out, never overwrite a baseline");
    const selectedSchemas = schemas(args.schema);
    if (!selectedSchemas.length || selectedSchemas.some((schema) => !/^[a-z_][a-z0-9_$]*$/i.test(schema))) {
        throw new Error("Select valid PostgreSQL schemas");
    }
    await mkdir(dirname(out), { recursive: true });
    const stage = await mkdtemp(join(dirname(out), ".reverse-"));
    try {
        const snapshot = await withDatabase(args, options, async (executor, url) => {
            const snapshot = await reverseDatabase(executor, selectedSchemas);
            // Startup read-only applies to the independent official CLI connection.
            const readonlyUrl = new URL(url);
            readonlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
            await initializeCandidate(stage, args.db_major_version);
            await runOfficial(root, stage, {
                action: "db_schema_declarative_generate", db_url: readonlyUrl.toString(),
                schema: selectedSchemas.join(","), experimental: true, strict_coverage: true,
            }, options.environment ?? process.env, options);
            return snapshot;
        });
        const generated = await readdir(join(stage, "supabase/schemas"), { recursive: true });
        if (!generated.some((file) => file.endsWith(".sql"))) throw new Error("Official reverse did not produce declarative SQL");
        await writeFile(join(stage, "catalog.json"), renderReverseSnapshot(snapshot));
        await rename(stage, out);
        return result({ ok: true, scope: "database-reverse-candidate", out: relative(root, out),
            databaseWritten: false, sourceOverwritten: false,
            review: [...snapshot.review, "Declarative generate and catalog use separate snapshots. Freeze DDL and verify parity before adopting both."] });
    } finally { await rm(stage, { force: true, recursive: true }); }
}

async function diff(args: DbWorkflowArguments, root: string, options: DbWorkflowOptions): Promise<ToolResult> {
    const sourcePath = args.schema_dir ?? "supabase/schemas";
    const source = await projectPath(root, sourcePath);
    const out = await candidatePath(root, args.out ?? "output/database-audit/diff");
    if (overlaps(source, out)) throw new Error("Candidate output overlaps the schema");
    if (await exists(out)) throw new Error("Diff output already exists; choose a fresh --out");
    const input = await migrations(root, args.dir ?? (await boundary(root))?.migrations ?? "supabase/migrations");
    if (overlaps(input.dir, out)) throw new Error("Candidate output overlaps reviewed migration history");
    await mkdir(dirname(out), { recursive: true });
    const stage = await mkdtemp(join(dirname(out), ".diff-"));
    try {
        await initializeCandidate(stage, args.db_major_version);
        if (!await copySqlSources(root, sourcePath, join(stage, "supabase/schemas"))) throw new Error("No declarative SQL sources");
        for (const { file, text } of input.files) await writeFile(join(stage, "supabase/migrations", file), text);
        await runOfficial(root, stage, { action: "db_schema_declarative_sync", apply: false,
            experimental: true, strict_coverage: true, schema: schemas(args.schema).join(",") },
        options.environment ?? process.env, options);
        const history = new Map(input.files.map((file) => [file.file, file.text]));
        for (const [file, text] of history) {
            if (await readFile(join(stage, "supabase/migrations", file), "utf8") !== text) {
                throw new Error("Official diff changed reviewed migration history");
            }
        }
        const names = (await readdir(join(stage, "supabase/migrations"))).filter((file) => file.endsWith(".sql") && !history.has(file));
        const candidates = join(stage, "candidates");
        await mkdir(candidates);
        for (const file of names) await writeFile(join(candidates, file), await readFile(join(stage, "supabase/migrations", file)));
        await rename(candidates, out);
    } finally { await rm(stage, { force: true, recursive: true }); }
    return result({ ok: true, scope: "database-migration-candidate", out: relative(root, out), databaseWritten: false,
        review: ["Declarative sync compares maintained SQL with replayed migration history, not the live database.",
            "Establish and review a matching SQL baseline before incremental generation.",
            "Promote reviewed SQL to a new forward migration; preserve the existing executor and ledger."] });
}

async function migrations(root: string, path: string) {
    const dir = await projectPath(root, path);
    const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    if (!names.length) throw new Error("No forward migration files");
    const files = [];
    for (const file of names) {
        const text = await readFile(await projectPath(root, `${path}/${file}`), "utf8");
        files.push({ file, text, sha256: hash(text) });
    }
    return { dir, files };
}
async function migrationAction(args: DbWorkflowArguments, root: string, options: DbWorkflowOptions): Promise<ToolResult> {
    const run = options.runDatabase?.();
    if (!run) throw new Error("db plan/apply require the selected Management API context");
    const ref = args.ref ?? options.projectRef;
    if (!ref || !options.apiUrl) throw new Error("Select a Management API and project ref");
    const path = args.dir ?? (await boundary(root))?.migrations ?? "supabase/migrations";
    const input = await migrations(root, path);
    // Both review and execution get identical bytes, even if the authored directory changes.
    const stage = await mkdtemp(join(tmpdir(), "supacloud-reviewed-migrations-"));
    try {
        for (const { file, text } of input.files) await writeFile(join(stage, file), text);
        const preview = await run({ action: "push_migrations", ref, dir: stage, dry_run: true, strict: true });
        const dryRun = {
            isError: preview.isError === true,
            content: preview.content.map((item) => ({ ...item, text: item.text.replaceAll(stage, input.dir) })),
        };
        const report = { version: 1, scope: "database-forward-migration-plan", apiUrl: options.apiUrl, ref,
            files: input.files.map(({ file, sha256 }) => ({ file, sha256 })), dryRun };
        const digest = hash(JSON.stringify(report));
        if (dryRun.isError) return result({ ...report, ok: false, digest, executionPerformed: false }, true);
        if (args.action === "plan") return result({ ...report, ok: true, digest, executionPerformed: false, compatibility: "not-proven" });
        if (args.approved_digest !== digest) throw new Error("Migration plan changed or lacks --approved_digest; run db plan and review the exact digest");
        return await run({ action: "push_migrations", ref, dir: stage, strict: true });
    } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function runDbWorkflow(
    args: DbWorkflowArguments, projectRoot: string, options: DbWorkflowOptions = {},
): Promise<ToolResult> {
    const root = resolve(projectRoot);
    if ((await lstat(root)).isSymbolicLink()) throw new Error("Workflow root must not be a symlink");
    switch (args.action) {
        case "reverse": return reverse(args, root, options);
        case "diff": return diff(args, root, options);
        case "plan":
        case "apply": return migrationAction(args, root, options);
        case "role_check": return withDatabase(args, options, async (executor) => {
            const state = await readDatabaseRole(executor, schemas(args.schema));
            try { assertApplicationRoleRestricted(state); }
            catch (error) { return result({ ok: false, state, error: error instanceof Error ? error.message : "Unrestricted role" }, true); }
            return result({ ok: true, state, scope: "selected-schema-role-boundary",
                review: ["Review SECURITY DEFINER entrypoints and roles outside the selected schemas separately."] });
        });
        case "role_sql":
            if (!args.application_role || !args.migration_role || !args.database) throw new Error("Select --application_role, --migration_role and --database");
            return result({ scope: "role-guard-provisioning-candidate", executionPerformed: false,
                sql: renderDatabaseRoleGuardSql({ applicationRole: args.application_role,
                    migrationRole: args.migration_role, database: args.database, schemas: schemas(args.schema) }) });
    }
}
