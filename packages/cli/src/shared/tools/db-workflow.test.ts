import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import { runDbWorkflow, type DbWorkflowOptions } from "./db-workflow";
import { authorizeExecution, executionMode } from "../execution-policy";
import { resolveSupaCloudContext } from "../context";
import { buildDatabaseAiContext, registerDbGovernanceTools } from "./db-governance-tools";
import { renderDatabaseRoleGuardSql, reverseDatabase } from "@supacloud/db";

const roots: string[] = [];
const container = `supacloud-db-workflow-${crypto.randomUUID()}`;
let pool: SQL;
let url = "";
let started = false;
function docker(args: string[]) {
    const child = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    if (child.exitCode) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
}
beforeAll(async () => {
    docker(["run", "--rm", "-d", "--name", container, "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
        "-e", "POSTGRES_DB=workflow_test", "-p", "127.0.0.1::5432", "postgres:18-alpine"]);
    started = true;
    const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
    url = `postgres://postgres@127.0.0.1:${port}/workflow_test?sslmode=disable`;
    pool = new SQL(url);
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
        try { await pool`SELECT 1`; ready = true; break; } catch { await Bun.sleep(100); }
    }
    if (!ready) throw new Error("Disposable PostgreSQL did not start");
    await pool.unsafe(`CREATE ROLE app_user LOGIN;
        CREATE ROLE app_migrator NOLOGIN;
        GRANT app_migrator TO app_user;
        GRANT CREATE ON SCHEMA public TO PUBLIC;
        CREATE TABLE public.items(id integer PRIMARY KEY, label text NOT NULL);
        INSERT INTO public.items VALUES(1, 'original');
        ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
        CREATE POLICY items_read ON public.items FOR SELECT TO app_user USING(true);
        GRANT SELECT ON public.items TO app_user;
        CREATE SCHEMA adoption;
        CREATE TABLE adoption.samples(id integer PRIMARY KEY, label text NOT NULL);`);
}, 30_000);
afterAll(async () => {
    try {
        await pool?.close({ timeout: 0 });
        for (const root of roots) await rm(root, { recursive: true, force: true });
    } finally { if (started) docker(["rm", "-f", container]); }
});
async function project() {
    const root = await mkdtemp(join(tmpdir(), "db-workflow-project-"));
    roots.push(root);
    await mkdir(join(root, "migrations"));
    await mkdir(join(root, "db"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "migrations/20261010000000_initial.sql"), "SELECT 1;\n");
    return root;
}
function json(response: Awaited<ReturnType<typeof runDbWorkflow>>): Record<string, unknown> {
    return JSON.parse(response.content[0]!.text);
}

const baselineSql = `CREATE TABLE public.items(id integer PRIMARY KEY, label text NOT NULL);
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
CREATE POLICY items_read ON public.items FOR SELECT TO app_user USING(true);
GRANT SELECT ON public.items TO app_user;\n`;
function officialAdapter(): DbWorkflowOptions {
    return {
        environment: { ...process.env, DATABASE_URL: url, SUPACLOUD_API_TOKEN: "must-not-forward" },
        spawn: async (command, stage, environment) => {
            expect(environment.SUPACLOUD_API_TOKEN).toBeUndefined();
            if (command.includes("generate")) {
                expect(command).toContain("--experimental");
                expect(command).toContain("--strict-coverage");
                expect(command).not.toContain("--overwrite");
                const target = command[command.indexOf("--db-url") + 1];
                expect(new URL(target!).searchParams.get("options")).toBe("-c default_transaction_read_only=on");
                expect(environment.PGOPTIONS).toBe("-c default_transaction_read_only=on");
                expect(await readFile(join(stage, "supabase/config.toml"), "utf8")).not.toContain(url);
                await writeFile(join(stage, "supabase/schemas/items.sql"), baselineSql);
            } else {
                expect(command).toContain("sync");
                expect(command).toContain("--no-apply");
                expect(command).toContain("--strict-coverage");
                expect(command).not.toContain("--db-url");
                expect(await readFile(join(stage, "supabase/schemas/items.sql"), "utf8")).toContain("extra text");
                expect(await readFile(join(stage, "supabase/migrations/20261010000000_initial.sql"), "utf8")).toBe(baselineSql);
                await writeFile(join(stage, "supabase/migrations/20261010000001_extra.sql"), "ALTER TABLE public.items ADD COLUMN extra text;\n");
            }
            return 0;
        },
    };
}
test("reverse adapter publishes declarative SQL and a real catalog without source, data or ledger writes", async () => {
    const root = await project();
    const initial = await readFile(join(root, "migrations/20261010000000_initial.sql"), "utf8");
    const response = await runDbWorkflow({ action: "reverse", out: "output/reverse" }, root, officialAdapter());
    expect(json(response)).toMatchObject({ ok: true, databaseWritten: false, sourceOverwritten: false });
    expect(await readFile(join(root, "output/reverse/supabase/schemas/items.sql"), "utf8")).toContain("items");
    const catalog: unknown = JSON.parse(await readFile(join(root, "output/reverse/catalog.json"), "utf8"));
    expect(catalog).toMatchObject({ kind: "database-reverse-candidate", tables: [{ name: "items", rlsEnabled: true }] });
    expect(await readFile(join(root, "migrations/20261010000000_initial.sql"), "utf8")).toBe(initial);
    expect(await pool<{ id: number; label: string }[]>`SELECT * FROM public.items`).toEqual([{ id: 1, label: "original" }]);
    expect(await pool<{ ledger: string | null }[]>`SELECT to_regclass('drizzle.__drizzle_migrations') AS ledger`).toEqual([{ ledger: null }]);
    expect((await readdir(join(root, "output"), { recursive: true })).some((path) => path.includes("pull.config"))).toBe(false);
    await expect(runDbWorkflow({ action: "reverse", out: "output/reverse" }, root)).rejects.toThrow("already exists");
}, 30_000);

