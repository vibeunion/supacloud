import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as ts from "@typescript/typescript6";
import type { Diagnostic, TypeSafetyOptions } from "./types";

const DEFAULT_EXCLUDES = [
  "**/*.test.ts",
  "**/*.spec.ts",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/fixtures/**",
  "**/generated/**",
  "**/dist/**",
  "**/*.d.ts",
];

const DIAGNOSTIC_META = {
  "generated-any": { errorCode: "SC6001", docsUrl: "https://supacloud.dev/errors/SC6001" },
  "source-any": { errorCode: "SC6002", docsUrl: "https://supacloud.dev/errors/SC6002" },
  "source-type-assertion": { errorCode: "SC6003", docsUrl: "https://supacloud.dev/errors/SC6003" },
  "source-non-null-assertion": { errorCode: "SC6004", docsUrl: "https://supacloud.dev/errors/SC6004" },
  "source-implicit-widening": { errorCode: "SC6005", docsUrl: "https://supacloud.dev/errors/SC6005" },
} as const;

export interface TypeSafetyScanOptions extends TypeSafetyOptions {
  rootDir: string;
  include?: string[];
  outDir?: string;
  strict?: boolean;
}

export function scanGeneratedArtifacts(
  artifacts: Record<string, string | undefined>,
  strict = true,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [file, content] of Object.entries(artifacts)) {
    if (content === undefined) continue;
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const node of descendantsOfKind(sourceFile, isAnyKeyword)) {
      diagnostics.push(makeDiagnostic(
        "generated-any",
        `生成产物 ${file} 包含 any；严格生成模式要求使用 unknown、具体接口或泛型约束。`,
        sourceFile,
        node,
        strict,
      ));
    }
  }
  return diagnostics;
}

export function scanProductionSource(options: TypeSafetyScanOptions): Diagnostic[] {
  const rootDir = resolve(options.rootDir);
  const configPath = join(rootDir, "tsconfig.json");
  const projectConfig: { options: ts.CompilerOptions; errors: readonly ts.Diagnostic[] } = existsSync(configPath)
    ? readProjectConfig(configPath)
    : {
        options: {
          strict: true,
          skipLibCheck: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
        errors: [],
      };
  const include = options.include ?? ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
  const rootNames = ts.sys.readDirectory(
    rootDir,
    [".ts", ".tsx", ".mts", ".cts"],
    ["node_modules", "dist"],
    include,
  ).filter((file) => isProductionSourcePath(
    rootDir,
    file,
    [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])],
  ));
  const compilerOptions: ts.CompilerOptions = { ...projectConfig.options, noEmit: true };
  const host = ts.createCompilerHost(compilerOptions);
  host.getCurrentDirectory = () => rootDir;
  const program = ts.createProgram(rootNames, compilerOptions, host);
  const outDir = options.outDir ? normalizeRelative(rootDir, options.outDir) : undefined;
  const excludes = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  const sourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) => isProductionSource(rootDir, sourceFile, excludes, outDir));

  const diagnostics: Diagnostic[] = [...projectConfig.errors, ...program.getOptionsDiagnostics()]
    .map((diagnostic) => ({
      severity: "error",
      code: "source-config",
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      file: diagnostic.file ? normalizeRelative(rootDir, diagnostic.file.fileName) : normalizeRelative(rootDir, configPath),
      line: diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
        : undefined,
      errorCode: `TS${diagnostic.code}`,
    }));
  const checker = program.getTypeChecker();
  for (const sourceFile of sourceFiles) {
    scanSourceFile(sourceFile, checker, rootDir, diagnostics, options.strict ?? false);
  }
  return diagnostics;
}

function scanSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  rootDir: string,
  diagnostics: Diagnostic[],
  strict: boolean,
): void {
  for (const node of descendantsOfKind(sourceFile, isAnyKeyword)) {
    diagnostics.push(makeDiagnostic(
      "source-any",
      "生产源码使用了显式 any；请改用 unknown、具体接口或泛型约束。",
      sourceFile,
      node,
      strict,
      rootDir,
    ));
  }

  for (const node of descendants(sourceFile)) {
    if (ts.isAsExpression(node)) {
      if (ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent)) continue;
      const assertedType = node.type.getText(sourceFile);
      if (assertedType === "const") continue;
      diagnostics.push(makeDiagnostic(
        "source-type-assertion",
        `生产源码包含类型断言 ${node.getText(sourceFile)}；请优先使用类型守卫、satisfies 或显式边界解析。`,
        sourceFile,
        node,
        strict,
        rootDir,
      ));
    } else if (ts.isTypeAssertionExpression(node)) {
      if (ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent)) continue;
      diagnostics.push(makeDiagnostic(
        "source-type-assertion",
        `生产源码包含类型断言 ${node.getText(sourceFile)}；请优先使用类型守卫、satisfies 或显式边界解析。`,
        sourceFile,
        node,
        strict,
        rootDir,
      ));
    } else if (ts.isNonNullExpression(node)) {
      diagnostics.push(makeDiagnostic(
        "source-non-null-assertion",
        `生产源码包含非空断言 ${node.getText(sourceFile)}；请显式处理 null/undefined。`,
        sourceFile,
        node,
        strict,
        rootDir,
      ));
    }
  }

  for (const declaration of descendantsOfKind(sourceFile, ts.isVariableDeclaration)) {
    const initializer = declaration.initializer;
    if (!initializer || declaration.type) continue;
    const declarationType = checker.getTypeAtLocation(declaration.name);
    const initializerType = checker.getTypeAtLocation(initializer);
    for (const name of bindingNames(declaration.name)) {
      if (isAnyType(checker.getTypeAtLocation(name))) {
        diagnostics.push(makeDiagnostic(
          "source-any",
          "生产源码中的变量被推断为 any；请为边界数据提供解析类型或显式 unknown。",
          sourceFile,
          name,
          strict,
          rootDir,
        ));
      }
    }
    if (isAnyType(declarationType)) continue;
    if (isLetDeclaration(declaration)
      && isLiteralSyntax(initializer)
      && !isLiteralType(declarationType)) {
      diagnostics.push(makeDiagnostic(
        "source-implicit-widening",
        `变量 ${declaration.name.getText(sourceFile)} 的字面量类型从 ${checker.typeToString(initializerType, initializer)} 隐式宽化为 ${checker.typeToString(declarationType, declaration)}；请补充类型或使用 const。`,
        sourceFile,
        declaration,
        strict,
        rootDir,
      ));
    }
    if (ts.isObjectLiteralExpression(initializer)
      && isConstDeclaration(declaration)
      && initializer.getText(sourceFile).length > 0
      && initializer.properties.some((property) =>
        ts.isPropertyAssignment(property)
        && property.initializer !== undefined
        && !ts.isAsExpression(property.initializer)
        && isLiteralExpression(property.initializer))) {
      diagnostics.push(makeDiagnostic(
        "source-implicit-widening",
        `常量对象 ${declaration.name.getText(sourceFile)} 的字面量属性会隐式宽化；请补充对象类型或使用 as const。`,
        sourceFile,
        declaration,
        strict,
        rootDir,
      ));
    }
  }

  for (const parameter of descendantsOfKind(sourceFile, ts.isParameter)) {
    if (parameter.type) continue;
    for (const name of bindingNames(parameter.name)) {
      if (isAnyType(checker.getTypeAtLocation(name))) {
        diagnostics.push(makeDiagnostic(
          "source-any",
          "生产源码中的参数被推断为 any；请补充参数类型。",
          sourceFile,
          name,
          strict,
          rootDir,
        ));
      }
    }
  }
}

function readProjectConfig(configPath: string): {
  options: ts.CompilerOptions;
  errors: readonly ts.Diagnostic[];
} {
  const config = ts.readConfigFile(configPath, (file) => readFileSync(file, "utf8"));
  if (config.error) return { options: {}, errors: [config.error] };
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  return { options: parsed.options, errors: parsed.errors };
}

function isProductionSource(
  rootDir: string,
  sourceFile: ts.SourceFile,
  excludes: string[],
  outDir?: string,
): boolean {
  const relativePath = normalizeRelative(rootDir, sourceFile.fileName);
  if (sourceFile.isDeclarationFile || relativePath.startsWith("../") || relativePath.includes("node_modules/")) return false;
  if (outDir && (relativePath === outDir || relativePath.startsWith(`${outDir}/`))) return false;
  return !excludes.some((pattern) => globMatches(relativePath, pattern));
}

function isProductionSourcePath(rootDir: string, filePath: string, excludes: string[]): boolean {
  const relativePath = normalizeRelative(rootDir, filePath);
  return !relativePath.startsWith("../")
    && !relativePath.includes("node_modules/")
    && !excludes.some((pattern) => globMatches(relativePath, pattern));
}

function globMatches(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "§/")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/§\//g, "(?:.*/)?")
    .replace(/§§/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  );
}

function isLiteralExpression(node: ts.Node | undefined): node is ts.Expression {
  if (!node) return false;
  return [
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.TrueKeyword,
    ts.SyntaxKind.FalseKeyword,
  ].includes(node.kind);
}

function isLiteralSyntax(node: ts.Node): boolean {
  return ts.isStringLiteral(node)
    || ts.isNumericLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword;
}

function isLiteralType(type: ts.Type): boolean {
  return (type.flags & (
    ts.TypeFlags.StringLiteral
    | ts.TypeFlags.NumberLiteral
    | ts.TypeFlags.BooleanLiteral
    | ts.TypeFlags.BigIntLiteral
  )) !== 0;
}

function isAnyType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0;
}

function isLetDeclaration(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Let) !== 0;
}

function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function descendants(root: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    result.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return result;
}

function descendantsOfKind<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return result;
}

function makeDiagnostic(
  code: keyof typeof DIAGNOSTIC_META,
  message: string,
  fileOrSourceFile: string | ts.SourceFile,
  node: ts.Node,
  strict: boolean,
  rootDir?: string,
): Diagnostic {
  const sourceFile = typeof fileOrSourceFile === "string" ? undefined : fileOrSourceFile;
  const file = typeof fileOrSourceFile === "string"
    ? fileOrSourceFile
    : rootDir
      ? normalizeRelative(rootDir, fileOrSourceFile.fileName)
      : fileOrSourceFile.fileName;
  const meta = DIAGNOSTIC_META[code];
  return {
    severity: strict ? "error" : "warn",
    code,
    message,
    file,
    line: sourceFile
      ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      : undefined,
    errorCode: meta.errorCode,
    docsUrl: meta.docsUrl,
  };
}

function normalizeRelative(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join("/").replace(/^\.\//, "");
}

function isAnyKeyword(node: ts.Node): node is ts.KeywordTypeNode {
  return node.kind === ts.SyntaxKind.AnyKeyword;
}
