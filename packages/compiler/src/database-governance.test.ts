import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseSources } from "@supacloud/db/source-contracts";
import { checkProject, compileProject } from "./compile";
import { compileOptionsFromConfig, defineSupacloudConfig, loadSupacloudConfig } from "./config";
import { createIncrementalCompiler } from "./incremental";
import { watchProject } from "./watch";
import { checkDatabaseGovernance } from "./database-governance";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";
import type { CompileOptions, WatchHandle } from "./types";

const roots: string[] = [];
let handle: WatchHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const module = {
  name: "items", tables: ["public.items"], policies: [], functions: [], triggers: [], grants: [],
};

// Only the test fixture replaces transport. The worker still runs real source, lint and reconciliation code.
const fakeTransport = `
import { readFileSync } from "node:fs";
Reflect.set(Bun, "SQL", class {
  async unsafe(sql) {
    const state = JSON.parse(readFileSync(new URL("./state.json", import.meta.url), "utf8"));
    if (state.error) throw new Error("postgres://private-secret@example.invalid/private");
    return sql.includes("FROM pg_class")
      ? [{ schema: "public", name: "items", rls_enabled: state.rls, rls_forced: false }] : [];
  }
  async close() {}
});
`;
async function fixture(): Promise<{ root: string; options: CompileOptions }> {
  const root = await mkdtemp(join(tmpdir(), "compiler-database-mode-"));
  roots.push(root);
  await writeFixtureProject(root, {
    ...GOOD_PROJECT_FILES,
    "database.sources.json": JSON.stringify({
      version: 1, schema: ["db/schema.ts"], functions: "db/functions", migrations: "migrations",
      contracts: "db/contracts", audit: "output/database-audit", consumers: ["src"],
      auditConsumers: [], role: "authenticated",
    }),
    "db/schema.ts": "export const items = 'fixture structure';",
    "db/modules.mjs": fakeTransport + `export default ${JSON.stringify(module)};`,
    "db/state.json": JSON.stringify({ rls: true }),
    "migrations/001.sql": "SELECT 1;",
  });
  await mkdir(join(root, "db/functions"));
  expect((await databaseSources(root, "generate")).ok).toBe(true);
  return { root, options: {
    rootDir: root, outDir: join(root, "generated"), strict: false,
    databaseGovernance: {
      mode: "enforce", projectRoot: root, moduleFile: "db/modules.mjs",
      databaseUrl: "postgres://fixture:fixture@localhost/fixture",
    },
  } };
}

test("configuration defaults off, resolves project root and rejects malformed modes", () => {
  expect(defineSupacloudConfig().databaseGovernance?.mode).toBe("off");
  expect(compileOptionsFromConfig({ databaseGovernance: { mode: "check" } }, "/project"))
    .toMatchObject({ databaseGovernance: { mode: "check", projectRoot: "/project" } });
  expect(compileOptionsFromConfig({ root: "src", databaseGovernance: { mode: "enforce" } }, "/project"))
    .toMatchObject({ rootDir: "/project/src", databaseGovernance: { projectRoot: "/project" } });
  for (const value of [false, null, {}, { mode: "warn" }, { mode: "enforce", schemas: [] },
    { mode: "enforce", databaseUrlEnv: "bad-name" }, { mode: "enforce", optional: true }]) {
    expect(() => Reflect.apply(defineSupacloudConfig, undefined, [{ databaseGovernance: value }])).toThrow();
  }
});

test("offline checks never import modules or use database credentials and still reject missing adoption", async () => {
  const { root, options } = await fixture();
  await writeFile(join(root, "db/modules.mjs"), "throw new Error('must not be imported');");
  const offline = {
    ...options.databaseGovernance!, mode: "check" as const,
    databaseUrl: "not-a-database-url",
  };
  expect(await checkDatabaseGovernance(root, offline)).toEqual([]);
  await rm(join(root, "db/modules.mjs"));
  expect(await checkDatabaseGovernance(root, offline)).toEqual([]);
  await rm(join(root, "database.sources.json"));
  expect(await checkDatabaseGovernance(root, offline)).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "database-source-contract", severity: "error" })]),
  );
  expect(await checkDatabaseGovernance(root, { mode: "off" })).toEqual([]);
});

