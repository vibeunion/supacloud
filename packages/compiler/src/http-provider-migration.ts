import * as ts from "@typescript/typescript6";
import type { SourceMigrationResult } from "./migrations";
import type { Diagnostic } from "./types";
import { apiOrigin, bindApiSource } from "./api-source";

function providerArgument(node: ts.Node, checker: ts.TypeChecker): boolean {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  if (!ts.isCallExpression(current.parent) || current.parent.expression !== current) return false;
  current = current.parent;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const parent = current.parent;
  if (!ts.isCallExpression(parent) || !parent.arguments.some(argument => argument === current)) return false;
  const owner = apiOrigin(parent.expression, checker);
  return owner?.name === "provideHttpClient" && ["@supacloud/app", "@supacloud/app/http"].includes(owner.module);
}

/** Never replaces the root array helper in constructor/custom pipeline usages. */
export function migrateHttpProviderImports(source: string, fileName: string): SourceMigrationResult {
  const bound = bindApiSource(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true));
  const sf = bound.source, checker = bound.checker;
  const edits: { start: number; end: number; text: string }[] = [];
  const issues: SourceMigrationResult["issues"] = [];
  const printer = ts.createPrinter({ newLine: source.includes("\r\n") ? ts.NewLineKind.CarriageReturnLineFeed : ts.NewLineKind.LineFeed });
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@supacloud/app" || !statement.importClause
      || statement.importClause.isTypeOnly) continue;
    const named = statement.importClause.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const specifier = named.elements.find(item => !item.isTypeOnly && (item.propertyName ?? item.name).text === "withInterceptors");
    if (!specifier) continue;
    const symbol = checker.getSymbolAtLocation(specifier.name);
    if (!symbol) continue;
    const uses: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) uses.push(node);
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (!uses.some(node => providerArgument(node, checker))) continue;
    if (!uses.every(node => providerArgument(node, checker)) || statement.attributes) {
      issues.push({ code: "http-provider-migration-ambiguous", file: fileName,
        line: sf.getLineAndCharacterOfPosition(specifier.getStart(sf)).line + 1,
        message: "withInterceptors also has non-provider uses; split the bindings manually before migration.",
      });
      continue;
    }
    const remaining = named.elements.filter(item => item !== specifier);
    if (remaining.length === 0 && !statement.importClause.name) {
      edits.push({ start: statement.moduleSpecifier.getStart(sf), end: statement.moduleSpecifier.end, text: '"@supacloud/app/http"' });
    } else {
      const clause = ts.factory.updateImportClause(statement.importClause, false, statement.importClause.name,
        remaining.length ? ts.factory.updateNamedImports(named, remaining) : undefined);
      const updated = ts.factory.updateImportDeclaration(statement, statement.modifiers, clause, statement.moduleSpecifier, statement.attributes);
      const text = printer.printNode(ts.EmitHint.Unspecified, updated, sf).trimStart()
        + newline + `import { ${specifier.getText(sf)} } from "@supacloud/app/http";`;
      // Keep comments before the statement outside the replaced range.
      const withoutLeading = text.replace(/^(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)+/, "");
      edits.push({ start: statement.getStart(sf), end: statement.end, text: withoutLeading });
    }
  }
  const checkNamespace = (node: ts.Node): void => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && providerArgument(node, checker)) {
      const origin = apiOrigin(node, checker);
      if (origin?.module === "@supacloud/app" && origin.name === "withInterceptors") issues.push({
        code: "http-provider-migration-namespace", file: fileName,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        message: "Use a dedicated named import from @supacloud/app/http; namespace rewrites require manual review.",
      });
    }
    ts.forEachChild(node, checkNamespace);
  };
  checkNamespace(sf);
  if (issues.length) return { changed: false, content: source, replacements: 0, issues };
  let content = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  return { changed: edits.length > 0, content, replacements: edits.length, issues: [] };
}

export function scanHttpProviderImports(source: ts.SourceFile, file: string): Diagnostic[] {
  if (!source.text.includes("@supacloud/app")) return [];
  const { source: sf, checker } = bindApiSource(source);
  const diagnostics: Diagnostic[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const origin = apiOrigin(node.expression, checker);
      if (origin?.module === "@supacloud/app" && origin.name === "withInterceptors" && providerArgument(node.expression, checker)) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const end = sf.getLineAndCharacterOfPosition(node.end);
        diagnostics.push({ severity: "error", code: "http-provider-import-mismatch", file,
          line: start.line + 1, column: start.character,
          endLine: end.line + 1, endColumn: end.character,
          message: "The root withInterceptors returns an interceptor array, not a provideHttpClient feature.",
          suggestion: "Import withInterceptors from @supacloud/app/http. Preview the http-provider-entrypoint source migration; mixed/namespace uses require manual review.",
          docsUrl: "https://supacloud.dev/errors/http-provider-import-mismatch",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return diagnostics;
}
