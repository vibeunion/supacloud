import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import { databaseSources, parseDatabaseSourcesConfig, type DatabaseSourcesConfig } from "./source-contracts";
import { migrationFunctionIdentities, rpcSourceContract, renderRpcSourceTypes } from "./rpc-source-contracts";

const roots: string[] = [];
const config: DatabaseSourcesConfig = {
  version: 1, schema: ["db/schema.ts"], functions: "db/functions", migrations: "migrations",
  contracts: "db/contracts", audit: "output/database-audit", consumers: ["src", "scripts", "tests"],
  auditConsumers: [], role: "service_role",
};
const source = `CREATE FUNCTION public.lookup(p_id bigint, p_values numeric[] DEFAULT '{}')
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
REVOKE ALL ON FUNCTION public.lookup(bigint,numeric[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup(bigint,numeric[]) TO service_role;`;
async function file(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "db-source-contracts-"));
  roots.push(root);
  for (const directory of ["src", "scripts", "tests", "db/functions", "migrations"]) await mkdir(join(root, directory), { recursive: true });
  await file(root, "database.sources.json", JSON.stringify(config));
  await file(root, "db/schema.ts", 'export { table } from "./tables";');
  await file(root, "db/tables.ts", "export const table = 'typed structure';");
  await file(root, "db/functions/lookup.sql", source);
  await file(root, "migrations/001.sql", source);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("generate is offline, writes only contracts, and check detects source/schema/output drift without writes", async () => {
  const root = await project();
  expect((await databaseSources(root)).findings.some(item => item.code === "stale-contract")).toBe(true);
  expect((await databaseSources(root, "generate")).written).toEqual([
    "db/contracts/rpc-catalog.json", "db/contracts/rpc-types.ts", "db/contracts/manifest.json",
  ]);
  expect((await databaseSources(root)).ok).toBe(true);
  const catalog = await readFile(join(root, "db/contracts/rpc-catalog.json"), "utf8");
  expect(catalog).not.toContain("CREATE FUNCTION");
  const before = await readFile(join(root, "db/contracts/manifest.json"), "utf8");
  await file(root, "db/tables.ts", "export const table = 'changed structure';");
  expect((await databaseSources(root)).ok).toBe(false);
  expect(await readFile(join(root, "db/contracts/manifest.json"), "utf8")).toBe(before);
  expect((await databaseSources(root, "generate")).ok).toBe(true);
  await file(root, "db/functions/lookup.sql", source.replace("RETURNS jsonb", "RETURNS text"));
  expect((await databaseSources(root)).ok).toBe(false);
  expect((await databaseSources(root, "generate")).ok).toBe(true);
  await file(root, "db/contracts/rpc-types.ts", "export type Bypassed = true;");
  expect((await databaseSources(root)).findings.some(item => item.file.endsWith("rpc-types.ts"))).toBe(true);
});

test("generation refuses recorded migration removal, reorder and rewrites; new forward migrations invalidate checks", async () => {
  const root = await project();
  expect((await databaseSources(root, "generate")).ok).toBe(true);
  await file(root, "migrations/002.sql", "SELECT 2;");
  expect((await databaseSources(root)).ok).toBe(false);
  expect((await databaseSources(root, "generate")).ok).toBe(true);
  await file(root, "migrations/001.sql", "SELECT 1;");
  const report = await databaseSources(root, "generate");
  expect(report.findings.some(item => item.code === "migration-rewritten")).toBe(true);
  expect(report.written).toEqual([]);
});

test("static audit references fail, including aliases/path composition; comments and protocol snapshots remain valid", async () => {
  const root = await project();
  await file(root, "legacy/schema.sql", "-- PostgreSQL database dump\nCREATE TABLE public.example(id integer);");
  await file(root, "src/read.ts", `
// readFile("legacy/schema.sql") is only a comment.
const base = "output/database-audit";
const dump = join(base, "schema.sql");
readFile(dump);
`);
  const report = await databaseSources(root, "generate");
  expect(report.written).toEqual([]);
  expect(report.findings.some(item => item.file === "src/read.ts" && item.code === "audit-input")).toBe(true);
  await file(root, "src/read.ts", 'readFile(new URL("../legacy/schema.sql", import.meta.url));');
  expect((await databaseSources(root)).findings.some(item => item.code === "audit-input")).toBe(true);
  await file(root, "src/read.ts", '// readFile("legacy/schema.sql")\nreadFile("graphql/schema.graphql");');
  expect((await databaseSources(root, "generate")).ok).toBe(true);
});

test("audit exceptions are explicit scripts and cannot be imported into ordinary source", async () => {
  const root = await project();
  await file(root, "database.sources.json", JSON.stringify({ ...config, auditConsumers: ["scripts/audit.ts"] }));
  await file(root, "scripts/audit.ts", 'readFile("output/database-audit/schema.sql");');
  expect((await databaseSources(root, "generate")).ok).toBe(true);
  await file(root, "tests/ordinary.ts", 'import "../scripts/audit.ts";');
  expect((await databaseSources(root)).findings.some(item => item.code === "audit-input")).toBe(true);
  await file(root, "tests/ordinary.ts", 'import "../scripts/audit";');
  expect((await databaseSources(root)).findings.some(item => item.code === "audit-input")).toBe(true);
  expect(() => parseDatabaseSourcesConfig({ ...config, auditConsumers: ["tests/ordinary.ts"] })).toThrow("scripts/");
});