test("diff adapter stages SQL sources and history separately and publishes only a forward draft", async () => {
    const root = await project();
    await mkdir(join(root, "supabase/schemas"), { recursive: true });
    expect(buildDatabaseAiContext([], root).maintenance).toMatchObject({
        structureSource: "declarative-sql", generatedPaths: ["db/schema.ts", "generated/", "bootstrap/schema.sql", "output/database-audit/"],
    });
    await writeFile(join(root, "supabase/schemas/items.sql"), baselineSql.replace("label text", "extra text, label text"));
    await writeFile(join(root, "migrations/20261010000000_initial.sql"), baselineSql);
    const response = await runDbWorkflow({ action: "diff", dir: "migrations", out: "db/candidates" }, root, officialAdapter());
    expect(json(response)).toMatchObject({ ok: true, databaseWritten: false });
    const newSql = (await readdir(join(root, "db/candidates"), { recursive: true }))
        .filter((file) => file.endsWith(".sql"));
    expect(newSql).toHaveLength(1);
    const draft = await readFile(join(root, "db/candidates", newSql[0]!), "utf8");
    expect(draft).toContain("ADD COLUMN extra");
    expect(draft).not.toContain("CREATE TABLE");
    expect(await pool<{ count: number }[]>`SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_schema='public' AND table_name='items' AND column_name='extra'`).toEqual([{ count: 0 }]);
}, 30_000);

