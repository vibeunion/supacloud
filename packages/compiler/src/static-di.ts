import * as ts from "@typescript/typescript6";
import type { Diagnostic } from "./types";
import { scanReactiveSource } from "./reactive-analysis";
import { apiOrigin, bindApiSource } from "./api-source";
import { scanHttpProviderImports } from "./http-provider-migration";

const runtimeApis = new Set([
  "inject", "createEnvironmentInjector", "runInInjectionContext", "EnvironmentInjector", "Injector",
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
    suggestion: "Use constructor dependencies and generated request/job factories. Keep Angular runtime services outside the compiled application source root.",
  });
  for (const statement of source.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)
      || !(/^@supacloud\/app(?:\/|$)/.test(statement.moduleSpecifier.text)
        || statement.moduleSpecifier.text === "@angular/core")) continue;
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
  if (namespaces.size > 0) {
    const bound = bindApiSource(source);
    const protectedNamespace = (expression: ts.Expression): boolean => {
      const origin = apiOrigin(expression, bound.checker);
      return origin?.name === "*" && (origin.module === "@angular/core" || /^@supacloud\/app(?:\/|$)/.test(origin.module));
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && protectedNamespace(node.expression) && runtimeApis.has(node.name.text)) report(node);
      if (ts.isElementAccessExpression(node) && protectedNamespace(node.expression)
        && (!ts.isStringLiteral(node.argumentExpression) || runtimeApis.has(node.argumentExpression.text))) report(node);
      ts.forEachChild(node, visit);
    };
    visit(bound.source);
  }
  return [...diagnostics, ...scanReactiveSource(source, file), ...scanHttpProviderImports(source, file)];
}