test("assessment before adoption is read-only and provides migration steps instead of rewriting dumps", async () => {
  const root = await project();
  await rm(join(root, "database.sources.json"));
  await file(root, "bootstrap/schema.sql", "-- historic dump");
  await file(root, "src/types.ts", 'readFile("bootstrap/schema.sql");');
  const before = (await readdir(root, { recursive: true })).sort();
  const result = await databaseSources(root, "assess");
  expect(result.steps.length).toBeGreaterThan(0);
  expect(result.findings.map(item => item.code)).toEqual(["audit-input", "adoption-required"]);
  expect(result.written).toEqual([]);
  expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
});

test("paths reject traversal, overlapping output and symlink escapes before any writes", async () => {
  expect(() => parseDatabaseSourcesConfig({ ...config, contracts: "../outside" })).toThrow();
  expect(() => parseDatabaseSourcesConfig({ ...config, contracts: "db" })).toThrow("separate");
  const root = await project(), outside = await project();
  await symlink(outside, join(root, "db/contracts"));
  const report = await databaseSources(root, "generate");
  expect(report.ok).toBe(false);
  expect(report.written).toEqual([]);
  expect(report.findings.some(item => item.message.includes("Symlink"))).toBe(true);
});

test("one source owns one exact overload; ACL parser excludes bodies, foreign targets and default privilege guesses", async () => {
  const contract = await rpcSourceContract(source, config.role);
  expect(contract).toMatchObject({ identity: "public.lookup(bigint, numeric[])", callable: true, returnType: "jsonb" });
  expect(contract.parameters[1]?.optional).toBe(true);
  for (const sql of [
    source + source,
    source + "DROP TABLE public.example;",
    source.replace("public.lookup(bigint,numeric[]) TO", "public.foreign(bigint,numeric[]) TO"),
    "CREATE FUNCTION public.implicit() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;",
  ]) await expect(rpcSourceContract(sql, config.role)).rejects.toThrow();
  const hidden = await rpcSourceContract(source + "REVOKE EXECUTE ON FUNCTION public.lookup(bigint,numeric[]) FROM service_role;", config.role);
  expect(hidden.callable).toBe(false);
  const grantOption = await rpcSourceContract(source + "REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.lookup(bigint,numeric[]) FROM service_role;", config.role);
  expect(grantOption.callable).toBe(true);
  const publicOnly = await rpcSourceContract(source + "GRANT EXECUTE ON FUNCTION public.lookup(bigint,numeric[]) TO PUBLIC; REVOKE EXECUTE ON FUNCTION public.lookup(bigint,numeric[]) FROM service_role;", config.role);
  expect(publicOnly.callable).toBe(true);
});

test("new migration functions require source ownership; explicit renames and drops preserve the final inventory", async () => {
  const root = await project();
  await file(root, "migrations/002.sql", "CREATE FUNCTION public.missing() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;");
  expect((await databaseSources(root, "generate")).findings.some(item => item.code === "unowned-function")).toBe(true);
  const identities = await migrationFunctionIdentities([
    source,
    "ALTER FUNCTION public.lookup(bigint,numeric[]) RENAME TO previous; DROP FUNCTION public.previous(bigint,numeric[]);",
  ]);
  expect(identities.size).toBe(0);
});

test("generated types preserve overloads, optional parameters, numeric precision and unknown results", async () => {
  const root = await project();
  const overload = await rpcSourceContract(`CREATE FUNCTION public.lookup(p_name text) RETURNS bigint LANGUAGE sql AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup(text) TO service_role;`, config.role);
  const rendered = renderRpcSourceTypes([await rpcSourceContract(source, config.role), overload]);
  expect(rendered).toContain('"p_values"?: Array<number | string | null> | null');
  expect(rendered).not.toMatch(/\bany\b/);
  await file(root, "types.ts", rendered);
  const base = `
import type { RpcArgs, RpcResult } from "./types";
const numeric: RpcArgs<"public.lookup"> = { p_id: "9223372036854775807" };
const nullableArray: RpcArgs<"public.lookup"> = { p_id: 1, p_values: [null, "1.234"] };
const named: RpcArgs<"public.lookup"> = { p_name: "name" };
type Assert<T extends true> = T;
type UnknownResult = Assert<unknown extends RpcResult<"public.lookup"> ? true : false>;
`;
  const diagnostics = async (text: string) => {
    const path = join(root, "compile.ts");
    await file(root, "compile.ts", text);
    return ts.getPreEmitDiagnostics(ts.createProgram([path], {
      strict: true, noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    }));
  };
  expect((await diagnostics(base)).map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
  expect((await diagnostics(base + 'const invalid: RpcArgs<"public.lookup"> = { p_id: true };')).length).toBeGreaterThan(0);
});

test("new source modules pass scoped strict TypeScript diagnostics", () => {
  const files = ["source-contracts.ts", "rpc-source-contracts.ts", "source-contracts-cli.ts", "source-contracts.test.ts"]
    .map(name => resolve(import.meta.dir, name));
  const program = ts.createProgram(files, {
    strict: true, noEmit: true, skipLibCheck: true, types: ["bun"], target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(item => !item.file || files.includes(resolve(item.file.fileName)));
  expect(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
});
