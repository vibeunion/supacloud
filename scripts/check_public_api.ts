import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as ts from "../packages/compiler/node_modules/@typescript/typescript6/lib/typescript.js";

type ExportKind = "type" | "value" | "both";

export interface PublicApiExport {
  name: string;
  kind: ExportKind;
  signature: string;
}

export interface PublicApiSnapshot {
  format: 2;
  package: string;
  entrypoint: string;
  exports: PublicApiExport[];
}

export interface ApiTarget {
  packageName: string;
  source: string;
  snapshot: string;
}

const ROOT = resolve(import.meta.dir, "..");
const TARGETS: ApiTarget[] = [
  {
    packageName: "@supacloud/app",
    source: resolve(ROOT, "packages/app/src/index.ts"),
    snapshot: resolve(ROOT, "packages/app/public-api.json"),
  },
  {
    packageName: "@supacloud/compiler",
    source: resolve(ROOT, "packages/compiler/src/index.ts"),
    snapshot: resolve(ROOT, "packages/compiler/public-api.json"),
  },
];

const TRANSPILE_OPTIONS: ts.TranspileOptions = {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
    removeComments: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isExportKind(value: unknown): value is ExportKind {
  return value === "type" || value === "value" || value === "both";
}

function parseSnapshot(value: unknown, path: string): PublicApiSnapshot {
  if (!isRecord(value) || value.format !== 2 || typeof value.package !== "string" ||
    value.entrypoint !== "." || !Array.isArray(value.exports)) {
    throw new Error(`Invalid public API snapshot format: ${path}`);
  }

  const exports: PublicApiExport[] = [];
  for (const item of value.exports) {
    if (!isRecord(item) || typeof item.name !== "string" || !isExportKind(item.kind) ||
      typeof item.signature !== "string") {
      throw new Error(`Invalid public API export entry in snapshot: ${path}`);
    }
    exports.push({ name: item.name, kind: item.kind, signature: item.signature });
  }
  return { format: 2, package: value.package, entrypoint: ".", exports };
}

function packageProgram(target: ApiTarget): ts.Program {
  const configPath = ts.findConfigFile(dirname(target.source), ts.sys.fileExists);
  if (!configPath) throw new Error(`Cannot find tsconfig for ${target.packageName}: ${target.source}`);

  const configDiagnostics: ts.Diagnostic[] = [];
  const configHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic: ts.Diagnostic): void => {
      configDiagnostics.push(diagnostic);
    },
  } satisfies Parameters<typeof ts.getParsedCommandLineOfConfigFile>[2];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, configHost);
  if (!parsed || configDiagnostics.length > 0 || parsed.errors.length > 0) {
    const diagnostics = [...configDiagnostics, ...(parsed?.errors ?? [])]
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    throw new Error(`Cannot parse ${configPath}: ${diagnostics.join("\n")}`);
  }

  const rootNames = parsed.fileNames.includes(target.source)
    ? parsed.fileNames
    : [...parsed.fileNames, target.source];
  return ts.createProgram(rootNames, { ...parsed.options, noEmit: true });
}

function symbolKind(symbol: ts.Symbol): ExportKind {
  const value = Boolean(symbol.flags & ts.SymbolFlags.Value);
  const type = Boolean(symbol.flags & ts.SymbolFlags.Type);
  if (value && type) return "both";
  if (type) return "type";
  return "value";
}

function declarationSignature(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const declarations = symbol.declarations ?? [];
  const signatures = declarations.map((declaration) => {
    try {
      const sourceFile = declaration.getSourceFile();
      const source = ts.isVariableDeclaration(declaration)
        ? declaration.parent.parent.getText(sourceFile)
        : declaration.getText(sourceFile);
      return ts.transpileDeclaration(source, TRANSPILE_OPTIONS).outputText.trim().replaceAll("\r\n", "\n");
    } catch {
      const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
      return checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation);
    }
  }).filter((signature) => signature.length > 0);

  return [...new Set(signatures)].sort().join("\n");
}

function rejectExportStars(sourceFile: ts.SourceFile): void {
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.exportClause) {
      throw new Error("Public API snapshots require explicit exports; export * is not supported");
    }
  }
}

export function compareSnapshot(expected: PublicApiSnapshot, actual: PublicApiSnapshot): string[] {
  const changes: string[] = [];
  if (expected.format !== actual.format) changes.push(`snapshot format: ${expected.format} -> ${actual.format}`);
  if (expected.package !== actual.package) changes.push(`package: ${expected.package} -> ${actual.package}`);
  if (expected.entrypoint !== actual.entrypoint) changes.push(`entrypoint: ${expected.entrypoint} -> ${actual.entrypoint}`);

  const expectedByName = new Map(expected.exports.map((entry) => [entry.name, entry]));
  const actualByName = new Map(actual.exports.map((entry) => [entry.name, entry]));
  for (const [name, actualEntry] of actualByName) {
    const expectedEntry = expectedByName.get(name);
    if (!expectedEntry) {
      changes.push(`added ${name} (${actualEntry.kind})`);
    } else if (expectedEntry.kind !== actualEntry.kind) {
      changes.push(`changed ${name}: kind ${expectedEntry.kind} -> ${actualEntry.kind}`);
    } else if (expectedEntry.signature !== actualEntry.signature) {
      changes.push(`changed ${name}: public declaration signature`);
    }
  }
  for (const [name, expectedEntry] of expectedByName) {
    if (!actualByName.has(name)) changes.push(`removed ${name} (${expectedEntry.kind})`);
  }
  return changes.sort();
}

export async function collectPublicApi(target: ApiTarget): Promise<PublicApiSnapshot> {
  const program = packageProgram(target);
  const sourceFile = program.getSourceFile(target.source);
  if (!sourceFile) throw new Error(`Cannot load public API entrypoint: ${target.source}`);
  rejectExportStars(sourceFile);

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`Cannot resolve public API module: ${target.source}`);

  const exports = checker.getExportsOfModule(moduleSymbol)
    .map((exportSymbol): PublicApiExport => {
      const resolved = exportSymbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exportSymbol)
        : exportSymbol;
      return {
        name: exportSymbol.name,
        kind: symbolKind(resolved),
        signature: declarationSignature(resolved, checker),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return { format: 2, package: target.packageName, entrypoint: ".", exports };
}

async function readSnapshot(path: string): Promise<PublicApiSnapshot> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error(`Missing or invalid public API snapshot: ${path}`);
  }
  return parseSnapshot(value, path);
}

function snapshotText(snapshot: PublicApiSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  for (const target of TARGETS) {
    const actual = await collectPublicApi(target);
    if (update) {
      await writeFile(target.snapshot, snapshotText(actual), "utf8");
      console.log(`updated ${target.snapshot}`);
      continue;
    }
    const expected = await readSnapshot(target.snapshot);
    const changes = compareSnapshot(expected, actual);
    if (changes.length > 0) {
      throw new Error([
        `${target.packageName} public API changed. Review the change, then run:`,
        `  bun scripts/check_public_api.ts --update`,
        ...changes.map((change) => `  - ${change}`),
      ].join("\n"));
    }
    console.log(`ok ${target.packageName}: ${actual.exports.length} exported symbols`);
  }
}

if (import.meta.main) await main();
