import * as ts from "@typescript/typescript6";
import type { Diagnostic } from "./types";

export const SOURCE_SEMANTIC_DIAGNOSTIC_CODES = {
  "source-unsafe-any": { errorCode: "SC6009", docsUrl: "https://supacloud.dev/errors/SC6009" },
  "source-floating-promise": { errorCode: "SC6010", docsUrl: "https://supacloud.dev/errors/SC6010" },
  "source-non-exhaustive-switch": { errorCode: "SC6011", docsUrl: "https://supacloud.dev/errors/SC6011" },
} as const;

/** Inspect values at use sites, including types resolved through imported declarations. */
export function scanSourceSemantics(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  file: string,
  rootDir: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (code: keyof typeof SOURCE_SEMANTIC_DIAGNOSTIC_CODES, node: ts.Node, message: string): void => {
    diagnostics.push({
      severity: "error", code, ...SOURCE_SEMANTIC_DIAGNOSTIC_CODES[code], file, message,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };
  const unsafe = (value: ts.Expression, target: ts.Type): void => {
    if (isUnknownBoundary(target, checker) || containsAny(target, checker, new Set<ts.Type>(), rootDir)) return;
    if (containsAny(checker.getTypeAtLocation(value), checker, new Set<ts.Type>(), rootDir)) {
      report("source-unsafe-any", value,
        "An any-containing value cannot enter a concrete type. Quarantine it as unknown and decode it before use.");
    }
  };
  const declared = (node: ts.TypeNode): void => {
    let hasAnyKeyword = false;
    const visitType = (child: ts.Node): void => {
      if (child.kind === ts.SyntaxKind.AnyKeyword) hasAnyKeyword = true;
      ts.forEachChild(child, visitType);
    };
    visitType(node);
    if (!hasAnyKeyword && containsAny(checker.getTypeAtLocation(node), checker, new Set<ts.Type>(), rootDir)) {
      report("source-unsafe-any", node, "Declared application types must not hide any through aliases or generic arguments.");
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node)) declared(node.type);
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)
      || ts.isPropertySignature(node)) && node.type) declared(node.type);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const type = checker.getTypeAtLocation(node.name);
      if (node.type) unsafe(node.initializer, type);
      else if (ts.isIdentifier(node.name) && !ts.isArrowFunction(node.initializer)
        && !ts.isFunctionExpression(node.initializer) && !(type.flags & ts.TypeFlags.Any)
        && containsAny(type, checker, new Set<ts.Type>(), rootDir)) {
        report("source-unsafe-any", node.name, "Inferred values must not contain any, including nested and generic result types.");
      }
    }
    if (ts.isPropertyDeclaration(node) && !node.type && node.initializer
      && containsAny(checker.getTypeAtLocation(node.name), checker, new Set<ts.Type>(), rootDir)) {
      report("source-unsafe-any", node.name, "Inferred class fields must not propagate any. Decode the value or quarantine it as unknown.");
    }
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !node.type && node.body) {
      const signature = checker.getSignatureFromDeclaration(node);
      if (signature && containsAny(checker.getReturnTypeOfSignature(signature), checker, new Set<ts.Type>(), rootDir)) {
        report("source-unsafe-any", node.name ?? node,
          "Inferred function results must not propagate any. Return unknown at the boundary or a decoded concrete result.");
      }
    }
    if (ts.isFunctionLike(node) && node.type) declared(node.type);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      unsafe(node.right, checker.getTypeAtLocation(node.left));
    }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      unsafe(node.expression, checker.getTypeAtLocation(node));
    }
    if (ts.isReturnStatement(node) && node.expression) {
      let owner: ts.Node | undefined = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (owner && ts.isFunctionLike(owner) && owner.type) {
        const signature = checker.getSignatureFromDeclaration(owner);
        if (signature) unsafe(node.expression, checker.getReturnTypeOfSignature(signature));
      }
    }
    if (ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node);
      const parameters = signature?.getParameters() ?? [];
      node.arguments.forEach((argument, index) => {
        const parameter = parameters[index] ?? parameters.at(-1);
        if (!parameter) return;
        const type = checker.getTypeOfSymbolAtLocation(parameter, node);
        const declaration = parameter.valueDeclaration;
        const rest = declaration && ts.isParameter(declaration) && declaration.dotDotDotToken;
        const target = rest ? checker.getIndexTypeOfType(type, ts.IndexKind.Number) ?? type : type;
        unsafe(argument, target);
      });
    }
    if (ts.isExpressionStatement(node)) {
      const expression = unwrap(node.expression);
      if (isPromise(checker.getTypeAtLocation(expression), checker, expression) && !handlesRejection(expression, checker)) {
        report("source-floating-promise", node,
          "Promise work must be awaited, returned, or have a callable rejection handler. void does not establish cancellation ownership.");
      }
    }
    if (ts.isSwitchStatement(node)) {
      const type = checker.getTypeAtLocation(node.expression);
      const members = type.isUnion() ? type.types : [type];
      if (members.every(isFiniteLiteral)) {
        const cases = node.caseBlock.clauses.filter(ts.isCaseClause);
        const missing = members.filter((member) => !cases.some((clause) =>
          sameLiteral(member, checker.getTypeAtLocation(clause.expression))));
        if (missing.length > 0) {
          report("source-non-exhaustive-switch", node.expression,
            `Switch is missing cases for ${missing.map((member) => checker.typeToString(member)).join(", ")}. A default branch does not replace explicit union cases.`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return diagnostics;
}

function containsAny(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
  rootDir: string,
): boolean {
  if (type.flags & ts.TypeFlags.Any) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) return type.types.some((part) => containsAny(part, checker, seen, rootDir));
  // Imported class instances are opaque handles, not application data transfer objects.
  const declarations = type.getSymbol()?.declarations ?? [];
  if (declarations.some((declaration) => ts.isClassDeclaration(declaration)
    && (declaration.getSourceFile().isDeclarationFile
      || declaration.getSourceFile().fileName.replaceAll("\\", "/").includes("/node_modules/")))) return false;
  const arguments_ = isTypeReference(type) ? checker.getTypeArguments(type) : type.aliasTypeArguments ?? [];
  if (arguments_.some((argument) => containsAny(argument, checker, seen, rootDir))) return true;
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).some((signature) => {
    const declaration = signature.getDeclaration();
    return declaration !== undefined && isWithinRoot(declaration.getSourceFile().fileName, rootDir)
      && (containsAny(checker.getReturnTypeOfSignature(signature), checker, seen, rootDir)
        || signature.getParameters().some((parameter) =>
          containsAny(checker.getTypeOfSymbolAtLocation(parameter, declaration), checker, seen, rootDir)));
  })) return true;
  // Library handles may have intentionally loose methods; inspect application DTOs, not entire SDK internals.
  return checker.getPropertiesOfType(type).some((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    return declaration !== undefined
      && isWithinRoot(declaration.getSourceFile().fileName, rootDir)
      && containsAny(checker.getTypeOfSymbolAtLocation(property, declaration), checker, seen, rootDir);
  });
}

