import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import { migrationFunctionIdentities, rpcSourceContract, renderRpcSourceTypes, type RpcSourceContract } from "./rpc-source-contracts";

export interface DatabaseSourcesConfig {
  version: 1;
  schema: string[];
  functions: string;
  migrations: string;
  contracts: string;
  audit: string;
  consumers: string[];
  auditConsumers: string[];
  role: string;
}
export interface SourceFinding { file: string; code: string; message: string; line?: number }
export interface DatabaseSourcesReport {
  version: 1;
  scope: "local-source-contracts";
  ok: boolean;
  findings: SourceFinding[];
  written: string[];
  steps: string[];
}
interface Input { path: string; sha256: string }
const CONFIG = "database.sources.json";
const GENERATOR = "supacloud-db/source-contracts/v1";
const skip = new Set(["node_modules", ".git", ".worktrees", ".wt", "dist", "coverage", ".next", ".svelte-kit"]);
const steps = [
  "Keep the existing append-only migration directory and deployment ledger.",
  "Review Drizzle declarations and per-function SQL against a local migration replay.",
  "Add database.sources.json; replace ordinary audit dump consumers.",
  "Run supacloud-db generate, review contracts, then add supacloud-db check to default checks.",
  "Verify PostgreSQL definitions, ACL, RLS and behavior separately before deployment.",
];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const slash = (value: string) => value.replaceAll("\\", "/");
const within = (file: string, directory: string) => file === directory || file.startsWith(`${directory}/`);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function pathValue(value: unknown): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")
    || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Expected a normalized project-relative path");
  }
  return value;
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Expected a path list");
  const result = value.map(pathValue);
  if (new Set(result).size !== result.length) throw new Error("Duplicate path");
  return result;
}
export function parseDatabaseSourcesConfig(value: unknown): DatabaseSourcesConfig {
  if (!record(value) || value.version !== 1 || Object.keys(value).some(key =>
    !["version", "schema", "functions", "migrations", "contracts", "audit", "consumers", "auditConsumers", "role"].includes(key))) {
    throw new Error("Invalid database.sources.json");
  }
  const schema = paths(value.schema), consumers = paths(value.consumers), auditConsumers = paths(value.auditConsumers);
  if (!schema.length || !consumers.length || schema.some(file => !file.endsWith(".ts"))) throw new Error("Select TypeScript schemas and consumer roots");
  if (typeof value.role !== "string" || !/^[a-z_][a-z0-9_]*$/.test(value.role)) throw new Error("Select an explicit database role");
  const config: DatabaseSourcesConfig = {
    version: 1, schema, consumers, auditConsumers, role: value.role,
    functions: pathValue(value.functions), migrations: pathValue(value.migrations),
    contracts: pathValue(value.contracts), audit: pathValue(value.audit),
  };
  const areas = [...schema, config.functions, config.migrations, config.contracts, config.audit];
  for (const [index, area] of areas.entries()) {
    if (areas.some((other, otherIndex) => index !== otherIndex && (within(area, other) || within(other, area)))) {
      throw new Error("Schema, function, migration, contract and audit paths must be separate");
    }
  }
  for (const consumer of consumers) {
    if ([config.contracts, config.audit, config.migrations, config.functions].some(area => within(consumer, area) || within(area, consumer))) {
      throw new Error("Consumer roots must be separate from database artifacts");
    }
  }
  if (auditConsumers.some(file => !consumers.some(directory => within(file, directory))
    || !file.startsWith("scripts/") || !/\.[cm]?[jt]s$/.test(file))) {
    throw new Error("Audit-only exceptions must name explicit files under scripts/");
  }
  return config;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (record(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
async function safePath(root: string, file: string): Promise<string> {
  pathValue(file);
  let current = root;
  for (const part of file.split("/")) {
    current = join(current, part);
    if (await exists(current) && (await lstat(current)).isSymbolicLink()) throw new Error(`Symlink path is not allowed: ${file}`);
  }
  return current;
}
async function filesUnder(root: string, directory: string, excluded: readonly string[] = []): Promise<string[]> {
  if (excluded.some(area => within(directory, area))) return [];
  const base = directory ? await safePath(root, directory) : root;
  if (!(await exists(base))) return [];
  const stat = await lstat(base);
  if (stat.isFile()) return [directory];
  const found: string[] = [];
  for (const entry of (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip.has(entry.name) || entry.name.startsWith(".env")) continue;
    const file = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink source is not allowed: ${file}`);
    if (entry.isDirectory()) found.push(...await filesUnder(root, file, excluded));
    else if (entry.isFile()) found.push(file);
  }
  return found;
}

/** Evaluate only bounded static path expressions. Never execute consumer code. */
function staticPaths(source: ts.SourceFile): Array<{ value: string; line: number }> {
  const bindings = new Map<string, ts.Expression>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const evaluate = (node: ts.Node, depth = 0): string | undefined => {
    if (depth > 12) return;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) {
      const binding = bindings.get(node.text);
      return binding ? evaluate(binding, depth + 1) : undefined;
    }
    if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, depth + 1);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left, depth + 1), right = evaluate(node.right, depth + 1);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const part = evaluate(span.expression, depth + 1);
        if (part === undefined) return;
        value += part + span.literal.text;
      }
      return value;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      if (name === "URL") return node.arguments?.[0] ? evaluate(node.arguments[0], depth + 1) : undefined;
      if (name === "join" || name === "resolve") {
        const parts = (node.arguments ?? []).map(argument => evaluate(argument, depth + 1));
        if (parts.every((part): part is string => part !== undefined)) return parts.join("/");
      }
    }
    return;
  };
  const references: Array<{ value: string; line: number }> = [];
  const visit = (node: ts.Node) => {
    const value = evaluate(node);
    if (value !== undefined) references.push({ value, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

async function boundaryFindings(
  root: string, config?: DatabaseSourcesConfig, schemaInputs: readonly string[] = [],
): Promise<SourceFinding[]> {
  const all = await filesUnder(root, "", config ? [config.audit, config.contracts, config.migrations] : ["output"]);
  const dumps = new Set<string>();
  for (const file of all.filter(file => file.endsWith(".sql"))) {
    if (config && within(file, config.migrations)) continue;
    const handle = await open(await safePath(root, file), "r");
    let source: string;
    try {
      const buffer = Buffer.alloc(2048);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      source = buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
    if (source.includes("-- PostgreSQL database dump") || /(?:^|\/)bootstrap\/schema\.sql$/.test(file)) dumps.add(file);
  }
  const consumers = all.filter(file => /\.[cm]?[jt]sx?$/.test(file)
    && (config ? schemaInputs.includes(file) || config.consumers.some(directory => within(file, directory))
      : !within(file, "output") && !within(file, "generated")));
  const findings: SourceFinding[] = [];
  for (const file of consumers) {
    if (config?.auditConsumers.includes(file)) continue;
    const source = ts.createSourceFile(file, await readFile(await safePath(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    const reported = new Set<number>();
    for (const reference of staticPaths(source)) {
      const candidates = [slash(relative(root, resolve(root, reference.value))),
        slash(relative(root, resolve(root, dirname(file), reference.value)))];
      if (candidates.some(candidate => dumps.has(candidate)
        || (config && (within(candidate, config.audit) || config.auditConsumers.some(script =>
          candidate === script || candidate === script.replace(/\.[cm]?[jt]s$/, "")))))
        || /(?:^|\/)bootstrap\/schema\.sql$/.test(reference.value)) {
        if (reported.has(reference.line)) continue;
        reported.add(reference.line);
        findings.push({ file, line: reference.line, code: "audit-input", message: "Ordinary source references an audit dump or audit-only script; use maintained sources or migration replay." });
      }
    }
  }
  return findings;
}

function migrationInputs(value: unknown): Input[] {
  if (!record(value) || value.generator !== GENERATOR || !Array.isArray(value.migrations)) throw new Error("Invalid previous contract manifest");
  return value.migrations.map(item => {
    if (!record(item) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("Invalid migration baseline");
    return { path: pathValue(item.path), sha256: item.sha256 };
  });
}

export async function databaseSources(
  projectRoot: string, action: "assess" | "check" | "generate" = "check",
): Promise<DatabaseSourcesReport> {
  const root = resolve(projectRoot);
  const report: DatabaseSourcesReport = { version: 1, scope: "local-source-contracts", ok: false, findings: [], written: [], steps };
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new Error("Project root must not be a symlink");
    const configPath = await safePath(root, CONFIG);
    const config = await exists(configPath)
      ? parseDatabaseSourcesConfig(JSON.parse(await readFile(configPath, "utf8"))) : undefined;
    if (!config) {
      report.findings.push(...await boundaryFindings(root));
      report.findings.push({ file: CONFIG, code: "adoption-required", message: "No database source configuration; review the adoption steps before generating contracts." });
      return report;
    }
    for (const directory of [config.functions, config.migrations, ...config.consumers]) {
      if (!(await exists(await safePath(root, directory)))) throw new Error(`Missing source directory: ${directory}`);
    }
    const inputs = new Map<string, string>();
    const input = async (file: string) => {
      const text = await readFile(await safePath(root, file), "utf8");
      inputs.set(file, hash(text));
      return text;
    };
    await input(CONFIG);
    for (const file of config.schema) {
      await input(file);
      // Follow local schema imports so splitting tables does not weaken freshness.
      const visitImports = async (path: string) => {
        const tree = ts.createSourceFile(path, await input(path), ts.ScriptTarget.Latest, true);
        const imports: string[] = [];
        const visit = (node: ts.Node) => {
          if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
            && node.moduleSpecifier.text.startsWith(".")) imports.push(node.moduleSpecifier.text);
          ts.forEachChild(node, visit);
        };
        visit(tree);
        for (const specifier of imports) {
          const base = slash(relative(root, resolve(root, dirname(path), specifier)));
          const candidates = [base, `${base}.ts`, `${base}/index.ts`];
          let target: string | undefined;
          for (const candidate of candidates) {
            const full = await safePath(root, candidate);
            if (await exists(full) && (await lstat(full)).isFile()) { target = candidate; break; }
          }
          if (!target) throw new Error(`Unresolved local schema import: ${path} -> ${specifier}`);
          if ([config.audit, config.contracts, config.migrations, config.functions].some(area => within(target, area))) {
            throw new Error(`Schema imports a non-structure artifact: ${target}`);
          }
          if (!inputs.has(target)) await visitImports(target);
        }
      };
      await visitImports(file);
    }
    report.findings.push(...await boundaryFindings(root, config, [...inputs.keys()]));
    const migrations: Input[] = [];
    const migrationSql: string[] = [];
    for (const file of (await filesUnder(root, config.migrations)).filter(file => file.endsWith(".sql")).sort()) {
      const text = await input(file);
      migrations.push({ path: file, sha256: hash(text) });
      migrationSql.push(text);
    }
    const contracts: RpcSourceContract[] = [];
    for (const file of (await filesUnder(root, config.functions)).filter(file => file.endsWith(".sql")).sort()) {
      try { contracts.push(await rpcSourceContract(await input(file), config.role)); }
      catch (error) { report.findings.push({ file, code: "function-contract", message: error instanceof Error ? error.message : "Invalid function source" }); }
    }
    if (new Set(contracts.map(item => item.identity)).size !== contracts.length) throw new Error("Duplicate function signature ownership");
    const owned = new Set(contracts.map(item => item.identity));
    for (const identity of await migrationFunctionIdentities(migrationSql)) {
      if (!owned.has(identity)) report.findings.push({
        file: config.functions, code: "unowned-function",
        message: `Explicit migration function lacks a maintained source: ${identity}`,
      });
    }
    contracts.sort((a, b) => a.identity.localeCompare(b.identity));
    const catalog = JSON.stringify({ version: 1, scope: report.scope, role: config.role, functions: contracts }, null, 2) + "\n";
    const types = renderRpcSourceTypes(contracts);
    const generated = new Map([["rpc-catalog.json", catalog], ["rpc-types.ts", types]]);
    const manifest = JSON.stringify({
      generator: GENERATOR, inputs: Object.fromEntries([...inputs].sort(([a], [b]) => a.localeCompare(b))),
      migrations, outputs: Object.fromEntries([...generated].map(([name, content]) => [name, hash(content)])),
    }, null, 2) + "\n";
    const manifestPath = await safePath(root, `${config.contracts}/manifest.json`);
    if (await exists(manifestPath)) {
      const previous = migrationInputs(JSON.parse(await readFile(manifestPath, "utf8")));
      if (previous.some((old, index) => old.path !== migrations[index]?.path || old.sha256 !== migrations[index]?.sha256)) {
        report.findings.push({ file: config.migrations, code: "migration-rewritten", message: "Previously recorded migrations were removed, reordered or rewritten. Restore history; do not regenerate the baseline." });
      }
    }
    generated.set("manifest.json", manifest);
    for (const name of generated.keys()) await safePath(root, `${config.contracts}/${name}`);
    if (action === "generate" && !report.findings.length) {
      await mkdir(await safePath(root, config.contracts), { recursive: true });
      for (const [name, content] of generated) {
        const file = `${config.contracts}/${name}`, target = await safePath(root, file);
        if (!await exists(target) || await readFile(target, "utf8") !== content) {
          await writeFile(target, content);
          report.written.push(file);
        }
      }
    } else {
      for (const [name, content] of generated) {
        const file = `${config.contracts}/${name}`, target = await safePath(root, file);
        if (!await exists(target) || await readFile(target, "utf8") !== content) {
          report.findings.push({ file, code: "stale-contract", message: "Missing or stale generated contract; explicitly generate, review and commit." });
        }
      }
    }
    report.ok = report.findings.length === 0;
  } catch (error) {
    report.findings.push({ file: CONFIG, code: "invalid-source-project", message: error instanceof Error ? error.message : "Invalid source project" });
  }
  return report;
}
