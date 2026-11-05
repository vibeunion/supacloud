import * as ts from "@supacloud/db/typescript";
import type { Diagnostic } from "./types";

export const SOURCE_SEMANTIC_DIAGNOSTIC_CODES = {
  "source-unsafe-any": { errorCode: "SC6009", docsUrl: "https://supacloud.dev/errors/SC6009" },
  "source-floating-promise": { errorCode: "SC6010", docsUrl: "https://supacloud.dev/errors/SC6010" },
  "source-non-exhaustive-switch": { errorCode: "SC6011", docsUrl: "https://supacloud.dev/errors/SC6011" },
  "source-alternative-library": { errorCode: "SC6012", docsUrl: "https://supacloud.dev/errors/SC6012" },
} as const;

const DEFAULT_ALTERNATIVE_LIBRARIES = [
  "@apollo/client", "@urql/core", "graphql-request", "kefir", "most",
  "@pgflow", "pgflow", "pg_durable",
  "react-relay", "redux-observable", "urql", "wonka", "xstream",
] as const;

/** Inspect values at use sites, including types resolved through imported declarations. */
export async function scanSourceSemantics(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  file: string,
  rootDir: string,
  options: { allowAlternativeLibraries?: readonly string[] } = {},
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const report = (code: keyof typeof SOURCE_SEMANTIC_DIAGNOSTIC_CODES, node: ts.Node, message: string): void => {
    diagnostics.push({
      severity: "error", code, ...SOURCE_SEMANTIC_DIAGNOSTIC_CODES[code], file, message,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };
  const allowedLibraries = new Set(options.allowAlternativeLibraries ?? []);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const alternative = DEFAULT_ALTERNATIVE_LIBRARIES.find((name) =>
      moduleName === name || moduleName.startsWith(`${name}/`));
    if (alternative && !allowedLibraries.has(alternative) && !allowedLibraries.has(moduleName)) {
      report(
        "source-alternative-library",
        statement.moduleSpecifier,
        `Production source imports alternative library "${moduleName}". Use the governed Supabase client/PostgREST transport and RxJS event composition by default, or allow this package explicitly in typeSafety.allowAlternativeLibraries for a documented boundary.`,
      );
    }
  }
  const unsafe = async (value: ts.Expression, target: ts.Type): Promise<void> => {
    if ((await isUnknownBoundary(target, checker)) || (await containsAny(target, checker, new Set<ts.Type>(), rootDir))) return;
    if ((await containsAny((await checker.getTypeAtLocation(value)), checker, new Set<ts.Type>(), rootDir))) {
      report("source-unsafe-any", value,
        "An any-containing value cannot enter a concrete type. Quarantine it as unknown and decode it before use.");
    }
  };
  const declared = async (node: ts.TypeNode): Promise<void> => {
    let hasAnyKeyword = false;
    const visitType = (child: ts.Node): void => {
      if (child.kind === ts.SyntaxKind.AnyKeyword) hasAnyKeyword = true;
      ts.forEachChild(child, visitType);
    };
    visitType(node);
    if (!hasAnyKeyword && (await containsAny((await checker.getTypeAtLocation(node)), checker, new Set<ts.Type>(), rootDir))) {
      report("source-unsafe-any", node, "Declared application types must not hide any through aliases or generic arguments.");
    }
  };
  const visit = async (node: ts.Node): Promise<void> => {
    if (ts.isTypeAliasDeclaration(node)) (await declared(node.type));
    if ((ts.isVariableDeclaration(node) || ts.isParameterDeclaration(node) || ts.isPropertyDeclaration(node)
      || ts.isPropertySignatureDeclaration(node)) && node.type) (await declared(node.type));
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const type = (await checker.getTypeAtLocation(node.name));
      if (node.type) (await unsafe(node.initializer, type));
      else if (ts.isIdentifier(node.name) && !ts.isArrowFunction(node.initializer)
        && !ts.isFunctionExpression(node.initializer) && !(type.flags & ts.TypeFlags.Any)
        && (await containsAny(type, checker, new Set<ts.Type>(), rootDir))) {
        report("source-unsafe-any", node.name, "Inferred values must not contain any, including nested and generic result types.");
      }
    }
    if (ts.isPropertyDeclaration(node) && !node.type && node.initializer
      && (await containsAny((await checker.getTypeAtLocation(node.name)), checker, new Set<ts.Type>(), rootDir))) {
      report("source-unsafe-any", node.name, "Inferred class fields must not propagate any. Decode the value or quarantine it as unknown.");
    }
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !node.type && node.body) {
      const signature = (await checker.getSignatureFromDeclaration(node));
      if (signature && (await containsAny((await checker.getReturnTypeOfSignature(signature)), checker, new Set<ts.Type>(), rootDir))) {
        report("source-unsafe-any", ("name" in node ? node.name : undefined) ?? node,
          "Inferred function results must not propagate any. Return unknown at the boundary or a decoded concrete result.");
      }
    }
    if (ts.isFunctionLikeDeclaration(node) && node.type) (await declared(node.type));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      (await unsafe(node.right, (await checker.getTypeAtLocation(node.left))));
    }
    if (ts.isAsExpression(node) || ts.isTypeAssertion(node)) {
      (await unsafe(node.expression, (await checker.getTypeAtLocation(node))));
    }
    if (ts.isReturnStatement(node) && node.expression) {
      let owner: ts.Node | undefined = node.parent;
      while (owner && !ts.isFunctionLikeDeclaration(owner)) owner = owner.parent;
      if (owner && ts.isFunctionLikeDeclaration(owner) && owner.type) {
        const signature = (await checker.getSignatureFromDeclaration(owner));
        if (signature) (await unsafe(node.expression, (await checker.getReturnTypeOfSignature(signature))));
      }
    }
    if (ts.isCallExpression(node)) {
      const signature = (await checker.getResolvedSignature(node));
      const parameters = (await signature?.getParameters()) ?? [];
      (await ts.asyncForEach(node.arguments, async (argument, index) => {
        const parameter = parameters[index] ?? parameters.at(-1);
        if (!parameter) return;
        const type = (await checker.getTypeOfSymbolAtLocation(parameter, node));
        const declaration = (await ts.valueDeclarationOf(parameter));
        const rest = declaration && ts.isParameterDeclaration(declaration) && declaration.dotDotDotToken;
        const target = rest ? (await checker.getIndexTypeOfType(type, ts.IndexKind.Number)) ?? type : type;
        (await unsafe(argument, target));
      }));
    }
    if (ts.isExpressionStatement(node)) {
      const expression = unwrap(node.expression);
      if ((await isPromise((await checker.getTypeAtLocation(expression)), checker, expression)) && !(await handlesRejection(expression, checker))) {
        report("source-floating-promise", node,
          "Promise work must be awaited, returned, or have a callable rejection handler. void does not establish cancellation ownership.");
      }
    }
    if (ts.isSwitchStatement(node)) {
      const type = (await checker.getTypeAtLocation(node.expression));
      const members = type.isUnionType() ? (await type.getTypes()) : [type];
      if (members.every(isFiniteLiteral)) {
        const cases = node.caseBlock.clauses.filter(ts.isCaseClause);
        const missing = (await ts.asyncFilter(members, async (member) => !(await ts.asyncSome(cases, async (clause) =>
          sameLiteral(member, (await checker.getTypeAtLocation(clause.expression)))))));
        if (missing.length > 0) {
          report("source-non-exhaustive-switch", node.expression,
            `Switch is missing cases for ${(await ts.asyncMap(missing, async (member) => (await checker.typeToString(member)))).join(", ")}. A default branch does not replace explicit union cases.`);
        }
      }
    }
    (await ts.forEachChildAsync(node, visit));
  };
  (await visit(source));
  return diagnostics;
}