function isWithinRoot(file: string, rootDir: string): boolean {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedRoot = rootDir.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

function isUnknownBoundary(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Void)) return true;
  const promised = promiseArgument(type, checker);
  return promised !== undefined && Boolean(promised.flags & ts.TypeFlags.Unknown);
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isVoidExpression(expression)) expression = expression.expression;
  return expression;
}

function isPromise(type: ts.Type, checker: ts.TypeChecker, node: ts.Node): boolean {
  return type.isUnion()
    ? type.types.some((part) => isPromise(part, checker, node))
    : promiseArgument(type, checker) !== undefined;
}

function handlesRejection(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return false;
  const { name, expression: receiver } = expression.expression;
  if (!isPromise(checker.getTypeAtLocation(receiver), checker, receiver)) return false;
  const handler = name.text === "catch" ? expression.arguments[0]
    : name.text === "then" ? expression.arguments[1] : undefined;
  return handler !== undefined && checker.getTypeAtLocation(handler).getCallSignatures().length > 0;
}

function isFiniteLiteral(type: ts.Type): boolean {
  return Boolean(type.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral
    | ts.TypeFlags.BigIntLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Null | ts.TypeFlags.Undefined));
}

function sameLiteral(left: ts.Type, right: ts.Type): boolean {
  if (left.flags !== right.flags) return false;
  if (left.isStringLiteral() && right.isStringLiteral()) return left.value === right.value;
  if (left.isNumberLiteral() && right.isNumberLiteral()) return left.value === right.value;
  return left === right;
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return Boolean(type.flags & ts.TypeFlags.Object)
    && "objectFlags" in type && typeof type.objectFlags === "number"
    && Boolean(type.objectFlags & ts.ObjectFlags.Reference) && "target" in type;
}

function promiseArgument(type: ts.Type, checker: ts.TypeChecker): ts.Type | undefined {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return undefined;
  const then = checker.getPropertyOfType(type, "then");
  const declaration = then?.valueDeclaration ?? then?.declarations?.[0];
  if (!then || !declaration || checker.getTypeOfSymbolAtLocation(then, declaration).getCallSignatures().length === 0) return undefined;
  const awaited = checker.getAwaitedType(type);
  return awaited !== type ? awaited : undefined;
}
