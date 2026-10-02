import * as ts from "@typescript/typescript6";
import type { Diagnostic } from "./types";
import { apiOrigin, bindApiSource } from "./api-source";

const angularState = new Set(["@angular/core", "@supacloud/app/angular"]);
const signalBridges = new Set(["@angular/core/rxjs-interop", "@supacloud/app/angular", "@supacloud/app/rxjs"]);

/** Checks statically identifiable callbacks, not arbitrary side effects or a whole-program call graph. */
export function scanReactiveSource(input: ts.SourceFile, file: string): Diagnostic[] {
  if (!input.statements.some(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
    && (angularState.has(node.moduleSpecifier.text) || signalBridges.has(node.moduleSpecifier.text)))) return [];
  const { source, checker } = bindApiSource(input);
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<number>();
  const visit = (node: ts.Node, reactive: boolean): void => {
    if (ts.isCallExpression(node)) {
      const origin = apiOrigin(node.expression, checker);
      if (reactive && origin && signalBridges.has(origin.module)
        && ["toSignal", "toScopedSignal", "rxResource"].includes(origin.name) && !reported.has(node.pos)) {
        reported.add(node.pos);
        diagnostics.push({
          severity: "error", code: "reactive-subscription-in-computation", file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          message: `${origin.name} creates a subscription inside a reactive computation.`,
          suggestion: "Create the subscription once in its explicit owner scope, then derive state with computed. Hoisting requires ownership review; no automatic edit is safe.",
          docsUrl: "https://supacloud.dev/errors/reactive-subscription-in-computation",
        });
      }
      if (origin && angularState.has(origin.module) && ["computed", "effect", "untracked"].includes(origin.name)) {
        const callback = node.arguments[0];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          visit(callback.body, origin.name === "untracked" ? false : true);
          for (const argument of node.arguments.slice(1)) visit(argument, reactive);
          return;
        }
      }
      // Immediately invoked function expressions execute now; other nested functions do not.
      let expression: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
      if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) visit(expression.body, reactive);
    }
    if (ts.isFunctionLike(node)) {
      if (!reactive) ts.forEachChild(node, child => visit(child, false));
      return;
    }
    ts.forEachChild(node, child => visit(child, reactive));
  };
  visit(source, false);
  return diagnostics;
}
