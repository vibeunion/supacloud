import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { executionMode, validateExecutionPolicyCoverage } from "../execution-policy";
import {
    createWorkspacePlan, formatWorkspacePlan, runWorkspacePlan, workspaceToolSchema,
    type WorkspacePlan,
} from "./workspace-plan";

const exec = promisify(execFile);
const roots: string[] = [];
const SECRET = "postgres://user:super-secret-db-url@localhost/db";

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function binding(projectRef: string, applicationId: string) {
    return { project_ref: projectRef, application_id: applicationId };
}

function workspaceConfig(applications = [
    app("storefront", "apps/storefront", "store-stg", "store-prd"),
    app("admin", "apps/admin", "admin-stg", "admin-prd"),
    app("worker", "apps/worker", "worker-stg", "worker-prd"),
]) {
    return {
        schema: "supacloud.workspace.v1",
        applications,
        shared_paths: ["packages/*"],
    };
}

function app(id: string, root: string, staging: string, production: string, build = "bun run build") {
    return {
        id, root, build,
        environments: { staging: binding(staging, id), production: binding(production, id) },
    };
}

function packageJson(name: string, dependencies: Record<string, string> = {}, devDependencies: Record<string, string> = {}) {
    return JSON.stringify({ name, dependencies, devDependencies });
}

async function writeTree(root: string, files: Record<string, string>) {
    for (const [path, contents] of Object.entries(files)) {
        const target = join(root, path);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, contents);
    }
}

async function fixture(extra: Record<string, string> = {}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "supacloud-workspace-plan-"));
    roots.push(root);
    await writeTree(root, {
        "supacloud.workspace.json": `${JSON.stringify(workspaceConfig())}\n`,
        "apps/storefront/package.json": packageJson("@acme/storefront", { "@acme/ui": "workspace:*" }),
        "apps/storefront/src/page.ts": "export const page = true;\n",
        "apps/admin/package.json": packageJson("@acme/admin", { "@acme/ui": "workspace:*" }),
        "apps/admin/src/page.ts": "export const admin = true;\n",
        "apps/worker/package.json": packageJson("@acme/worker", { "@acme/jobs": "workspace:*" }),
        "apps/worker/src/index.ts": "export const worker = true;\n",
        "packages/ui/package.json": packageJson("@acme/ui", { "@acme/tokens": "workspace:*" }),
        "packages/ui/src/index.ts": "export const ui = true;\n",
        "packages/tokens/package.json": packageJson("@acme/tokens"),
        "packages/tokens/src/index.ts": "export const token = true;\n",
        "packages/jobs/package.json": packageJson("@acme/jobs"),
        "packages/jobs/src/index.ts": "export const job = true;\n",
        ...extra,
    });
    return root;
}

function application(plan: WorkspacePlan, id: string) {
    const found = plan.applications.find(entry => entry.id === id);
    if (!found) throw new Error(`Missing application ${id}`);
    return found;
}

async function treeSnapshot(root: string): Promise<string> {
    const { readdir } = await import("node:fs/promises");
    const files: string[] = [];
    const walk = async (directory: string, prefix: string) => {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
        for (const entry of entries) {
            const path = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) files.push(`${path}@`);
            else if (entry.isDirectory()) await walk(join(directory, entry.name), path);
            else files.push(`${path}:${(await readFile(join(directory, entry.name))).length}`);
        }
    };
    await walk(root, "");
    return files.join("\n");
}

