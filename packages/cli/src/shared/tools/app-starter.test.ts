import { afterEach, expect, test } from "bun:test";
import { requireValue } from "../../test-helpers";
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
    const manifest = JSON.parse(requireValue(files["package.json"]));
    expect(manifest.dependencies["@supacloud/compiler"]).toBeUndefined();
    expect(manifest.devDependencies["@supacloud/compiler"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(files["src/application.ts"]).not.toContain("@supacloud/compiler");
    expect(files["src/application.ts"]).not.toContain("createMemorySandbox");
    expect(files["generated/application.ts"]).toContain("Run bun run compile");
    expect(files[".gitignore"]).toContain("!.env.test");
    expect(files[".gitignore"]).not.toContain("generated");
});

test("framework starters include default query contracts and an offline client test", () => {
    const files = appStarterFiles("example");
    expect(files["supacloud.config.ts"]).toContain('graphql: { schema: "graphql/schema.graphql" }');
    expect(files["graphql/schema.graphql"]).toContain("not a deployed database schema");
    expect(files["src/review/reviews.graphql"]).toContain("query ReviewList");
    expect(files["tests/graphql.test.ts"]).toContain('from "../generated/graphql"');
    expect(files["tests/graphql.test.ts"]).toContain("ReviewListQuery");
});

test("starter routes use explicit status response maps", () => {
    const files = appStarterFiles("example");
    const source = files["src/review/review.ts"];
    expect(source).toContain('responses: { 200: HealthResult }');
    expect(source).toContain('responses: { 200: ReviewResult }');
    expect(source).not.toContain("response: HealthResult");
    expect(source).not.toContain("response: ReviewResult");
});

test("the review handler awaits storage before reporting a successful transition", () => {
    const files = appStarterFiles("example");
    const source = files["src/review/review.ts"];
    expect(source).toContain('readReview(await this.store.get("reviews", id))');
    expect(source).toContain('await this.store.set("reviews", id, next)');
    expect(source).toContain("value: Review): void | Promise<void>");
    expect(source).toContain("async execute(id: string, expectedVersion: number): Promise<Review>");
    expect(files["README.md"]).toContain("without replacing the");
    expect(files["README.md"]).toContain("awaiting a write alone does not establish durability or atomicity");
});

test("approval attachments use a compiled job and an explicit durable host contract", () => {
    const files = appStarterFiles("example");
    expect(files["src/review/review.ts"]).toContain("jobs: [VerifyReviewAttachment]");
    expect(files["src/review/attachment.ts"]).toContain('name: "review.verify-attachment"');
    expect(files["src/review/attachment.ts"]).toContain('scope: "job"');
    expect(files["src/review/attachment.ts"]).toContain("await this.store.readAttachment(input)");
    expect(files["src/review/attachment.ts"]).toContain("return this.store.recordAttachment(input");
    expect(files["tests/attachment.test.ts"]).toContain("Commit failed");
    expect(files["README.md"]).toContain("Approval Attachments");
});

test("the reference PostgreSQL host is shipped separately from synthetic test identity and migration execution", () => {
    const files = appStarterFiles("example");
    const host = requireValue(files["src/delivery-host.ts"]);
    const adapter = requireValue(files["src/host/review-postgres.ts"]);
    const schema = requireValue(files["migrations/001-review.sql"]);
    expect(host).toContain("createBunCommandDatabase(pool)");
    expect(host).toContain('required("SUPAUTH_JWKS_URL")');
    expect(host).not.toContain("keyResolver");
    expect(host).not.toContain("CREATE TABLE");
    expect(adapter).toContain("createTransactionalCommand");
    expect(adapter).toContain("FOR UPDATE OF r,m FOR SHARE OF a");
    expect(adapter).toContain("Review database project/tenant binding mismatch");
    for (const source of [adapter, host]) {
        expect(source).not.toContain("Synthetic");
        expect(source).not.toContain("node:assert");
        expect(source).not.toContain("SignJWT");
    }
    expect(schema).toContain("can_approve boolean NOT NULL DEFAULT false");
    expect(schema).toContain("ENABLE ROW LEVEL SECURITY");
    expect(schema).not.toContain("INSERT INTO");
    expect(files["tests/postgres-host.test.ts"]).toContain("never falls back");
    const manifest = JSON.parse(requireValue(files["package.json"]));
    for (const name of ["commands", "contracts", "db"]) {
        expect(manifest.dependencies[`@supacloud/${name}`]).toMatch(/^\^\d+\.\d+\.\d+/);
    }
});