test("offline compile and incremental checks fail closed on stale contracts without repairing artifacts", async () => {
  const { root, options } = await fixture();
  const offline: CompileOptions = {
    ...options, databaseGovernance: { mode: "check", projectRoot: root },
  };
  const compiler = createIncrementalCompiler();
  expect((await compiler.compile(offline)).diagnostics.filter(item => item.severity === "error")).toEqual([]);
  expect((await compiler.compile(offline, [])).stats.cacheHit).toBe(true);
  const before = await readFile(join(options.outDir, "app.manifest.json"), "utf8");
  await writeFile(join(root, "db/schema.ts"), "export const changed = true;");
  const failed = await compiler.compile({ ...offline, writeOnError: true }, []);
  expect(failed.written).toEqual([]);
  expect(failed.stats.cacheHit).toBe(false);
  expect(failed.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "database-source-contract", severity: "error" }),
  ]));
  expect((await checkProject(offline)).upToDate).toBe(false);
  expect(await readFile(join(options.outDir, "app.manifest.json"), "utf8")).toBe(before);
  expect((await databaseSources(root, "check")).ok).toBe(false);
});

test("off does not require database adoption; enforce blocks without source contracts even with writeOnError", async () => {
  const { root, options } = await fixture();
  await rm(join(root, "database.sources.json"));
  const off = await compileProject({ ...options, databaseGovernance: { mode: "off" } });
  expect(off.diagnostics.filter(item => item.severity === "error")).toEqual([]);
  const before = await readFile(join(options.outDir, "application.ts"), "utf8");
  const failed = await compileProject({ ...options, writeOnError: true });
  expect(failed.written).toEqual([]);
  expect(failed.diagnostics.some(item => item.code === "database-source-contract")).toBe(true);
  expect(await readFile(join(options.outDir, "application.ts"), "utf8")).toBe(before);
  expect((await checkProject(options)).upToDate).toBe(false);
});

test("successful compilation checks live drift again on incremental cache hits and preserves artifacts", async () => {
  const { root, options } = await fixture();
  const compiler = createIncrementalCompiler();
  expect((await compiler.compile(options)).diagnostics.filter(item => item.severity === "error")).toEqual([]);
  expect((await checkProject(options)).upToDate).toBe(true);
  const before = await readFile(join(options.outDir, "app.manifest.json"), "utf8");
  await writeFile(join(root, "db/state.json"), JSON.stringify({ rls: false }));
  const failed = await compiler.compile({ ...options, writeOnError: true }, []);
  expect(failed.diagnostics.some(item => item.code === "database-catalog-rls-disabled")).toBe(true);
  expect(failed.written).toEqual([]);
  expect(failed.stats.cacheHit).toBe(false);
  expect(await readFile(join(options.outDir, "app.manifest.json"), "utf8")).toBe(before);
  await writeFile(join(root, "db/state.json"), JSON.stringify({ rls: true }));
  expect((await compiler.compile(options, [])).diagnostics.filter(item => item.severity === "error")).toEqual([]);
});

test("missing connection, stale sources and cached module declarations cannot silently pass", async () => {
  const { root, options } = await fixture();
  const missing = await checkDatabaseGovernance(root, {
    ...options.databaseGovernance!, databaseUrl: undefined, databaseUrlEnv: "SUPACLOUD_TEST_ABSENT_DATABASE_URL",
  });
  expect(missing.some(item => item.code === "database-catalog-unavailable")).toBe(true);
  expect(await checkDatabaseGovernance(root, options.databaseGovernance)).toEqual([]);
  await writeFile(join(root, "db/modules.mjs"), fakeTransport + "export default [];");
  expect((await checkDatabaseGovernance(root, options.databaseGovernance)).length).toBeGreaterThan(0);
  await writeFile(join(root, "db/modules.mjs"), fakeTransport + `export default ${JSON.stringify(module)};`);
  expect(await checkDatabaseGovernance(root, options.databaseGovernance)).toEqual([]);
  await writeFile(join(root, "db/schema.ts"), "export const changed = true;");
  expect((await checkDatabaseGovernance(root, options.databaseGovernance))[0]?.code).toBe("database-source-contract");
});