test("an application-only change plans that application and no other project", async () => {
    const root = await fixture();
    const before = await treeSnapshot(root);
    const plan = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["apps/storefront/src/page.ts"] });
    expect(plan.status).toBe("ready");
    expect(plan.executable).toBe(false);
    expect(plan.execution).toMatchObject({ executes_build: false, executes_deploy: false, writes_remote_state: false, push_webhook: "not-registered", deploy_time_enforcement: false });
    expect(application(plan, "storefront")).toMatchObject({
        impact: "affected",
        target: { project_ref: "store-stg", application_id: "storefront" },
        tasks: [
            { kind: "build", status: "planned", executed: false, command: "bun run build" },
            { kind: "deploy", status: "planned", executed: false, command: null },
        ],
    });
    expect(application(plan, "storefront").reasons).toEqual(["Changed input: apps/storefront/src/page.ts"]);
    for (const id of ["admin", "worker"]) {
        expect(application(plan, id).impact).toBe("unaffected");
        expect(application(plan, id).tasks).toEqual([]);
        expect(application(plan, id).target).toBeNull();
    }
    expect(JSON.stringify(plan)).not.toContain("store-prd");
    expect(JSON.stringify(plan)).not.toContain("admin-prd");
    expect(await treeSnapshot(root)).toBe(before);
});

test("a shared package change expands through transitive dependents only", async () => {
    const root = await fixture();
    const plan = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["packages/tokens/src/index.ts"] });
    expect(plan.status).toBe("ready");
    for (const id of ["storefront", "admin"]) {
        const selected = application(plan, id);
        expect(selected.impact).toBe("affected");
        expect(selected.reasons.some(reason => reason.includes("packages/tokens") && reason.includes("packages/ui"))).toBe(true);
        expect(selected.target?.project_ref.endsWith("-stg")).toBe(true);
        expect(selected.tasks).toHaveLength(2);
    }
    expect(application(plan, "worker")).toMatchObject({ impact: "unaffected", target: null, tasks: [] });
    expect(plan.applications.map(entry => entry.id)).toEqual(["admin", "storefront", "worker"]);
});

test("a devDependency edge is part of the same closure", async () => {
    const root = await fixture();
    await writeFile(join(root, "apps/admin/package.json"), packageJson("@acme/admin", { "@acme/ui": "workspace:*" }, { "@acme/jobs": "workspace:*" }));
    const plan = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["packages/jobs/src/index.ts"] });
    expect(application(plan, "worker").impact).toBe("affected");
    expect(application(plan, "admin").impact).toBe("affected");
    expect(application(plan, "storefront")).toMatchObject({ impact: "unaffected", tasks: [] });
});

test("staging and production select only the requested binding and write nothing", async () => {
    const root = await fixture();
    const before = await readFile(join(root, "supacloud.workspace.json"), "utf8");
    const staging = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["apps/worker/src/index.ts"] });
    const production = await createWorkspacePlan({ root, environment: "production", changedFiles: ["apps/worker/src/index.ts"] });
    expect(application(staging, "worker").target).toEqual({ project_ref: "worker-stg", application_id: "worker" });
    expect(application(production, "worker").target).toEqual({ project_ref: "worker-prd", application_id: "worker" });
    expect(JSON.stringify(staging)).not.toContain("worker-prd");
    expect(JSON.stringify(production)).not.toContain("worker-stg");
    expect(application(staging, "storefront").tasks).toEqual([]);
    expect(application(production, "storefront").tasks).toEqual([]);
    expect(await readFile(join(root, "supacloud.workspace.json"), "utf8")).toBe(before);
});

test("the same inputs produce the same machine-readable plan", async () => {
    const root = await fixture();
    const first = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["apps/admin/src/page.ts", "apps/storefront/src/page.ts"] });
    const second = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["apps/storefront/src/page.ts", "apps/admin/src/page.ts"] });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    await writeFile(join(root, "supacloud.workspace.json"), `${JSON.stringify(workspaceConfig([
        app("worker", "apps/worker", "worker-stg", "worker-prd"),
        app("storefront", "apps/storefront", "store-stg", "store-prd"),
        app("admin", "apps/admin", "admin-stg", "admin-prd"),
    ]))}\n`);
    const reordered = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["apps/admin/src/page.ts", "apps/storefront/src/page.ts"] });
    expect(reordered.plan_sha256).toBe(first.plan_sha256);
    expect(formatWorkspacePlan(first)).toContain("executed=false");
    expect(formatWorkspacePlan(first)).toContain("target=store-stg");
    expect(formatWorkspacePlan(first)).not.toContain("store-prd");
});