async function containsAny(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
  rootDir: string,
): Promise<boolean> {
  if (type.flags & ts.TypeFlags.Any) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  if ((type.isUnionType() || type.isIntersectionType())) return (await ts.asyncSome((await type.getTypes()), async (part) => (await containsAny(part, checker, seen, rootDir))));
  // Imported class instances are opaque handles, not application data transfer objects.
  const declarations = (await ts.declarationsOf((await type.getSymbol())));
  if (declarations.some((declaration) => ts.isClassDeclaration(declaration)
    && (declaration.getSourceFile().isDeclarationFile
      || declaration.getSourceFile().fileName.replaceAll("\\", "/").includes("/node_modules/")))) return false;
  const arguments_ = isTypeReference(type) ? (await checker.getTypeArguments(type)) : (await type.getAliasTypeArguments()) ?? [];
  if ((await ts.asyncSome(arguments_, async (argument) => (await containsAny(argument, checker, seen, rootDir))))) return true;
  if ((await ts.asyncSome((await checker.getSignaturesOfType(type, ts.SignatureKind.Call)), async (signature) => {
    const declaration = await signature.declaration?.resolve();
    return declaration !== undefined && isWithinRoot(declaration.getSourceFile().fileName, rootDir)
      && ((await containsAny((await checker.getReturnTypeOfSignature(signature)), checker, seen, rootDir))
        || (await ts.asyncSome((await signature.getParameters()), async (parameter) =>
          (await containsAny((await checker.getTypeOfSymbolAtLocation(parameter, declaration)), checker, seen, rootDir)))));
  }))) return true;
  // Library handles may have intentionally loose methods; inspect application DTOs, not entire SDK internals.
  return (await ts.asyncSome((await checker.getPropertiesOfType(type)), async (property) => {
    const declaration = (await ts.valueDeclarationOf(property));
    return declaration !== undefined
      && isWithinRoot(declaration.getSourceFile().fileName, rootDir)
      && (await containsAny((await checker.getTypeOfSymbolAtLocation(property, declaration)), checker, seen, rootDir));
  }));
}