test("malformed manifests, unreadable SQL and module/connection exceptions fail without secrets", async () => {
  const { root, options } = await fixture();
  for (const body of [
    "throw new Error('postgres://private-secret@example.invalid/private');",
    `export default ${JSON.stringify({ ...module, tables: [1] })};`,
    `export default ${JSON.stringify({ ...module, functions: [{ name: "public.lookup", security: "invoker", source: "missing.sql" }] })};`,
  ]) {
    await writeFile(join(root, "db/modules.mjs"), body);
    const result = await checkDatabaseGovernance(root, options.databaseGovernance);
    expect(result.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("private-secret");
  }
  await writeFile(join(root, "db/modules.mjs"), fakeTransport + `export default ${JSON.stringify(module)};`);
  await writeFile(join(root, "db/state.json"), JSON.stringify({ error: true }));
  const result = await checkDatabaseGovernance(root, options.databaseGovernance);
  expect(result[0]?.code).toBe("database-catalog-unavailable");
  expect(JSON.stringify(result)).not.toContain("private-secret");
});

test("SQL lint warnings are enforced as compiler errors", async () => {
  const { root, options } = await fixture();
  const policyModule = {
    ...module,
    policies: [{
      name: "items_read",
      table: "public.items",
      operation: "select",
      roles: ["authenticated"],
      source: "db/policies.sql",
      tests: ["tests/items-policy.sql"],
    }],
  };
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "db/policies.sql"), "create policy items_read on public.items;");
  await writeFile(join(root, "tests/items-policy.sql"), "select 1;");
  await writeFile(join(root, "db/modules.mjs"), fakeTransport + `export default ${JSON.stringify(policyModule)};`);

  const result = await compileProject({ ...options, writeOnError: true });
  expect(result.written).toEqual([]);
  expect(result.diagnostics.filter(item => item.code === "database-sql-contract")).toEqual([
    expect.objectContaining({ severity: "error", message: expect.stringContaining("db/policies.sql:1:") }),
    expect.objectContaining({ severity: "error", message: expect.stringContaining("db/policies.sql:") }),
  ]);
});

test("bundled Node entry resolves the Bun worker and checks catalog drift", async () => {
  const { root, options } = await fixture();
  const outdir = await mkdtemp(join(import.meta.dir, "../.database-governance-build-"));
  roots.push(outdir);
  const build = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "database-governance.ts"),
      join(import.meta.dir, "database-governance-worker.ts"),
    ],
    outdir,
    target: "node",
    external: ["@supacloud/db", "@supacloud/db/source-contracts"],
  });
  expect(build.success).toBe(true);
  for (const rls of [true, false]) {
    await writeFile(join(root, "db/state.json"), JSON.stringify({ rls }));
    const child = Bun.spawn(["node", "--input-type=module", "-e", `
      import { checkDatabaseGovernance } from "./database-governance.js";
      console.log(JSON.stringify(await checkDatabaseGovernance(
        ${JSON.stringify(root)}, ${JSON.stringify(options.databaseGovernance)}
      )));
    `], { cwd: outdir, stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual(rls ? [] : [
      expect.objectContaining({ severity: "error", code: "database-catalog-rls-disabled" }),
    ]);
  }
});

test("CLI loads the same mode and returns failure without generating artifacts", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "supacloud.config.mjs"), `export default {
    root: "src", strict: false, databaseGovernance: { mode: "enforce" }
  };`);
  const config = await loadSupacloudConfig(root);
  expect(config.databaseGovernance?.mode).toBe("enforce");
  await rm(join(root, "database.sources.json"));
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "cli.ts"), "compile", "--json"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(status).toBe(1);
  expect(JSON.parse(stdout)).toMatchObject({ ok: false, written: [],
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "database-source-contract" })]) });
});

test.each(["check", "enforce"] as const)("watch in %s mode checks SQL changes outside the compiler source root", async (mode) => {
  const { root, options } = await fixture();
  const events: string[] = [];
  handle = watchProject({
    ...options, rootDir: join(root, "src"), debounceMs: 10,
    databaseGovernance: { ...options.databaseGovernance!, mode },
    onEvent: event => events.push(`${event.type}:${event.initial}`),
  });
  expect((await handle.ready).type).toBe("compiled");
  await writeFile(join(root, "migrations/002.sql"), "SELECT 2;");
  const deadline = Date.now() + 10_000;
  while (!events.includes("compile-error:false") && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect(events).toContain("compile-error:false");
}, 20_000);