test("a deleted path and both sides of a rename stay attributed", async () => {
    const root = await fixture();
    const deleted = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["apps/storefront/src/deleted.ts"] });
    expect(application(deleted, "storefront").impact).toBe("affected");
    expect(application(deleted, "admin").tasks).toEqual([]);
    const renamed = await createWorkspacePlan({
        root, environment: "staging", changedFiles: ["apps/storefront/src/old.ts", "apps/admin/src/new.ts"],
    });
    expect(application(renamed, "storefront").impact).toBe("affected");
    expect(application(renamed, "admin").impact).toBe("affected");
    expect(application(renamed, "worker").tasks).toEqual([]);
});

test("an empty change is unchanged and selects no tasks", async () => {
    const root = await fixture();
    const plan = await createWorkspacePlan({ root, environment: "staging", changedFiles: [] });
    expect(plan.status).toBe("unchanged");
    expect(plan.applications.every(entry => entry.impact === "unaffected" && entry.tasks.length === 0 && entry.target === null)).toBe(true);
    expect(application(plan, "storefront").configured_binding).toEqual({ project_ref: "store-stg", application_id: "storefront" });
    expect(JSON.stringify(plan)).not.toContain("store-prd");
});

test("a workspace configuration change plans every application in the selected environment", async () => {
    const root = await fixture();
    const plan = await createWorkspacePlan({ root, environment: "production", changedFiles: ["supacloud.workspace.json"] });
    expect(plan.status).toBe("ready");
    expect(plan.applications.map(entry => entry.impact)).toEqual(["affected", "affected", "affected"]);
    expect(plan.applications.map(entry => entry.target?.project_ref)).toEqual(["admin-prd", "store-prd", "worker-prd"]);
    expect(JSON.stringify(plan)).not.toContain("store-stg");
});

test("unowned and manifest-less shared inputs stay explicit and select no project", async () => {
    const root = await fixture({ "packages/scripts/run.ts": "export const loose = true;\n", "README.md": "# notes\n" });
    const unowned = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["README.md"] });
    expect(unowned.status).toBe("blocked");
    expect(unowned.unresolved.map(entry => entry.code)).toContain("unowned-input");
    expect(unowned.unresolved[0]?.possible_dependents).toEqual(["admin", "storefront", "worker"]);
    expect(unowned.applications.every(entry => entry.tasks.length === 0 && entry.target === null)).toBe(true);
    const loose = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["packages/scripts/run.ts"] });
    expect(loose.status).toBe("blocked");
    expect(loose.applications.map(entry => entry.impact)).toEqual(["unknown", "unknown", "unknown"]);
    expect(loose.applications.every(entry => entry.tasks.length === 0 && entry.target === null)).toBe(true);
    expect(loose.unresolved.some(entry => entry.code === "unresolved-shared-input" && entry.possible_dependents.length === 3)).toBe(true);
});

test("an unresolved local dependency is not dropped from the plan", async () => {
    const root = await fixture();
    await writeFile(join(root, "apps/admin/package.json"), packageJson("@acme/admin", {
        "@acme/ui": "workspace:*", "@acme/missing": "file:../../packages/missing",
    }));
    const plan = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["packages/tokens/src/index.ts"] });
    expect(plan.status).toBe("blocked");
    expect(application(plan, "admin").impact).toBe("unknown");
    expect(application(plan, "storefront").impact).toBe("affected");
    expect(application(plan, "worker").impact).toBe("unaffected");
    expect(plan.applications.every(entry => entry.target === null && entry.tasks.length === 0)).toBe(true);
    expect(plan.diagnostics.some(diagnostic => diagnostic.code === "unresolved-dependency" && diagnostic.application_id === "admin")).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(SECRET);
});

