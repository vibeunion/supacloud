import * as ts from "@supacloud/db/typescript";
import { resolve } from "node:path";

/**
 * Project the standard Codegen result types, rather than independently interpreting
 * selections, fragments and conditional fields. Unsupported wire types fail closed.
 */
export type GraphqlOperationKind = "query" | "mutation";

export async function renderGraphqlValidators(
  source: string,
  operationNames: readonly string[],
  operationKinds: ReadonlyMap<string, GraphqlOperationKind> = new Map(),
): Promise<string> {
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
  await using program = await ts.createProgram([fileName], options, { sources: new Map([[fileName, source]]) });
  const diagnostics = (await ts.getPreEmitDiagnostics(program));
  if (diagnostics.length) {
    throw new Error(`Generated GraphQL types cannot be validated: ${diagnostics.map(
      (item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"),
    ).join("; ")}`);
  }
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(fileName);
  const module = entry && (await checker.getSymbolAtLocation(entry));
  if (!module) throw new Error("Generated GraphQL types have no module");
  const exports = new Map((await checker.getExportsOfModule(module)).map((symbol) => [symbol.name, symbol]));
  if (exports.has("GraphqlQueryResults")) {
    throw new Error("GraphQL type GraphqlQueryResults conflicts with the generated result registry.");
  }
  const names = new Map<ts.Type, string>();
  const definitions = new Map<string, string>();
  async function unsupported(type: ts.Type): Promise<never> {
    throw new Error(`Unsupported GraphQL result wire type: ${(await checker.typeToString(type))}. Map custom scalars to JSON wire types or unknown.`);
  }
  async function reference(type: ts.Type): Promise<string> {
    const existing = names.get(type);
    if (existing) return existing;
    const name = `checkGraphqlValue${names.size}`;
    names.set(type, name);
    definitions.set(name, "");
    definitions.set(name, `function ${name}(value: unknown): boolean {\n  return ${(await expression(type))};\n}`);
    return name;
  }
  async function expression(type: ts.Type): Promise<string> {
    if (type.flags & ts.TypeFlags.Any) return (await unsupported(type));
    if (type.flags & ts.TypeFlags.Unknown) return "true";
    if (type.flags & ts.TypeFlags.Never) return "false";
    if (type.flags & ts.TypeFlags.Null) return "value === null";
    if (type.flags & ts.TypeFlags.Undefined) return "value === undefined";
    if (type.isStringLiteralType() || type.isNumberLiteralType()) return `value === ${JSON.stringify(type.value)}`;
    if (type.flags & ts.TypeFlags.BooleanLiteral) return `value === ${(await checker.typeToString(type))}`;
    if (type.flags & ts.TypeFlags.String) return 'typeof value === "string"';
    if (type.flags & ts.TypeFlags.Number) return 'typeof value === "number" && Number.isFinite(value)';
    if (type.flags & ts.TypeFlags.Boolean) return 'typeof value === "boolean"';
    if (type.isUnionType()) return (await ts.asyncMap((await type.getTypes()), async (part) => `${(await reference(part))}(value)`)).join(" || ");
    if (type.isIntersectionType()) return (await ts.asyncMap((await type.getTypes()), async (part) => `${(await reference(part))}(value)`)).join(" && ");
    if ((await checker.isTupleType(type))) return (await unsupported(type));
    if ((await checker.isArrayType(type))) {
      const item = (await checker.getIndexTypeOfType(type, ts.IndexKind.Number));
      if (!item) return (await unsupported(type));
      return `isGraphqlArray(value) && Array.from(value).every(${(await reference(item))})`;
    }
    if (type.flags & ts.TypeFlags.Object) {
      if ((await type.getCallSignatures()).length || (await type.getConstructSignatures()).length) return (await unsupported(type));
      const indexes = (await checker.getIndexInfosOfType(type));
      if (indexes.some((index) => !(index.keyType.flags & ts.TypeFlags.String))) return (await unsupported(type));
      const properties = (await ts.asyncMap((await checker.getPropertiesOfType(type)), async (property) => {
        const declaration = (await ts.valueDeclarationOf(property));
        if (!declaration) return (await unsupported(type));
        const check = (await reference((await checker.getTypeOfSymbolAtLocation(property, declaration))));
        const key = JSON.stringify(property.name);
        const present = `Object.prototype.hasOwnProperty.call(value, ${key})`;
        return property.flags & ts.SymbolFlags.Optional
          ? `(!${present} || ${check}(value[${key}]))`
          : `(${present} && ${check}(value[${key}]))`;
      }));
      const indexedValues = (await ts.asyncMap(indexes, async (index) => `Object.values(value).every(${(await reference(index.valueType))})`));
      return ["isGraphqlRecord(value)", ...properties, ...indexedValues].join(" && ");
    }
    return (await unsupported(type));
  }
  const operations = [...operationNames].sort();
  const suffixFor = (name: string): "Query" | "Mutation" =>
    operationKinds.get(name) === "mutation" ? "Mutation" : "Query";
  const parsers = (await ts.asyncMap(operations, async (name) => {
    const typeName = `${name}${suffixFor(name)}`;
    const symbol = exports.get(typeName);
    if (!symbol) throw new Error(`Missing generated operation type: ${typeName}`);
    const check = (await reference((await checker.getDeclaredTypeOfSymbol(symbol))));
    return `export function is${typeName}(value: unknown): value is ${typeName} {
  return ${check}(value);
}
export function parse${typeName}(value: unknown): ${typeName} {
  if (!is${typeName}(value)) {
    throw new GraphqlRequestError("invalid-response", ${JSON.stringify(`GraphQL result does not match ${name}.`)});
  }
  return value;
}`;
  }));
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
${operations.map((name) => `  ${JSON.stringify(name)}: ${name}${suffixFor(name)};`).join("\n")}
}
export function isGraphqlResult<Name extends keyof GraphqlQueryResults>(
  name: Name, value: unknown,
): value is GraphqlQueryResults[Name] {
  switch (name) {
${operations.map((name) => `    case ${JSON.stringify(name)}: return is${name}${suffixFor(name)}(value);`).join("\n")}
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
