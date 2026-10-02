import * as ts from "@typescript/typescript6";
import { resolve } from "node:path";

export interface ApiOrigin { module: string; name: string; }

/** Bind one source for lexical identity only. Never load dependencies or execute application code. */
export function bindApiSource(source: ts.SourceFile): { source: ts.SourceFile; checker: ts.TypeChecker } {
  const file = resolve(source.fileName);
  const bound = ts.createSourceFile(file, source.text, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.ES2022 };
  const host: ts.CompilerHost = {
    getSourceFile: name => resolve(name) === file ? bound : undefined,
    getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => process.cwd(),
    getDirectories: () => [], fileExists: name => resolve(name) === file,
    readFile: name => resolve(name) === file ? source.text : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  };
  const program = ts.createProgram([file], options, host);
  return { source: bound, checker: program.getTypeChecker() };
}

function importedFrom(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current && ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)
    ? current.moduleSpecifier.text : undefined;
}

export function apiOrigin(expression: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Node>()): ApiOrigin | undefined {
  if (seen.has(expression)) return undefined;
  seen.add(expression);
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return apiOrigin(expression.expression, checker, seen);
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const name = ts.isPropertyAccessExpression(expression) ? expression.name.text
      : ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
    const namespace = apiOrigin(expression.expression, checker, seen);
    return namespace?.name === "*" && name ? { module: namespace.module, name } : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  for (const declaration of symbol?.declarations ?? []) {
    if (ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly) {
      const module = importedFrom(declaration);
      if (module) return { module, name: (declaration.propertyName ?? declaration.name).text };
    }
    if (ts.isNamespaceImport(declaration) && !declaration.parent.isTypeOnly) {
      const module = importedFrom(declaration);
      if (module) return { module, name: "*" };
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const)) {
      return apiOrigin(declaration.initializer, checker, seen);
    }
  }
  return undefined;
}