test("invalid, mismatched, and escaping mappings fail without selecting a project", async () => {
    const root = await fixture();
    const cases: Array<{ name: string; files: Record<string, string>; code: string; absent: string }> = [
        {
            name: "duplicate id",
            files: { "supacloud.workspace.json": `${JSON.stringify(workspaceConfig([
                app("storefront", "apps/storefront", "store-stg", "store-prd"),
                app("storefront", "apps/admin", "admin-stg", "admin-prd"),
            ]))}\n` },
            code: "duplicate-application-id",
            absent: "admin-stg",
        },
        {
            name: "overlap",
            files: { "supacloud.workspace.json": `${JSON.stringify(workspaceConfig([
                app("storefront", "apps/storefront", "store-stg", "store-prd"),
                app("nested", "apps/storefront/admin", "nested-stg", "nested-prd"),
            ]))}\n` },
            code: "overlapping-application-root",
            absent: "nested-stg",
        },
        {
            name: "binding mismatch",
            files: { "supacloud.workspace.json": `${JSON.stringify({
                schema: "supacloud.workspace.v1",
                applications: [{
                    id: "storefront", root: "apps/storefront", build: "bun run build",
                    environments: { staging: { project_ref: "admin-stg", application_id: "admin" } },
                }],
                shared_paths: ["packages/*"],
            })}\n` },
            code: "application-binding-mismatch",
            absent: "admin-stg",
        },
        {
            name: "parent traversal",
            files: { "supacloud.workspace.json": `${JSON.stringify({
                schema: "supacloud.workspace.v1",
                applications: [app("storefront", "../outside", "store-stg", "store-prd")],
                shared_paths: ["packages/*"],
            })}\n` },
            code: "invalid-path",
            absent: "store-stg",
        },
        {
            name: "secret field",
            files: { "supacloud.workspace.json": `{"schema":"supacloud.workspace.v1","database_url":"${SECRET}","applications":[],"shared_paths":[]}\n` },
            code: "secret-rejected",
            absent: "super-secret-db-url",
        },
    ];
    for (const candidate of cases) {
        await writeTree(root, candidate.files);
        const plan = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["apps/storefront/src/page.ts"] });
        expect(plan.status, candidate.name).toBe("blocked");
        expect(plan.diagnostics.some(diagnostic => diagnostic.code === candidate.code), candidate.name).toBe(true);
        expect(plan.applications.every(entry => entry.target === null && entry.tasks.length === 0), candidate.name).toBe(true);
        expect(JSON.stringify(plan), candidate.name).not.toContain(candidate.absent);
    }
});

test("a symlink application root and a secret-bearing build intent are rejected", async () => {
    const root = await fixture();
    await rm(join(root, "apps/worker"), { recursive: true, force: true });
    await symlink("/tmp", join(root, "apps/worker"));
    const linked = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["apps/storefront/src/page.ts"] });
    expect(linked.status).toBe("blocked");
    expect(linked.diagnostics.some(diagnostic => diagnostic.code === "symlink-rejected")).toBe(true);
    expect(linked.applications.every(entry => entry.target === null)).toBe(true);
    await writeFile(join(root, "supacloud.workspace.json"), `${JSON.stringify(workspaceConfig([
        app("storefront", "apps/storefront", "store-stg", "store-prd", `bun run build ${SECRET}`),
    ]))}\n`);
    const secretBuild = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["apps/storefront/src/page.ts"] });
    expect(secretBuild.status).toBe("blocked");
    expect(JSON.stringify(secretBuild)).not.toContain("super-secret-db-url");
});