test.skipIf(!process.env.SUPACLOUD_SUPABASE_CLI_BIN)("pinned official engine reverses and generates an incremental SQL migration", async () => {
    const root = await project();
    const options: DbWorkflowOptions = { environment: { ...process.env, DATABASE_URL: url },
        spawn: async (command, stage, environment) => {
            const child = Bun.spawn(command, { cwd: stage, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
            const timer = setTimeout(() => child.kill(), 300_000);
            try {
                const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
                if (exit !== 0) throw new Error((stdout + stderr).replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "<redacted>"));
                return exit;
            } finally { clearTimeout(timer); }
        } };
    await runDbWorkflow({ action: "reverse", schema: "adoption", out: "output/native" }, root, options);
    const exported = await readdir(join(root, "output/native/supabase/schemas"), { recursive: true });
    expect(exported.some((file) => file.endsWith(".sql"))).toBe(true);
    const baseline = "CREATE SCHEMA adoption;\nCREATE TABLE adoption.samples(id integer PRIMARY KEY, label text NOT NULL);\n";
    await mkdir(join(root, "supabase/schemas"), { recursive: true });
    await writeFile(join(root, "supabase/schemas/schema.sql"), baseline.replace("label text", "extra text, label text"));
    await writeFile(join(root, "migrations/20261010000000_initial.sql"), baseline);
    await runDbWorkflow({ action: "diff", schema: "adoption", dir: "migrations", out: "output/native-diff" }, root, options);
    const files = await readdir(join(root, "output/native-diff"));
    expect(files).toHaveLength(1);
    expect(await readFile(join(root, "output/native-diff", files[0]!), "utf8")).toContain("extra");
    expect(await pool<{ count: number }[]>`SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_schema='adoption' AND table_name='samples' AND column_name='extra'`).toEqual([{ count: 0 }]);
}, 360_000);

test("candidates reject history/source overlap and symlink escapes before connecting", async () => {
    const root = await project();
    for (const out of ["migrations", "src", "supabase/schemas", "db/schema.ts", "../outside"]) {
        await expect(runDbWorkflow({ action: "reverse", out }, root)).rejects.toThrow();
    }
    await symlink(join(root, "migrations"), join(root, "alias"));
    await expect(runDbWorkflow({ action: "reverse", out: "alias/candidate" }, root)).rejects.toThrow("Symlink");
    await expect(reverseDatabase({ query: async () => [] }, ["public"])).rejects.toThrow("pinned");
}, 30_000);

test("failed export removes temporary output and never includes connection credentials in errors", async () => {
    const root = await project();
    await expect(runDbWorkflow({ action: "reverse", out: "output/failed" }, root, {
        environment: { DATABASE_URL: url },
        spawn: async (command, _, environment) => {
            expect(command).not.toContain("--init");
            expect(environment.PGOPTIONS).toBe("-c default_transaction_read_only=on");
            return 7;
        },
    })).rejects.toThrow("credentials redacted");
    expect(await readdir(join(root, "output"))).toEqual([]);
});

test("role provisioning removes CREATE and privileged membership while preserving user-scoped reads", async () => {
    const root = await project();
    const appUrl = url.replace("postgres@", "app_user@");
    const options = { environment: { DATABASE_URL: appUrl } };
    expect((await runDbWorkflow({ action: "role_check" }, root, options)).isError).toBe(true);
    const sql = renderDatabaseRoleGuardSql({
        applicationRole: "app_user", migrationRole: "app_migrator", database: "workflow_test",
    });
    await pool.unsafe(sql);
    expect((await runDbWorkflow({ action: "role_check" }, root, options)).isError).toBe(false);
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "app_migrator" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;');
    await pool.unsafe("GRANT CREATE ON SCHEMA public TO app_migrator; SET ROLE app_migrator; CREATE FUNCTION public.future_rpc() RETURNS int LANGUAGE sql AS 'SELECT 1'; RESET ROLE;");
    expect(await pool<{ allowed: boolean }[]>`SELECT has_function_privilege('app_user', 'public.future_rpc()', 'EXECUTE') AS allowed`).toEqual([{ allowed: false }]);
    const app = new SQL(appUrl);
    try {
        expect(await app<{ id: number; label: string }[]>`SELECT * FROM public.items`).toEqual([{ id: 1, label: "original" }]);
        for (const ddl of [
            "CREATE TABLE public.forbidden(id int)", "ALTER TABLE public.items ADD COLUMN forbidden int",
            "DROP TABLE public.items", "CREATE SCHEMA forbidden",
        ]) await expect((async () => { await app.unsafe(ddl); })()).rejects.toThrow();
    } finally { await app.close({ timeout: 0 }); }
    await pool.unsafe("GRANT app_migrator TO app_user; ALTER TABLE public.items OWNER TO app_migrator;");
    expect((await runDbWorkflow({ action: "role_check" }, root, options)).isError).toBe(true);
    await pool.unsafe("REVOKE app_migrator FROM app_user; ALTER TABLE public.items OWNER TO postgres;");
    await expect(runDbWorkflow({ action: "role_check", schema: "missing" }, root, options)).rejects.toThrow();
});

function management() {
    const calls: Record<string, unknown>[] = [];
    let pending = "one";
    let mutate: (() => Promise<void>) | undefined;
    let executedSql = "";
    const options: DbWorkflowOptions = {
        projectRef: "project-a", apiUrl: "https://management.example.test",
        runDatabase: () => async (args) => {
            calls.push(args);
            if (args.dry_run) {
                if (mutate) await mutate();
                return { content: [{ type: "text", text: `Migration dry run for ${String(args.dir)}\nPending: ${pending}` }] };
            }
            executedSql = await readFile(join(String(args.dir), "20261010000000_initial.sql"), "utf8");
            return { isError: true, content: [{ type: "text", text: '{"error":"OUTCOME_UNKNOWN","applied":[]}' }] };
        },
    };
    return { options, calls, getSql: () => executedSql, pending: (value: string) => { pending = value; },
        mutate: (run: () => Promise<void>) => { mutate = run; } };
}

test("plan is read-only; apply preserves unknown receipts and executes the exact reviewed snapshot", async () => {
    const root = await project(), api = management();
    const plan = json(await runDbWorkflow({ action: "plan", dir: "migrations" }, root, api.options));
    expect(plan).toMatchObject({ ok: true, executionPerformed: false, compatibility: "not-proven" });
    expect(api.calls.every((call) => call.dry_run === true)).toBe(true);
    const digest = plan.digest;
    if (typeof digest !== "string") throw new Error("Missing digest");
    api.mutate(() => writeFile(join(root, "migrations/20261010000000_initial.sql"), "SELECT 2;\n"));
    const response = await runDbWorkflow({ action: "apply", dir: "migrations", approved_digest: digest }, root, api.options);
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("OUTCOME_UNKNOWN");
    expect(api.getSql()).toBe("SELECT 1;\n");
    expect(api.calls.filter((call) => call.dry_run !== true)).toHaveLength(1);
});

test("SQL, target, pending state or missing approval invalidate apply before any write", async () => {
    for (const change of ["sql", "ref", "pending", "origin", "approval"]) {
        const root = await project(), api = management();
        const plan = json(await runDbWorkflow({ action: "plan", dir: "migrations" }, root, api.options));
        const digest = String(plan.digest);
        if (change === "sql") await writeFile(join(root, "migrations/20261010000000_initial.sql"), "SELECT 2;\n");
        if (change === "pending") api.pending("none");
        if (change === "origin") api.options.apiUrl = "https://other.example.test";
        await expect(runDbWorkflow({ action: "apply", dir: "migrations",
            ...(change === "ref" ? { ref: "project-b" } : {}),
            ...(change === "approval" ? {} : { approved_digest: digest }),
        }, root, api.options)).rejects.toThrow("digest");
        expect(api.calls.every((call) => call.dry_run === true)).toBe(true);
    }
});

test("failed risk preview prevents mutation even with its digest; offline apply requires Management credentials", async () => {
    const root = await project();
    const api = management();
    api.options.runDatabase = () => async () => ({ isError: true, content: [{ type: "text", text: "high risk" }] });
    const plan = json(await runDbWorkflow({ action: "plan", dir: "migrations" }, root, api.options));
    expect(plan.ok).toBe(false);
    expect((await runDbWorkflow({ action: "apply", dir: "migrations", approved_digest: String(plan.digest) }, root, api.options)).isError).toBe(true);
    await expect(runDbWorkflow({ action: "apply" }, root)).rejects.toThrow("Management API");
});

test("registered workflow commands participate in read-only and exact production confirmation policies", async () => {
    const root = await project();
    const context = resolveSupaCloudContext({
        SUPACLOUD_ENV: "production", SUPACLOUD_API_URL: "https://management.example.test",
        SUPACLOUD_API_TOKEN: "test-token", SUPACLOUD_PROJECT_REF: "project-a",
    }, root);
    expect(executionMode("db", "reverse", {})).toBe("read");
    expect(executionMode("db", "diff", {})).toBe("local");
    expect(executionMode("db", "apply", {})).toBe("write");
    expect(() => authorizeExecution("db", { action: "apply" }, { context })).toThrow("confirm-production");
    expect(() => authorizeExecution("db", { action: "apply" }, { context: { ...context, readOnly: true } })).toThrow("read-only");
    expect(() => authorizeExecution("db", { action: "apply", ref: "other" },
        { context, confirmProduction: "project-a" })).toThrow("different project");
    let registered = false;
    registerDbGovernanceTools({ tool(_, __, ___, callback) {
        registered = true;
        expect(callback).toBeFunction();
    } }, { currentWorkingDirectory: root });
    expect(registered).toBe(true);
});

test("modified workflow modules have scoped strict TypeScript diagnostics", () => {
    const files = [
        resolve(import.meta.dir, "db-workflow.ts"), resolve(import.meta.dir, "db-governance-tools.ts"),
        resolve(import.meta.dir, "../../../../db/src/reverse.ts"), resolve(import.meta.dir, "../../../../db/src/role-guard.ts"),
    ];
    const program = ts.createProgram(files, { strict: true, noEmit: true, skipLibCheck: true, types: ["bun"],
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
    const errors = ts.getPreEmitDiagnostics(program).filter((item) => !item.file || files.includes(resolve(item.file.fileName)));
    expect(errors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
}, 30_000);
