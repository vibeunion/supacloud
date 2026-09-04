import { Node, Project, SyntaxKind, type SourceFile } from "ts-morph";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { relative, sep } from "node:path";
import type { Diagnostic, TypeSafetyOptions } from "./types";

const DEFAULT_EXCLUDES = [
  "**/*.test.ts",
  "**/*.spec.ts",
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
  const project = new Project({ useInMemoryFileSystem: true });
  const diagnostics: Diagnostic[] = [];
  for (const [file, content] of Object.entries(artifacts)) {
    if (content === undefined) continue;
    const sourceFile = project.createSourceFile(file, content, { overwrite: true });
    for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword)) {
      diagnostics.push(makeDiagnostic(
        "generated-any",
        `生成产物 ${file} 包含 any；严格生成模式要求使用 unknown、具体接口或泛型约束。`,
        file,
        node,
        strict,
      ));
    }
  }
  return diagnostics;
}

export function scanProductionSource(options: TypeSafetyScanOptions): Diagnostic[] {
  const project = new Project({
    ...(existsSync(join(options.rootDir, "tsconfig.json"))
      ? { tsConfigFilePath: join(options.rootDir, "tsconfig.json") }
      : {
          compilerOptions: {
            strict: true,
            skipLibCheck: true,
          },
        }),
    skipAddingFilesFromTsConfig: true,
  });
  const include = options.include ?? ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
  project.addSourceFilesAtPaths(include.map((pattern) => `${options.rootDir}/${pattern}`));
  const outDir = options.outDir ? normalizeRelative(options.rootDir, options.outDir) : undefined;
  const excludes = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  const sourceFiles = project
    .getSourceFiles()
    .filter((sourceFile) => isProductionSource(options.rootDir, sourceFile, excludes, outDir));

  const diagnostics: Diagnostic[] = [];
  for (const sourceFile of sourceFiles) {
    scanSourceFile(sourceFile, options.rootDir, diagnostics, options.strict ?? false);
  }
  return diagnostics;
}

function scanSourceFile(
  sourceFile: SourceFile,
  rootDir: string,
  diagnostics: Diagnostic[],
  strict: boolean,
): void {
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword)) {
    diagnostics.push(makeDiagnostic(
      "source-any",
      "生产源码使用了显式 any；请改用 unknown、具体接口或泛型约束。",
      sourceFile,
      node,
      strict,
      rootDir,
    ));
  }

  for (const node of sourceFile.getDescendants()) {
    if (Node.isAsExpression(node)) {
      if (Node.isAsExpression(node.getParent()) || Node.isTypeAssertion(node.getParent())) continue;
      const assertedType = node.getTypeNode()?.getText();
      if (assertedType === "const") continue;
      diagnostics.push(makeDiagnostic(
        "source-type-assertion",
        `生产源码包含类型断言 ${node.getText()}；请优先使用类型守卫、satisfies 或显式边界解析。`,
        sourceFile,
        node,
        strict,
        rootDir,
      ));
    } else if (Node.isTypeAssertion(node)) {
      if (Node.isAsExpression(node.getParent()) || Node.isTypeAssertion(node.getParent())) continue;
      diagnostics.push(makeDiagnostic(
        "source-type-assertion",
        `生产源码包含类型断言 ${node.getText()}；请优先使用类型守卫、satisfies 或显式边界解析。`,
        sourceFile,
        node,
        strict,
        rootDir,
      ));
    } else if (Node.isNonNullExpression(node)) {
      diagnostics.push(makeDiagnostic(
        "source-non-null-assertion",
        `生产源码包含非空断言 ${node.getText()}；请显式处理 null/undefined。`,
        sourceFile,
        node,
        strict,
        rootDir,
      ));
    }
  }

  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer || declaration.getTypeNode()) continue;
    const declarationType = declaration.getType();
    const initializerType = initializer.getType();
    if (declarationType.isAny()) {
      diagnostics.push(makeDiagnostic(
        "source-any",
        "生产源码中的变量被推断为 any；请为边界数据提供解析类型或显式 unknown。",
        sourceFile,
        declaration,
        strict,
        rootDir,
      ));
      continue;
    }
    if (declaration.getVariableStatement()?.getDeclarationKind() === "let"
      && isLiteralSyntax(initializer)
      && !declarationType.isLiteral()) {
      diagnostics.push(makeDiagnostic(
        "source-implicit-widening",
        `变量 ${declaration.getName()} 的字面量类型从 ${initializerType.getText()} 隐式宽化为 ${declarationType.getText()}；请补充类型或使用 const。`,
        sourceFile,
        declaration,
        strict,
        rootDir,
      ));
    }
    if (Node.isObjectLiteralExpression(initializer)
      && declaration.getVariableStatement()?.getDeclarationKind() === "const"
      && initializer.getText().length > 0
      && initializer.getProperties().some((property) => {
        return Node.isPropertyAssignment(property)
          && property.getInitializer()?.getKind() !== SyntaxKind.AsExpression
          && isLiteralExpression(property.getInitializer());
      })) {
      diagnostics.push(makeDiagnostic(
        "source-implicit-widening",
        `常量对象 ${declaration.getName()} 的字面量属性会隐式宽化；请补充对象类型或使用 as const。`,
        sourceFile,
        declaration,
        strict,
        rootDir,
      ));
    }
  }

  for (const parameter of sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)) {
    if (!parameter.getTypeNode() && parameter.getType().isAny()) {
      diagnostics.push(makeDiagnostic(
        "source-any",
        "生产源码中的参数被推断为 any；请补充参数类型。",
        sourceFile,
        parameter,
        strict,
        rootDir,
      ));
    }
  }

}