test("a missing environment binding and a conflicting supacloud.json do not infer a project", async () => {
    const root = await fixture();
    const config = workspaceConfig([app("storefront", "apps/storefront", "store-stg", "store-prd")]);
    delete (config.applications[0]?.environments as { production?: unknown }).production;
    await writeFile(join(root, "supacloud.workspace.json"), `${JSON.stringify(config)}\n`);
    const missing = await createWorkspacePlan({ root, environment: "production", changedFiles: ["apps/storefront/src/page.ts"] });
    expect(missing.status).toBe("blocked");
    expect(application(missing, "storefront").target).toBeNull();
    expect(application(missing, "storefront").tasks).toEqual([]);
    expect(JSON.stringify(missing)).not.toContain("store-stg");
    await writeTree(root, {
        "supacloud.workspace.json": `${JSON.stringify(workspaceConfig([app("storefront", "apps/storefront", "store-stg", "store-prd")]))}\n`,
        "apps/storefront/supacloud.json": `${JSON.stringify({ application: { id: "admin", environmentId: "production" } })}\n`,
    });
    const mismatch = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["apps/storefront/src/page.ts"] });
    expect(mismatch.status).toBe("blocked");
    expect(mismatch.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
        "supacloud-json-application-mismatch", "supacloud-json-environment-differs",
    ]);
    expect(application(mismatch, "storefront").target).toBeNull();
});

test("planning never executes the configured build or a deployment", async () => {
    const root = await fixture();
    const sentinel = join(root, "sentinel-workspace-plan.txt");
    await writeFile(join(root, "supacloud.workspace.json"), `${JSON.stringify(workspaceConfig([
        app("storefront", "apps/storefront", "store-stg", "store-prd", "touch sentinel-workspace-plan.txt"),
        app("admin", "apps/admin", "admin-stg", "admin-prd", "touch sentinel-workspace-plan.txt"),
        app("worker", "apps/worker", "worker-stg", "worker-prd", "touch sentinel-workspace-plan.txt"),
    ]))}\n`);
    await writeFile(join(root, ".changed"), "apps/storefront/src/page.ts\n");
    const result = await runWorkspacePlan({ environment: "staging", changed: ".changed", format: "json" }, root);
    const plan = JSON.parse(result.content[0]?.text ?? "") as WorkspacePlan;
    expect(result.isError).toBe(false);
    expect(plan.status).toBe("ready");
    expect(application(plan, "storefront").tasks[0]).toMatchObject({ command: "touch sentinel-workspace-plan.txt", executed: false });
    await expect(readFile(sentinel, "utf8")).rejects.toThrow();
    const invalid = await runWorkspacePlan({ environment: "staging", base: "HEAD", changed: ".changed" }, root);
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toContain("exactly one");
});

test("git rename and deletion inputs stay explicit", async () => {
    const root = await fixture();
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-m", "initial"], { cwd: root });
    const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).stdout.trim();
    await exec("git", ["mv", "apps/storefront/src/page.ts", "apps/admin/src/moved.ts"], { cwd: root });
    await exec("git", ["commit", "-m", "rename"], { cwd: root });
    await rm(join(root, "apps/worker/src/index.ts"));
    const result = await runWorkspacePlan({ environment: "staging", base, format: "json" }, root);
    const plan = JSON.parse(result.content[0]?.text ?? "") as WorkspacePlan;
    expect(plan.changed_files).toEqual(expect.arrayContaining([
        "apps/storefront/src/page.ts", "apps/admin/src/moved.ts", "apps/worker/src/index.ts",
    ]));
    expect(application(plan, "storefront").impact).toBe("affected");
    expect(application(plan, "admin").impact).toBe("affected");
    expect(application(plan, "worker").impact).toBe("affected");
    expect(plan.execution.executes_deploy).toBe(false);
});

test("workspace plan is a local command", () => {
    expect(executionMode("workspace", "plan", {})).toBe("local");
    expect(() => validateExecutionPolicyCoverage({ workspace: { schema: workspaceToolSchema } })).not.toThrow();
});