function isWithinRoot(file: string, rootDir: string): boolean {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedRoot = rootDir.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

async function isUnknownBoundary(type: ts.Type, checker: ts.TypeChecker): Promise<boolean> {
  if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Void)) return true;
  const promised = (await promiseArgument(type, checker));
  return promised !== undefined && Boolean(promised.flags & ts.TypeFlags.Unknown);
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isVoidExpression(expression)) expression = expression.expression;
  return expression;
}

async function isPromise(type: ts.Type, checker: ts.TypeChecker, node: ts.Node): Promise<boolean> {
  return type.isUnionType()
    ? (await ts.asyncSome((await type.getTypes()), async (part) => (await isPromise(part, checker, node))))
    : (await promiseArgument(type, checker)) !== undefined;
}

async function handlesRejection(expression: ts.Expression, checker: ts.TypeChecker): Promise<boolean> {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return false;
  const { name, expression: receiver } = expression.expression;
  if (!(await isPromise((await checker.getTypeAtLocation(receiver)), checker, receiver))) return false;
  const handler = name.text === "catch" ? expression.arguments[0]
    : name.text === "then" ? expression.arguments[1] : undefined;
  return handler !== undefined && (await (await checker.getTypeAtLocation(handler)).getCallSignatures()).length > 0;
}

function isFiniteLiteral(type: ts.Type): boolean {
  return Boolean(type.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral
    | ts.TypeFlags.BigIntLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Null | ts.TypeFlags.Undefined));
}

function sameLiteral(left: ts.Type, right: ts.Type): boolean {
  if (left.flags !== right.flags) return false;
  if (left.isStringLiteralType() && right.isStringLiteralType()) return left.value === right.value;
  if (left.isNumberLiteralType() && right.isNumberLiteralType()) return left.value === right.value;
  return left === right;
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return Boolean(type.flags & ts.TypeFlags.Object)
    && "objectFlags" in type && typeof type.objectFlags === "number"
    && Boolean(type.objectFlags & ts.ObjectFlags.Reference);
}

async function promiseArgument(type: ts.Type, checker: ts.TypeChecker): Promise<ts.Type | undefined> {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return undefined;
  const then = (await checker.getPropertyOfType(type, "then"));
  const declaration = then ? await ts.valueDeclarationOf(then) : undefined;
  if (!then || !declaration || (await (await checker.getTypeOfSymbolAtLocation(then, declaration)).getCallSignatures()).length === 0) return undefined;
  const awaited = (await checker.getAwaitedType(type));
  return awaited !== type ? awaited : undefined;
}
