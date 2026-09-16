import * as ts from "@typescript/typescript6";
import { resolve } from "node:path";

/**
 * Project the standard Codegen result types, rather than independently interpreting
 * selections, fragments and conditional fields. Unsupported wire types fail closed.
 */
export function renderGraphqlValidators(source: string, operationNames: readonly string[]): string {
  const fileName = resolve("/__supacloud_graphql__/contracts.ts");
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    noPropertyAccessFromIndexSignature: true,
    noFallthroughCasesInSwitch: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: [],
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === fileName ? ts.createSourceFile(path, source, languageVersion, true)
      : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    throw new Error(`Generated GraphQL types cannot be validated: ${diagnostics.map(
      (item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"),
    ).join("; ")}`);
  }
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(fileName);
  const module = entry && checker.getSymbolAtLocation(entry);
  if (!module) throw new Error("Generated GraphQL types have no module");
  const exports = new Map(checker.getExportsOfModule(module).map((symbol) => [symbol.name, symbol]));
  if (exports.has("GraphqlQueryResults")) {
    throw new Error("GraphQL type GraphqlQueryResults conflicts with the generated result registry.");
  }
  const names = new Map<ts.Type, string>();
  const definitions = new Map<string, string>();
  function unsupported(type: ts.Type): never {
    throw new Error(`Unsupported GraphQL result wire type: ${checker.typeToString(type)}. Map custom scalars to JSON wire types or unknown.`);
  }
  function reference(type: ts.Type): string {
    const existing = names.get(type);
    if (existing) return existing;
    const name = `checkGraphqlValue${names.size}`;
    names.set(type, name);
    definitions.set(name, "");
    definitions.set(name, `function ${name}(value: unknown): boolean {\n  return ${expression(type)};\n}`);
    return name;
  }
  function expression(type: ts.Type): string {
    if (type.flags & ts.TypeFlags.Any) return unsupported(type);
    if (type.flags & ts.TypeFlags.Unknown) return "true";
    if (type.flags & ts.TypeFlags.Never) return "false";
    if (type.flags & ts.TypeFlags.Null) return "value === null";
    if (type.flags & ts.TypeFlags.Undefined) return "value === undefined";
    if (type.isStringLiteral() || type.isNumberLiteral()) return `value === ${JSON.stringify(type.value)}`;
    if (type.flags & ts.TypeFlags.BooleanLiteral) return `value === ${checker.typeToString(type)}`;
    if (type.flags & ts.TypeFlags.String) return 'typeof value === "string"';
    if (type.flags & ts.TypeFlags.Number) return 'typeof value === "number" && Number.isFinite(value)';
    if (type.flags & ts.TypeFlags.Boolean) return 'typeof value === "boolean"';
    if (type.isUnion()) return type.types.map((part) => `${reference(part)}(value)`).join(" || ");
    if (type.isIntersection()) return type.types.map((part) => `${reference(part)}(value)`).join(" && ");
    if (checker.isTupleType(type)) return unsupported(type);
    if (checker.isArrayType(type)) {
      const item = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      if (!item) return unsupported(type);
      return `isGraphqlArray(value) && Array.from(value).every(${reference(item)})`;
    }
    if (type.flags & ts.TypeFlags.Object) {
      if (type.getCallSignatures().length || type.getConstructSignatures().length) return unsupported(type);
      const indexes = checker.getIndexInfosOfType(type);
      if (indexes.some((index) => !(index.keyType.flags & ts.TypeFlags.String))) return unsupported(type);
      const properties = checker.getPropertiesOfType(type).map((property) => {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        if (!declaration) return unsupported(type);
        const check = reference(checker.getTypeOfSymbolAtLocation(property, declaration));
        const key = JSON.stringify(property.name);
        const present = `Object.prototype.hasOwnProperty.call(value, ${key})`;
        return property.flags & ts.SymbolFlags.Optional
          ? `(!${present} || ${check}(value[${key}]))`
          : `(${present} && ${check}(value[${key}]))`;
      });
      const indexedValues = indexes.map((index) => `Object.values(value).every(${reference(index.type)})`);
      return ["isGraphqlRecord(value)", ...properties, ...indexedValues].join(" && ");
    }
    return unsupported(type);
  }
  const operations = [...operationNames].sort();
  const parsers = operations.map((name) => {
    const typeName = `${name}Query`;
    const symbol = exports.get(typeName);
    if (!symbol) throw new Error(`Missing generated operation type: ${typeName}`);
    const check = reference(checker.getDeclaredTypeOfSymbol(symbol));
    return `export function is${typeName}(value: unknown): value is ${typeName} {
  return ${check}(value);
}
export function parse${typeName}(value: unknown): ${typeName} {
  if (!is${typeName}(value)) {
    throw new GraphqlRequestError("invalid-response", ${JSON.stringify(`GraphQL result does not match ${name}.`)});
  }
  return value;
}`;
  });
  return `
function isGraphqlRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isGraphqlArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
${[...definitions.values()].join("\n")}
${parsers.join("\n")}
export interface GraphqlQueryResults {
${operations.map((name) => `  ${JSON.stringify(name)}: ${name}Query;`).join("\n")}
}
export function isGraphqlResult<Name extends keyof GraphqlQueryResults>(
  name: Name, value: unknown,
): value is GraphqlQueryResults[Name] {
  switch (name) {
${operations.map((name) => `    case ${JSON.stringify(name)}: return is${name}Query(value);`).join("\n")}
    default: return false;
  }
}
export function parseGraphqlResult<Name extends keyof GraphqlQueryResults>(
  name: Name, value: unknown,
): GraphqlQueryResults[Name] {
  if (!isGraphqlResult(name, value)) {
    throw new GraphqlRequestError("invalid-response", "GraphQL result does not match operation " + name + ".");
  }
  return value;
}
`;
}
