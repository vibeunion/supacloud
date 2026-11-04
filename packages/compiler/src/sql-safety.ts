import * as ts from "@supacloud/db/typescript";
import type { Diagnostic } from "./types";

export const SQL_SAFETY_DIAGNOSTIC_CODES = {
  "sql-result-assertion": { errorCode: "SC6007", docsUrl: "https://supacloud.dev/errors/SC6007" },
  "sql-raw-dynamic": { errorCode: "SC6008", docsUrl: "https://supacloud.dev/errors/SC6008" },
} as const;

/**
 * Check Drizzle SQL operations using resolved symbols, including aliases and
 * re-exports. This is a type-escape guard, not an SQL parser or injection proof.
 */
export async function scanDrizzleSql(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  file: string,
  strict: boolean,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const importedSql = async (expression: ts.Expression): Promise<boolean> => {
    const symbol = (await checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(expression) ? expression.name : expression,
    ));
    if (!symbol) return false;
    const target = symbol.flags & ts.SymbolFlags.Alias ? (await checker.getAliasedSymbol(symbol)) : symbol;
    return target.name === "sql" && ((await ts.declarationsOf(target))).some((declaration) =>
      /(?:^|\/)node_modules\/drizzle-orm\//.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
  };
  const report = (code: keyof typeof SQL_SAFETY_DIAGNOSTIC_CODES, node: ts.Node, message: string) => {
    diagnostics.push({
      severity: strict ? "error" : "warn", code, ...SQL_SAFETY_DIAGNOSTIC_CODES[code],
      message, file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    });
  };
  const visit = async (node: ts.Node): Promise<void> => {
    if (ts.isTaggedTemplateExpression(node) && (await importedSql(node.tag))
      && node.typeArguments?.some((type) => type.kind !== ts.SyntaxKind.UnknownKeyword)) {
      report("sql-result-assertion", node,
        "Drizzle sql<T> asserts a result type without checking SQL or decoding rows. Use sql<unknown> and a schema decoder at the result boundary.");
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "raw" && (await importedSql(node.expression.expression))) {
      const argument = node.arguments[0];
      if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
        report("sql-raw-dynamic", node,
          "Dynamic sql.raw bypasses parameter binding. Interpolate values with sql templates; keep reviewed static DDL in migrations.");
      }
    }
    (await ts.forEachChildAsync(node, visit));
  };
  (await visit(sourceFile));
  return diagnostics;
}
