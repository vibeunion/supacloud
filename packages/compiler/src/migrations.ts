import { rename, readFile, writeFile, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import { checkMigrationDependencies } from "./migration-policy";

export interface SourceMigrationIssue {
  code: string;
  message: string;
  file: string;
  line?: number;
}

export interface SourceMigrationResult {
  changed: boolean;
  content: string;
  replacements: number;
  issues: SourceMigrationIssue[];
}

export interface SupaCloudMigration {
  id: string;
  from: string;
  to: string;
  description: string;
  apply(source: string, fileName: string): SourceMigrationResult;
}

export interface MigrateProjectOptions {
  rootDir: string;
  include?: string[];
  write?: boolean;
  /** Source-format checkpoints, not npm package versions. Both are required together. */
  fromVersion?: string;
  toVersion?: string;
}

export interface MigrateFileResult {
  file: string;
  changed: boolean;
  replacements: number;
  issues: SourceMigrationIssue[];
}

export interface MigrateProjectResult {
  write: boolean;
  migrations: Array<Pick<SupaCloudMigration, "id" | "from" | "to" | "description">>;
  files: MigrateFileResult[];
  changedFiles: string[];
  issues: SourceMigrationIssue[];
}

const ROUTE_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete", "Head", "Options"]);

const MIGRATION_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
};

function migrationCompilerOptions(rootDir?: string): ts.CompilerOptions {
  if (!rootDir) return MIGRATION_COMPILER_OPTIONS;
  const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists);
  if (!configPath) return MIGRATION_COMPILER_OPTIONS;
  const configHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (_diagnostic: ts.Diagnostic): void => {},
  } satisfies Parameters<typeof ts.getParsedCommandLineOfConfigFile>[2];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, configHost);
  if (!parsed || parsed.errors.length > 0) return MIGRATION_COMPILER_OPTIONS;
  return { ...parsed.options, noEmit: true, skipLibCheck: true };
}

function propertyName(property: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)) return property.text;
  return undefined;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function resolveSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (!symbol) return undefined;
  for (let guard = 0; guard < 4 && (symbol.flags & ts.SymbolFlags.Alias) !== 0; guard += 1) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (aliased === symbol) break;
    symbol = aliased;
  }
  return symbol;
}

function symbolForExpression(expression: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  const location = ts.isIdentifier(expression)
    ? expression
    : ts.isPropertyAccessExpression(expression)
      ? expression.name
      : ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression)
        ? expression
        : undefined;
  return location ? resolveSymbol(checker.getSymbolAtLocation(location), checker) : undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isDefineRouteContractCall(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const name = node.expression.getText(node.getSourceFile());
  if (name === "defineRouteContract" || name.endsWith(".defineRouteContract")) return true;
  return resolveSymbol(checker.getSymbolAtLocation(node.expression), checker)?.name === "defineRouteContract";
}

function isRouteDecoratorCall(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const name = node.expression.getText(node.getSourceFile());
  if (ts.isIdentifier(node.expression) && ROUTE_DECORATORS.has(node.expression.text)) return true;
  if (ROUTE_DECORATORS.has(name)) return true;
  const resolved = resolveSymbol(checker.getSymbolAtLocation(node.expression), checker);
  return resolved ? ROUTE_DECORATORS.has(resolved.name) : false;
}

