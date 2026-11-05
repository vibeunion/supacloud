import * as ts from "@supacloud/db/typescript";
import { resolve } from "node:path";

export interface ApiOrigin { module: string; name: string; }

/** Bind one source for lexical identity only. Never load dependencies or execute application code. */
export async function bindApiSource(source: ts.SourceFile) {
  const file = resolve(source.fileName);
  const program = await ts.createProgram([file], {
    noLib: true, noResolve: true, target: ts.ScriptTarget.ES2022,
  }, { sources: new Map([[file, source.text]]) });
  const bound = program.getSourceFile(file);
  if (!bound) { await program[Symbol.asyncDispose](); throw new Error(`Cannot bind ${file}`); }
  return { source: bound, checker: program.getTypeChecker(),
    [Symbol.asyncDispose]: async () => (await program[Symbol.asyncDispose]()) };
}

function importedFrom(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current && ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)
    ? current.moduleSpecifier.text : undefined;
}

export async function apiOrigin(expression: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Node>()): Promise<ApiOrigin | undefined> {
  if (seen.has(expression)) return undefined;
  seen.add(expression);
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression) || ts.isTypeAssertion(expression)) {
    return (await apiOrigin(expression.expression, checker, seen));
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const name = ts.isPropertyAccessExpression(expression) ? expression.name.text
      : ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
    const namespace = (await apiOrigin(expression.expression, checker, seen));
    return namespace?.name === "*" && name ? { module: namespace.module, name } : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = (await checker.getSymbolAtLocation(expression));
  for (const declaration of (await ts.declarationsOf(symbol))) {
    if (ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && ts.isImportClause(declaration.parent.parent) && declaration.parent.parent.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
      const module = importedFrom(declaration);
      if (module) return { module, name: (declaration.propertyName ?? declaration.name).text };
    }
    if (ts.isNamespaceImport(declaration) && ts.isImportClause(declaration.parent) && declaration.parent.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
      const module = importedFrom(declaration);
      if (module) return { module, name: "*" };
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const)) {
      return (await apiOrigin(declaration.initializer, checker, seen));
    }
  }
  return undefined;
}
