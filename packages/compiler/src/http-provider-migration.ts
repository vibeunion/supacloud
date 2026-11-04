import * as ts from "@supacloud/db/typescript";
import type { SourceMigrationResult } from "./migrations";
import type { Diagnostic } from "./types";
import { apiOrigin, bindApiSource } from "./api-source";

async function providerArgument(node: ts.Node, checker: ts.TypeChecker): Promise<boolean> {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  if (!ts.isCallExpression(current.parent) || current.parent.expression !== current) return false;
  current = current.parent;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const parent = current.parent;
  if (!ts.isCallExpression(parent) || !parent.arguments.some(argument => argument === current)) return false;
  const owner = (await apiOrigin(parent.expression, checker));
  return owner?.name === "provideHttpClient" && ["@supacloud/app", "@supacloud/app/http"].includes(owner.module);
}

/** Never replaces the root array helper in constructor/custom pipeline usages. */
export async function migrateHttpProviderImports(source: string, fileName: string): Promise<SourceMigrationResult> {
  const parsed = await ts.createSourceFile(fileName, source);
  await using bound = await bindApiSource(parsed);
  const sf = bound.source, checker = bound.checker;
  const edits: { start: number; end: number; text: string }[] = [];
  const issues: SourceMigrationResult["issues"] = [];
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@supacloud/app" || !statement.importClause
      || (statement.importClause.phaseModifier === ts.SyntaxKind.TypeKeyword)) continue;
    const named = statement.importClause.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const specifier = named.elements.find(item => !item.isTypeOnly && (item.propertyName ?? item.name).text === "withInterceptors");
    if (!specifier) continue;
    const symbol = (await checker.getSymbolAtLocation(specifier.name));
    if (!symbol) continue;
    const uses: ts.Identifier[] = [];
    const visit = async (node: ts.Node): Promise<void> => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node) && (await checker.getSymbolAtLocation(node)) === symbol) uses.push(node);
      (await ts.forEachChildAsync(node, visit));
    };
    (await visit(sf));
    if (!(await ts.asyncSome(uses, async node => (await providerArgument(node, checker))))) continue;
    if (!(await ts.asyncEvery(uses, async node => (await providerArgument(node, checker)))) || statement.attributes) {
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
      const clause = ts.factory.updateImportClause(statement.importClause, statement.importClause.name,
        remaining.length ? ts.factory.updateNamedImports(named, remaining) : undefined);
      const updated = ts.factory.updateImportDeclaration(statement, statement.modifiers, clause, statement.moduleSpecifier, statement.attributes);
      const text = (await ts.printNode(updated)).trimStart()
        + newline + `import { ${specifier.getText(sf)} } from "@supacloud/app/http";`;
      // Keep comments before the statement outside the replaced range.
      const withoutLeading = text.replace(/^(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)+/, "");
      edits.push({ start: statement.getStart(sf), end: statement.end, text: withoutLeading });
    }
  }
  const checkNamespace = async (node: ts.Node): Promise<void> => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && (await providerArgument(node, checker))) {
      const origin = (await apiOrigin(node, checker));
      if (origin?.module === "@supacloud/app" && origin.name === "withInterceptors") issues.push({
        code: "http-provider-migration-namespace", file: fileName,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        message: "Use a dedicated named import from @supacloud/app/http; namespace rewrites require manual review.",
      });
    }
    (await ts.forEachChildAsync(node, checkNamespace));
  };
  (await checkNamespace(sf));
  if (issues.length) return { changed: false, content: source, replacements: 0, issues };
  let content = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  return { changed: edits.length > 0, content, replacements: edits.length, issues: [] };
}

export async function scanHttpProviderImports(source: ts.SourceFile, file: string): Promise<Diagnostic[]> {
  if (!source.text.includes("@supacloud/app")) return [];
  await using bound = await bindApiSource(source);
  const { source: sf, checker } = bound;
  const diagnostics: Diagnostic[] = [];
  const visit = async (node: ts.Node): Promise<void> => {
    if (ts.isCallExpression(node)) {
      const origin = (await apiOrigin(node.expression, checker));
      if (origin?.module === "@supacloud/app" && origin.name === "withInterceptors" && (await providerArgument(node.expression, checker))) {
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
    (await ts.forEachChildAsync(node, visit));
  };
  (await visit(sf));
  return diagnostics;
}