function resolveStaticObjectLiteral(
  input: ts.Expression | undefined,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): ts.ObjectLiteralExpression | undefined {
  if (!input) return undefined;
  const expression = unwrapExpression(input);
  if (seen.has(expression)) return undefined;
  seen.add(expression);
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (ts.isCallExpression(expression) && isDefineRouteContractCall(expression, checker)) {
    return resolveStaticObjectLiteral(expression.arguments[0], checker, seen);
  }

  const symbol = symbolForExpression(expression, checker);
  for (const declaration of symbol?.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const resolved = resolveStaticObjectLiteral(declaration.initializer, checker, seen);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

interface RouteResponseMigrationPlan {
  replacementsByFile: Map<string, TextReplacement[]>;
  issues: SourceMigrationIssue[];
}

function displayFile(rootDir: string, fileName: string): string {
  const path = relative(rootDir, fileName);
  return path && !path.startsWith("..") ? path : fileName;
}

function createMigrationProgram(
  fileNames: readonly string[],
  sourceOverrides: ReadonlyMap<string, string>,
  rootDir?: string,
): ts.Program {
  const compilerOptions = migrationCompilerOptions(rootDir);
  const host = ts.createCompilerHost(compilerOptions);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const currentDirectory = host.getCurrentDirectory.bind(host);
  host.fileExists = (fileName): boolean => sourceOverrides.has(resolve(fileName)) || fileExists(fileName);
  host.readFile = (fileName): string | undefined => sourceOverrides.get(resolve(fileName)) ?? readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = sourceOverrides.get(resolve(fileName));
    return source === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, source, languageVersion, true);
  };
  host.getCurrentDirectory = () => rootDir ?? currentDirectory();
  return ts.createProgram(fileNames, compilerOptions, host);
}

