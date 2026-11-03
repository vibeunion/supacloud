import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import { renderGraphql } from "./graphql";
import { writeFileIfChanged } from "./generate";
import { assertGraphqlOptions } from "./graphql-options";
import { parseDatabaseContractManifest, type DatabaseContractManifest } from "./database-contract-manifest";
import type { GraphqlOptions } from "./types";

export interface DatabaseContractsOptions {
  rootDir: string;
  outDir: string;
  /** Official PostgREST snapshot. Omit when the project does not use PostgREST. */
  postgrestTypes?: string;
  /** Drizzle query-builder module. Omit when the project does not use Drizzle. */
  drizzleSchema?: string;
  /** Explicit identity/role label for reviewing snapshot provenance. Not an authorization proof. */
  role: string;
  /** Role-scoped pg_graphql snapshot exported by graphql-schema. Omit when GraphQL is unused. */
  graphql?: GraphqlOptions;
  /** Ordered complete migration history. */
  migrations: readonly string[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function importPath(out: string, path: string): string {
  const value = relative(out, path).replaceAll("\\", "/").replace(/\.(?:d\.)?[cm]?ts$/, "");
  return value.startsWith(".") ? value : `./${value}`;
}

export function parseDatabaseContractsOptions(value: unknown, directory: string): DatabaseContractsOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected database contracts configuration");
  const allowed = ["rootDir", "outDir", "postgrestTypes", "drizzleSchema", "role", "graphql", "migrations"];
  if (Object.keys(value).some((name) => !allowed.includes(name))) throw new TypeError("Unknown database contracts option");
  const field = (name: string) => {
    const result: unknown = Reflect.get(value, name);
    if (typeof result !== "string" || !result.trim()) throw new TypeError(`Missing database contracts ${name}`);
    return result;
  };
  const optionalPath = (name: string): string | undefined => {
    if (!Object.hasOwn(value, name)) return undefined;
    return field(name);
  };
  const postgrestTypes = optionalPath("postgrestTypes");
  const drizzleSchema = optionalPath("drizzleSchema");
  const graphqlPresent = Object.hasOwn(value, "graphql");
  if (!postgrestTypes && !drizzleSchema && !graphqlPresent) {
    throw new TypeError("Database contracts require postgrestTypes, drizzleSchema, or graphql");
  }
  let graphql: GraphqlOptions | undefined;
  if (graphqlPresent) {
    const candidate: unknown = Reflect.get(value, "graphql");
    assertGraphqlOptions(candidate);
    graphql = { ...candidate, schema: resolve(directory, candidate.schema) };
  }
  const migrations: unknown = Reflect.get(value, "migrations");
  if (!Array.isArray(migrations) || !migrations.every((entry): entry is string => typeof entry === "string" && entry.endsWith(".sql"))) {
    throw new TypeError("migrations must be an ordered list of SQL files");
  }
  return {
    rootDir: resolve(directory, field("rootDir")), outDir: resolve(directory, field("outDir")),
    ...(postgrestTypes ? { postgrestTypes: resolve(directory, postgrestTypes) } : {}),
    ...(drizzleSchema ? { drizzleSchema: resolve(directory, drizzleSchema) } : {}),
    role: field("role"),
    ...(graphql ? { graphql } : {}),
    migrations: migrations.map((file) => resolve(directory, file)),
  };
}

async function assertPostgrestSnapshot(path: string): Promise<void> {
  const snapshot = await readFile(path, "utf8");
  const syntax = ts.createSourceFile(path, snapshot, ts.ScriptTarget.Latest, true);
  const database = syntax.statements.find((node) =>
    (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name.text === "Database"
    && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  if (!database) throw new Error("PostgREST snapshot must export Database from the official type generator");
  const program = ts.createProgram([path], {
    strict: true, noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  if (ts.getPreEmitDiagnostics(program).length) throw new Error("PostgREST snapshot has TypeScript errors");
}

/** One offline entrypoint; preserves each protocol's native type semantics and generated validators. */
export async function generateDatabaseContracts(options: DatabaseContractsOptions, check = false) {
  const rootDir = resolve(options.rootDir), outDir = resolve(options.outDir);
  const postgrestTypes = options.postgrestTypes ? resolve(rootDir, options.postgrestTypes) : undefined;
  const drizzleSchema = options.drizzleSchema ? resolve(rootDir, options.drizzleSchema) : undefined;
  if (!postgrestTypes && !drizzleSchema && !options.graphql) {
    throw new TypeError("Database contracts require postgrestTypes, drizzleSchema, or graphql");
  }
  if (postgrestTypes) await assertPostgrestSnapshot(postgrestTypes);
  const artifacts = options.graphql ? await renderGraphql({ rootDir, outDir, graphql: options.graphql }) : { diagnostics: [], files: {} };
  if (artifacts.diagnostics.some((item) => item.severity === "error")) {
    throw new Error(artifacts.diagnostics.map((item) => item.message).join("\n"));
  }
  const inputs: Record<string, string> = {};
  const addInput = async (path: string) => {
    const absolute = resolve(rootDir, path);
    inputs[relative(rootDir, absolute).replaceAll("\\", "/")] = hash(await readFile(absolute, "utf8"));
  };
  if (postgrestTypes) await addInput(postgrestTypes);
  if (drizzleSchema) {
    await addInput(drizzleSchema);
    // Track local type imports too: a split Drizzle schema must invalidate the contract.
    const drizzleProgram = ts.createProgram([drizzleSchema], {
      noEmit: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022, types: [], skipLibCheck: true,
    });
    for (const source of drizzleProgram.getSourceFiles()) {
      if (!source.isDeclarationFile && !source.fileName.includes("/node_modules/")) await addInput(source.fileName);
    }
  }
  if (options.graphql) await addInput(resolve(rootDir, options.graphql.schema));
  if (new Set(options.migrations.map((path) => resolve(rootDir, path))).size !== options.migrations.length) {
    throw new Error("Duplicate migration in database contracts configuration");
  }
  for (const path of options.migrations) await addInput(path);
  const barrel = ["// GENERATED BY @supacloud/compiler database-contracts. Do not edit."];
  if (postgrestTypes) {
    barrel.push(`export type { Database } from ${JSON.stringify(importPath(outDir, postgrestTypes))};`);
    barrel.push('export type { QueryData, QueryResult, QueryError } from "@supabase/supabase-js";');
  }
  if (drizzleSchema) barrel.push(`export type DrizzleSchema = typeof import(${JSON.stringify(importPath(outDir, drizzleSchema))});`);
  if (options.graphql) barrel.push('export * from "./graphql";');
  barrel.push("");
  const files: Record<string, string> = { ...artifacts.files, "database.ts": barrel.join("\n") };
  const manifest = {
    version: 1, role: options.role,
    inputs: Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))),
    migrationOrder: options.migrations.map((path) => relative(rootDir, resolve(rootDir, path)).replaceAll("\\", "/")),
    outputs: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([file, text]) => [file, hash(text)])),
  };
  const fingerprint = hash(JSON.stringify({
    inputs: manifest.inputs,
    migrationOrder: manifest.migrationOrder,
  }));
  const typedManifest: DatabaseContractManifest = parseDatabaseContractManifest({ ...manifest, fingerprint });
  files["database.manifest.json"] = JSON.stringify(typedManifest, null, 2) + "\n";
  const mismatches: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    const path = resolve(outDir, file);
    let current: string | undefined;
    try { current = await readFile(path, "utf8"); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (current !== content) mismatches.push(file);
  }
  if (!check) {
    await mkdir(outDir, { recursive: true });
    // Manifest is the completion marker and is written last.
    for (const [file, content] of Object.entries(files)) await writeFileIfChanged(resolve(outDir, file), content);
  }
  return { upToDate: mismatches.length === 0, mismatches, written: check ? [] : mismatches, manifest: typedManifest };
}

export async function runDatabaseContractsFile(path: string, check = false) {
  const absolute = resolve(path);
  const value: unknown = JSON.parse(await readFile(absolute, "utf8"));
  return generateDatabaseContracts(parseDatabaseContractsOptions(value, dirname(absolute)), check);
}
