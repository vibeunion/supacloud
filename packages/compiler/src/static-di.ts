import * as ts from "@typescript/typescript6";
import type { Diagnostic } from "./types";

const runtimeApis = new Set([
  "inject", "createEnvironmentInjector", "runInInjectionContext", "EnvironmentInjector",
  "bootstrapBun", "runInScope", "runInRequestContext", "runInJobContext", "runInTransactionContext",
]);

/** Reject runtime DI imports even in constructors, factory functions and aliased imports. */
export function scanRuntimeDi(source: ts.SourceFile, file: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const namespaces = new Set<string>();
  const report = (node: ts.Node) => diagnostics.push({
    severity: "error", code: "runtime-injection-disallowed", errorCode: "SC2012",
    docsUrl: "https://supacloud.dev/errors/SC2012", file,
    line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    message: "Compiled applications cannot import runtime DI. Use explicit constructors and generated scope factories.",
  });
  for (const statement of source.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)
      || !/^@supacloud\/app(?:\/|$)/.test(statement.moduleSpecifier.text)) continue;
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) continue;
      const binding = statement.importClause?.namedBindings;
      if (binding && ts.isNamespaceImport(binding)) namespaces.add(binding.name.text);
      if (binding && ts.isNamedImports(binding)) for (const item of binding.elements) {
        if (!item.isTypeOnly && runtimeApis.has((item.propertyName ?? item.name).text)) report(item);
      }
    } else if (!statement.isTypeOnly) {
      if (!statement.exportClause) report(statement);
      else if (ts.isNamedExports(statement.exportClause)) for (const item of statement.exportClause.elements) {
        if (!item.isTypeOnly && runtimeApis.has((item.propertyName ?? item.name).text)) report(item);
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && namespaces.has(node.expression.text) && runtimeApis.has(node.name.text)) report(node);
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
      && namespaces.has(node.expression.text)
      && (!ts.isStringLiteral(node.argumentExpression) || runtimeApis.has(node.argumentExpression.text))) report(node);
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer)
      && namespaces.has(node.initializer.text)) report(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return diagnostics;
}