function routeResponseProperties(object: ts.ObjectLiteralExpression): {
  response: ts.PropertyAssignment | undefined;
  hasResponses: boolean;
  duplicateResponse: boolean;
} {
  const responseProperties = object.properties.filter((property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) && propertyName(property.name) === "response",
  );
  return {
    response: responseProperties[0],
    hasResponses: object.properties.some((property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
      && propertyName(property.name) === "responses",
    ),
    duplicateResponse: responseProperties.length > 1,
  };
}

function planRouteResponseMigration(
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  rootDir: string,
  includedFiles: ReadonlySet<string>,
): RouteResponseMigrationPlan {
  const objects = new Map<string, ts.ObjectLiteralExpression>();
  const issues: SourceMigrationIssue[] = [];
  const issueKeys = new Set<string>();

  const addIssue = (issue: SourceMigrationIssue): void => {
    const key = `${issue.code}:${issue.file}:${issue.line ?? 0}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(issue);
  };

  for (const sourceFile of sourceFiles) {
    const sourcePath = resolve(sourceFile.fileName);
    if (!includedFiles.has(sourcePath)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isRouteDecoratorCall(node, checker)) {
        const options = node.arguments[1];
        const object = options && resolveStaticObjectLiteral(options, checker);
        if (object) {
          const objectPath = resolve(object.getSourceFile().fileName);
          const properties = routeResponseProperties(object);
          if (properties.response) {
            if (!includedFiles.has(objectPath)) {
              addIssue({
                code: "route-response-outside-migration-root",
                message: "Route contract is defined outside the migration file set; migrate its response property manually before upgrading.",
                file: displayFile(rootDir, objectPath),
                line: lineOf(object.getSourceFile(), properties.response),
              });
            } else {
              objects.set(`${objectPath}:${object.getStart(object.getSourceFile())}`, object);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const replacementsByFile = new Map<string, TextReplacement[]>();
  for (const object of objects.values()) {
    const sourceFile = object.getSourceFile();
    const properties = routeResponseProperties(object);
    const response = properties.response;
    if (!response) continue;
    const file = displayFile(rootDir, sourceFile.fileName);
    if (properties.duplicateResponse) {
      addIssue({
        code: "route-response-duplicate",
        message: "Deprecated route contract contains multiple response properties; resolve it manually before migrating.",
        file,
        line: lineOf(sourceFile, response),
      });
    } else if (properties.hasResponses) {
      addIssue({
        code: "route-response-conflict",
        message: "Deprecated response cannot be migrated while responses is already declared; resolve the status map manually.",
        file,
        line: lineOf(sourceFile, response),
      });
    } else {
      const replacements = replacementsByFile.get(resolve(sourceFile.fileName)) ?? [];
      replacements.push({
        start: response.getStart(sourceFile),
        end: response.getEnd(),
        text: `responses: { 200: ${response.initializer.getText(sourceFile)} }`,
      });
      replacementsByFile.set(resolve(sourceFile.fileName), replacements);
    }
  }

  return { replacementsByFile, issues };
}

function applyReplacements(source: string, replacements: readonly TextReplacement[]): string {
  let content = source;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    content = `${content.slice(0, replacement.start)}${replacement.text}${content.slice(replacement.end)}`;
  }
  return content;
}

function migrateRouteResponse(source: string, fileName: string): SourceMigrationResult {
  const absoluteFile = resolve(fileName);
  const sourceOverrides = new Map([[absoluteFile, source]]);
  const program = createMigrationProgram([absoluteFile], sourceOverrides);
  const sourceFile = program.getSourceFile(absoluteFile);
  if (!sourceFile) {
    return {
      changed: false,
      content: source,
      replacements: 0,
      issues: [{
        code: "migration-source-unavailable",
        message: "Unable to parse the source file for migration.",
        file: fileName,
      }],
    };
  }
  const plan = planRouteResponseMigration(
    [sourceFile],
    program.getTypeChecker(),
    resolve("."),
    new Set([absoluteFile]),
  );
  const replacements = plan.replacementsByFile.get(absoluteFile) ?? [];
  return {
    changed: replacements.length > 0,
    content: applyReplacements(source, replacements),
    replacements: replacements.length,
    issues: plan.issues,
  };
}

function migrateRouteResponseProject(
  files: readonly string[],
  rootDir: string,
  sourceByPath: ReadonlyMap<string, string>,
): { results: Map<string, SourceMigrationResult>; issues: SourceMigrationIssue[] } {
  const absoluteFiles = files.map((file) => resolve(file));
  const program = createMigrationProgram(absoluteFiles, sourceByPath, rootDir);
  const sourceFiles = absoluteFiles
    .map((file) => program.getSourceFile(file))
    .filter((file): file is ts.SourceFile => file !== undefined);
  const plan = planRouteResponseMigration(
    sourceFiles,
    program.getTypeChecker(),
    rootDir,
    new Set(absoluteFiles),
  );
  const results = new Map<string, SourceMigrationResult>();
  for (const [file, replacements] of plan.replacementsByFile) {
    const source = sourceByPath.get(file);
    if (source === undefined) continue;
    results.set(file, {
      changed: replacements.length > 0,
      content: applyReplacements(source, replacements),
      replacements: replacements.length,
      issues: plan.issues.filter((issue) => resolve(rootDir, issue.file) === file),
    });
  }
  for (const issue of plan.issues) {
    const path = resolve(rootDir, issue.file);
    if (!results.has(path) && sourceByPath.has(path)) {
      results.set(path, {
        changed: false,
        content: sourceByPath.get(path) ?? "",
        replacements: 0,
        issues: [issue],
      });
    }
  }
  return { results, issues: plan.issues };
}

export const SUPACLOUD_MIGRATIONS: SupaCloudMigration[] = [
  {
    id: "route-response-to-responses",
    from: "0.11.0",
    to: "0.12.0",
    description: "Replace deprecated route response schemas with explicit HTTP status maps.",
    apply: migrateRouteResponse,
  },
];

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.supacloud-migrate-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function migrateProject(options: MigrateProjectOptions): Promise<MigrateProjectResult> {
  const rootDir = resolve(options.rootDir);
  let migrations = SUPACLOUD_MIGRATIONS;
  const preflightIssues: SourceMigrationIssue[] = [];
  if (options.fromVersion !== undefined || options.toVersion !== undefined) {
    migrations = [];
    const checkpoints = new Set(SUPACLOUD_MIGRATIONS.flatMap(({ from, to }) => [from, to]));
    let current = options.fromVersion;
    if (!current || !options.toVersion || !checkpoints.has(current) || !checkpoints.has(options.toVersion)) {
      preflightIssues.push({
        code: "migration-version-unsupported", file: "package.json",
        message: `Supply both supported source-format checkpoints: ${[...checkpoints].join(", ")}`,
      });
    } else {
      const visited = new Set<string>();
      while (current !== options.toVersion) {
        const next = SUPACLOUD_MIGRATIONS.filter((migration) => migration.from === current);
        if (visited.has(current) || next.length !== 1 || !next[0]) {
          preflightIssues.push({
            code: "migration-path-unavailable", file: "package.json",
            message: `No unambiguous forward migration from ${current} to ${options.toVersion}`,
          });
          break;
        }
        visited.add(current);
        migrations.push(next[0]);
        current = next[0].to;
      }
    }
    if (preflightIssues.length === 0) {
      for (const message of await checkMigrationDependencies(rootDir)) {
        preflightIssues.push({ code: "migration-dependency-incompatible", file: "package.json", message });
      }
    }
    if (preflightIssues.length > 0) {
      return { write: options.write === true, migrations: [], files: [], changedFiles: [], issues: preflightIssues };
    }
  }
  const include = options.include ?? ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
  const files = ts.sys.readDirectory(rootDir, [".ts", ".tsx", ".mts", ".cts"], ["node_modules", "dist", "generated"], include)
    .sort();
  const results: MigrateFileResult[] = [];
  const issues: SourceMigrationIssue[] = [];
  const pendingWrites = new Map<string, string>();
  const sourceByPath = new Map<string, string>();
  const issueKeys = new Set<string>();

  const appendIssues = (items: readonly SourceMigrationIssue[]): void => {
    for (const issue of items) {
      const key = `${issue.code}:${issue.file}:${issue.line ?? 0}`;
      if (issueKeys.has(key)) continue;
      issueKeys.add(key);
      issues.push(issue);
    }
  };

  for (const filePath of files) {
    sourceByPath.set(resolve(filePath), await readFile(filePath, "utf8"));
  }
  const originalSources = new Map(sourceByPath);
  const writtenFiles = new Set<string>();

  for (const migration of migrations) {
    const projectResults = migration.id === "route-response-to-responses"
      ? migrateRouteResponseProject(files, rootDir, sourceByPath)
      : undefined;
    if (projectResults) appendIssues(projectResults.issues);

    for (const filePath of files) {
      const absoluteFile = resolve(filePath);
      const file = relative(rootDir, absoluteFile) || absoluteFile;
      const before = sourceByPath.get(absoluteFile);
      if (before === undefined) continue;
      const result = projectResults?.results.get(absoluteFile) ?? migration.apply(before, file);
      sourceByPath.set(absoluteFile, result.content);
      if (result.changed && result.issues.length === 0) {
        pendingWrites.set(absoluteFile, result.content);
      }
      if (!projectResults) appendIssues(result.issues);
      if (result.changed || result.issues.length > 0) {
        results.push({
          file,
          changed: result.changed,
          replacements: result.replacements,
          issues: result.issues,
        });
      }
    }
  }

  if (options.write && issues.length === 0) {
    const written: string[] = [];
    try {
      for (const [path, content] of pendingWrites) {
        if (await readFile(path, "utf8") !== originalSources.get(path)) {
          throw new Error(`Source changed during migration: ${path}`);
        }
        await writeAtomically(path, content);
        written.push(path);
        writtenFiles.add(path);
      }
    } catch (error) {
      appendIssues([{ code: "migration-write-failed", file: rootDir, message: String(error) }]);
      for (const path of written.reverse()) {
        try {
          const original = originalSources.get(path);
          if (original === undefined || await readFile(path, "utf8") !== pendingWrites.get(path)) {
            throw new Error("File changed after migration; refusing to overwrite concurrent edits");
          }
          await writeAtomically(path, original);
          writtenFiles.delete(path);
        } catch (rollbackError) {
          appendIssues([{ code: "migration-rollback-failed", file: path, message: String(rollbackError) }]);
        }
      }
    }
  }

  const changedFiles = options.write && issues.length > 0
    ? [...writtenFiles].map((file) => relative(rootDir, file))
    : [...new Set(results.filter((result) => result.changed && result.issues.length === 0).map((result) => result.file))];

  return {
    write: options.write === true,
    migrations: migrations.map(({ id, from, to, description }) => ({ id, from, to, description })),
    files: results,
    changedFiles,
    issues,
  };
}

export { migrateRouteResponse };