function isProductionSource(
  rootDir: string,
  sourceFile: SourceFile,
  excludes: string[],
  outDir?: string,
): boolean {
  const relativePath = normalizeRelative(rootDir, sourceFile.getFilePath());
  if (relativePath.startsWith("../") || relativePath.includes("node_modules/")) return false;
  if (outDir && (relativePath === outDir || relativePath.startsWith(`${outDir}/`))) return false;
  return !excludes.some((pattern) => globMatches(relativePath, pattern));
}

function globMatches(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*")
    .replace(/\?/g, "[^/]");
  const optionalRoot = escaped.startsWith(".*\\/") ? "(?:.*\\/)?"
    : escaped;
  return new RegExp(`^${optionalRoot === escaped ? escaped : optionalRoot + escaped.slice(3)}$`).test(value);
}

function isLiteralExpression(node: Node | undefined): boolean {
  if (!node) return false;
  return [
    SyntaxKind.StringLiteral,
    SyntaxKind.NumericLiteral,
    SyntaxKind.TrueKeyword,
    SyntaxKind.FalseKeyword,
  ].includes(node.getKind());
}

function isLiteralSyntax(node: Node): boolean {
  return Node.isStringLiteral(node)
    || Node.isNumericLiteral(node)
    || node.getKind() === SyntaxKind.TrueKeyword
    || node.getKind() === SyntaxKind.FalseKeyword;
}

function makeDiagnostic(
  code: keyof typeof DIAGNOSTIC_META,
  message: string,
  fileOrSourceFile: string | SourceFile,
  node: Node,
  strict: boolean,
  rootDir?: string,
): Diagnostic {
  const file = typeof fileOrSourceFile === "string"
    ? fileOrSourceFile
    : rootDir
      ? normalizeRelative(rootDir, fileOrSourceFile.getFilePath())
      : fileOrSourceFile.getFilePath();
  const meta = DIAGNOSTIC_META[code];
  return {
    severity: strict ? "error" : "warn",
    code,
    message,
    file,
    line: node.getStartLineNumber(),
    errorCode: meta.errorCode,
    docsUrl: meta.docsUrl,
  };
}

function normalizeRelative(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join("/").replace(/^\.\//, "");
}