test("starter distinguishes bounded execution context from unredacted source inspection", () => {
    const readme = appStarterFiles("example")["README.md"];
    expect(readme).toContain("--events execution-events.json --request-id request-123 --json");
    expect(readme).toContain("Ordinary context can include declared source expressions");
    expect(readme).toContain("input/output size limits");
    expect(readme).toContain("Never put credentials or business data in");
});

test("attachment adapters ship separately from test fault injection and provisioning", () => {
    const files = appStarterFiles("example");
    const adapter = requireValue(files["src/host/review-attachments.ts"]);
    const schema = requireValue(files["migrations/002-review-attachments.sql"]);
    expect(adapter).toContain("SupaCloudArtifactsClient");
    expect(adapter).toContain("supacloud_workflows.start_run");
    expect(adapter).toContain("$3::text::jsonb");
    expect(adapter).toContain("$4::text::jsonb");
    expect(adapter).toContain("m.enabled AND m.can_approve");
    expect(adapter).toContain("FOR UPDATE OF r,a,m FOR SHARE OF p");
    expect(adapter).toContain("Conflicting durable attachment result");
    for (const forbidden of ["node:assert", "Synthetic", "failCommit", "CREATE TABLE", "management-not-used"]) {
        expect(adapter).not.toContain(forbidden);
    }
    expect(schema).toContain("object_path text NOT NULL UNIQUE");
    expect(schema).toContain("ALTER TABLE public.starter_attachments ENABLE ROW LEVEL SECURITY");
    expect(schema).toContain("ALTER TABLE public.starter_attachment_results ENABLE ROW LEVEL SECURITY");
    expect(schema).not.toContain("INSERT INTO");
    const manifest = JSON.parse(requireValue(files["package.json"]));
    expect(manifest.dependencies["@supacloud/js"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(manifest.dependencies["@supabase/supabase-js"]).toMatch(/^\^\d+\.\d+\.\d+/);
});

test("attachment worker uses explicit queue ownership and a fatal delivery signal", () => {
    const files = appStarterFiles("example");
    const worker = requireValue(files["src/host/review-attachment-worker.ts"]);
    const host = requireValue(files["src/delivery-worker.ts"]);
    expect(worker).toContain('queueOwnership !== "exclusive-review-attachments"');
    expect(worker).toContain('claim.workflowVersion !== "1"');
    expect(worker).toContain('claim.stepKey !== "verify"');
    expect(worker).toContain("AND run_id=$3");
    expect(worker).toContain("failure: failure.promise");
    expect(worker).toContain("halted = true");
    expect(host).toContain("failure: worker.failure");
    expect(host).toContain('required("REVIEW_QUEUE_OWNERSHIP")');
    for (const source of [worker, host]) {
        expect(source).not.toContain("Synthetic");
        expect(source).not.toContain("CREATE TABLE");
        expect(source).not.toContain("process.exit(");
    }
});

test("uploads are compiled routes with identity-derived paths and a separate migration", () => {
    const files = appStarterFiles("example");
    const feature = requireValue(files["src/review/uploads.ts"]);
    const adapter = requireValue(files["src/host/review-uploads.ts"]);
    const schema = requireValue(files["migrations/003-review-uploads.sql"]);
    expect(feature).toContain('"/:id/attachment-upload"');
    expect(feature).toContain('"/:id/attachment-registration"');
    expect(feature).toContain("@Inject(REQUEST_CONTEXT)");
    expect(feature).toContain("UPLOADS_UNAVAILABLE");
    expect(adapter).toContain("requireTrustedIdentity");
    expect(adapter).toContain('name: "review.attach"');
    expect(adapter).toContain("review.attachment-bound");
    expect(adapter).toContain("FOR UPDATE OF r,m FOR SHARE OF p");
    expect(adapter).not.toContain(".remove(");
    expect(schema).toContain("ADD COLUMN storage_subject uuid UNIQUE");
    expect(schema).toContain("FOR INSERT TO authenticated");
    expect(schema).toContain("FOR SELECT TO authenticated");
    expect(schema).toContain("AS RESTRICTIVE FOR ALL TO authenticated");
    expect(schema).toContain("AS RESTRICTIVE FOR UPDATE TO authenticated");
    expect(schema).toContain("AS RESTRICTIVE FOR DELETE TO authenticated");
    expect(schema).toContain("1048576");
    expect(files["src/delivery-host.ts"]).toContain('process.env.REVIEW_ATTACHMENTS');
    expect(files["src/delivery-host.ts"]).toContain("afterApproved: durable?.enqueue");
});

test("runtime roles separate HTTP writes from worker results without granting schema ownership", () => {
    const files = appStarterFiles("example");
    const schema = requireValue(files["migrations/004-review-runtime-roles.sql"]);
    expect(schema).toContain("CREATE ROLE starter_review_http NOLOGIN NOSUPERUSER");
    expect(schema).toContain("CREATE ROLE starter_review_worker NOLOGIN NOSUPERUSER");
    expect(schema).toContain("NOBYPASSRLS");
    expect(schema).toContain("starter_backend_member_immutable");
    expect(schema).toContain("AS RESTRICTIVE FOR UPDATE");
    expect(schema).toContain("WITH CHECK (false)");
    expect(schema).toContain("GRANT INSERT ON public.starter_attachments TO starter_review_http");
    expect(schema).toContain("GRANT SELECT,INSERT ON public.starter_attachment_results TO starter_review_worker");
    expect(schema).not.toContain("GRANT ALL");
    expect(schema).not.toContain("PASSWORD");
    expect(files["README.md"]).toContain("separately privileged");
    expect(files["supacloud.config.ts"]).toContain('executor: "operator-provisioning"');
    expect(files["supacloud.config.ts"]).toContain('source: "migrations/003-review-uploads.sql"');
    expect(files["supacloud.config.ts"]).toContain('name: "review_uploads", executor: "operator-provisioning"');
});

test("starter documents Database First without representing its synthetic fixture as a deployed schema", () => {
    const files = appStarterFiles("example");
    expect(files["graphql/schema.graphql"]).toContain("SYNTHETIC TEST FIXTURE ONLY");
    expect(files["README.md"]).toContain("Database First as its only GraphQL server-schema model");
    expect(files["README.md"]).toContain("Do not hand-edit graphql/schema.graphql");
    expect(files["README.md"]).toContain("--check --json");
    expect(files["README.md"]).toContain("role/RLS tests");
    expect(files["supacloud.config.ts"]).not.toContain("autoSchemaFile");
    expect(files["supacloud.config.ts"]).not.toContain("typePaths");
});

test("the generated environment test suite runs without installing dependencies", async () => {
    const root = await directory();
    const files = appStarterFiles("example");
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "tests"));
    for (const name of ["scripts/environment.ts", "tests/environment.test.ts", "bunfig.toml"]) {
        await writeFile(join(root, name), requireValue(files[name]));
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
    const manifest = JSON.parse(requireValue(files["package.json"]));
    expect(Object.keys(manifest.dependencies).some((name) => name.startsWith("@supauth/"))).toBe(false);
});
