import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { Type, type Static } from "typebox";
import { Errors, Value } from "typebox/value";

/**
 * Compiler-owned binding of REST and GraphQL to one ZenStack schema.
 *
 * The ZModel is the schema owner. PostgREST, Postrust, and the Lite Data API
 * are PostgREST-compatible REST execution surfaces. They do not own the schema.
 * Postrust's Hasura-dialect GraphQL is not the public contract. Public GraphQL
 * stays the pg_graphql rewrite at `/graphql/v1`. This module records that
 * binding and the projection status of row policies. It does not emit REST
 * types, GraphQL SDL, or GRANT statements.
 */

export const DATA_CATALOG_VERSION = 1 as const;

export const PUBLIC_GRAPHQL_CONTRACT = {
  path: "/graphql/v1",
  rewritePath: "/rpc/graphql",
  acceptProfile: "graphql_public",
  contentProfile: "graphql_public",
  dialect: "pg_graphql",
} as const;

export const DATA_PLANE_ROLES: ["anon", "authenticated", "service_role"] = ["anon", "authenticated", "service_role"];

export const CLUSTER_LOGIN_ROLES: ["supabase_auth_admin", "supabase_admin"] = ["supabase_auth_admin", "supabase_admin"];

export const REST_EXECUTION_SURFACES = ["postgrest", "postrust", "lite"] as const;

export type RestExecutionSurface = (typeof REST_EXECUTION_SURFACES)[number];

/** Standing limits of this contract version. They are not a per-file scan. */
export const DATA_CATALOG_GAPS: [
  "rest-types-not-generated-from-catalog",
  "graphql-sdl-not-generated-from-catalog",
  "grants-not-emitted-from-catalog",
  "field-level-deny-not-projected",
  "relation-predicates-not-projected",
  "public-graphql-remains-pg-graphql",
  "postrust-hasura-graphql-is-not-the-contract",
  "generated-typescript-model-not-proven-equal-to-zmodel",
] = [
  "rest-types-not-generated-from-catalog",
  "graphql-sdl-not-generated-from-catalog",
  "grants-not-emitted-from-catalog",
  "field-level-deny-not-projected",
  "relation-predicates-not-projected",
  "public-graphql-remains-pg-graphql",
  "postrust-hasura-graphql-is-not-the-contract",
  "generated-typescript-model-not-proven-equal-to-zmodel",
];

const closed = { additionalProperties: false } as const;
const hashString = Type.String({ pattern: "^[a-f0-9]{64}$" });
const sqlName = Type.String({ minLength: 1, maxLength: 63 });

const fieldSchema = Type.Object({
  name: sqlName,
  column: sqlName,
  typeName: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal("scalar"),
    Type.Literal("enum"),
    Type.Literal("relation"),
    Type.Literal("unsupported"),
  ]),
  optional: Type.Boolean(),
  array: Type.Boolean(),
  id: Type.Boolean(),
  unique: Type.Boolean(),
  ignored: Type.Boolean(),
}, closed);

const modelSchema = Type.Object({
  name: sqlName,
  schema: sqlName,
  table: sqlName,
  ignored: Type.Boolean(),
  identity: Type.Union([Type.Literal("field"), Type.Literal("compound"), Type.Literal("none")]),
  fields: Type.Array(fieldSchema),
}, closed);

const enumValueSchema = Type.Object({
  name: sqlName,
  value: sqlName,
}, closed);

const enumSchema = Type.Object({
  name: sqlName,
  values: Type.Array(enumValueSchema, { minItems: 1 }),
}, closed);

const policyStatus = Type.Union([
  Type.Literal("projected"),
  Type.Literal("no-row-policy"),
  Type.Literal("not-projected"),
]);

export const dataCatalogDocumentSchema = Type.Object({
  version: Type.Literal(DATA_CATALOG_VERSION),
  schemaOwner: Type.Literal("zenstack"),
  database: Type.Literal("postgresql"),
  schemaPath: Type.String({ minLength: 1 }),
  schemaHash: hashString,
  authType: Type.Union([sqlName, Type.Null()]),
  authClaims: Type.Array(sqlName),
  enums: Type.Array(enumSchema),
  models: Type.Array(modelSchema, { minItems: 1 }),
  authorization: Type.Object({
    identity: Type.Literal("gotrue-jwt"),
    roles: Type.Tuple([
      Type.Literal("anon"),
      Type.Literal("authenticated"),
      Type.Literal("service_role"),
    ]),
    clusterLoginRolesUnchanged: Type.Tuple([
      Type.Literal("supabase_auth_admin"),
      Type.Literal("supabase_admin"),
    ]),
    enforcement: Type.Literal("postgresql-grant-and-rls"),
    modelPolicyAdapter: Type.Literal("zenstack"),
    binding: Type.Literal("verified-jwt-role-then-postgres"),
    isolation: Type.Literal("one-database-per-project"),
    emittedGrant: Type.Literal(false),
    emittedRowPolicy: Type.Boolean(),
  }, closed),
  rest: Type.Object({
    schemaOwner: Type.Literal("zenstack"),
    executionIsSchemaOwner: Type.Literal(false),
    contract: Type.Literal("postgrest-compatible"),
    execution: Type.Union([
      Type.Literal("postgrest"),
      Type.Literal("postrust"),
      Type.Literal("lite"),
    ]),
    generatedFromCatalog: Type.Literal(false),
    openApi: Type.Literal("not-emitted"),
  }, closed),
  graphql: Type.Object({
    schemaOwner: Type.Literal("zenstack"),
    publicPath: Type.Literal(PUBLIC_GRAPHQL_CONTRACT.path),
    rewritePath: Type.Literal(PUBLIC_GRAPHQL_CONTRACT.rewritePath),
    acceptProfile: Type.Literal(PUBLIC_GRAPHQL_CONTRACT.acceptProfile),
    contentProfile: Type.Literal(PUBLIC_GRAPHQL_CONTRACT.contentProfile),
    dialect: Type.Literal(PUBLIC_GRAPHQL_CONTRACT.dialect),
    generatedFromCatalog: Type.Literal(false),
    clientDefault: Type.Literal(PUBLIC_GRAPHQL_CONTRACT.path),
    postrustHasuraDialect: Type.Literal("not-public-contract"),
  }, closed),
  policyRls: Type.Object({
    status: policyStatus,
    role: Type.Literal("authenticated"),
    statementCount: Type.Integer({ minimum: 0 }),
    hash: Type.Union([hashString, Type.Null()]),
    reason: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  }, closed),
  gaps: Type.Tuple([
    Type.Literal("rest-types-not-generated-from-catalog"),
    Type.Literal("graphql-sdl-not-generated-from-catalog"),
    Type.Literal("grants-not-emitted-from-catalog"),
    Type.Literal("field-level-deny-not-projected"),
    Type.Literal("relation-predicates-not-projected"),
    Type.Literal("public-graphql-remains-pg-graphql"),
    Type.Literal("postrust-hasura-graphql-is-not-the-contract"),
    Type.Literal("generated-typescript-model-not-proven-equal-to-zmodel"),
  ]),
}, closed);

export type DataCatalogDocument = Static<typeof dataCatalogDocumentSchema>;

export interface DataCatalogConfig {
  /** Absolute path of the ZenStack ZModel that owns the catalog. */
  schema: string;
  /** PostgREST-compatible REST process. Not a GraphQL schema owner. */
  restExecution: RestExecutionSurface;
}

export interface CompileDataCatalogInput {
  source: string;
  /** Repository-relative POSIX path ending in `.zmodel`. */
  schemaPath: string;
  restExecution: RestExecutionSurface;
}

export class DataCatalogError extends Error {
  readonly code = "data-catalog" as const;

  constructor(message: string) {
    super(message);
    this.name = "DataCatalogError";
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SCALARS = new Set(["String", "Boolean", "Int", "BigInt", "Float", "Decimal", "DateTime", "Json", "Bytes"]);
const BLOCK_KINDS = new Set(["model", "enum", "type", "datasource", "plugin", "generator"]);

const FORBIDDEN_CATALOG_KEYS: Readonly<Record<string, string>> = {
  graphql: "Public GraphQL stays /graphql/v1 (pg_graphql). The catalog does not accept a GraphQL owner or dialect.",
  graphqlDialect: "Postrust Hasura GraphQL is not the public contract or the schema owner. Public GraphQL stays /graphql/v1 (pg_graphql).",
  graphqlOwner: "The schema owner is ZenStack. Postrust does not own GraphQL.",
  publicPath: "The public GraphQL path stays /graphql/v1.",
  publicEntry: "The public GraphQL path stays /graphql/v1.",
  roles: "Data-plane roles stay anon, authenticated, and service_role.",
  schemaOwner: "The schema owner is the ZenStack schema.",
  hasura: "Hasura is not a catalog owner. Public GraphQL stays /graphql/v1 (pg_graphql).",
  dialect: "The catalog does not select a GraphQL dialect. Public GraphQL stays pg_graphql at /graphql/v1.",
};

function fail(message: string): never {
  throw new DataCatalogError(message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSqlName(value: string, label: string): string {
  if (!IDENT.test(value)) fail(`${label} requires a SQL identifier of at most 63 characters`);
  return value;
}

function unquote(literal: string, label: string): string {
  const matched = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')$/.exec(literal);
  if (!matched) fail(`${label} requires one identifier string`);
  return (matched[1] ?? matched[2] ?? "").replaceAll("\\\\", "\\").replaceAll("\\'", "'").replaceAll('\\"', '"');
}

function stringArg(args: string, label: string): string {
  return assertSqlName(unquote(args.trim(), label), label);
}

function stripComments(source: string): string {
  let out = "";
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      out += char;
      if (char === "\\") {
        const next = source[index + 1];
        if (next === undefined) fail("Unterminated string in ZModel");
        out += next;
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      if (source[index] !== "*") fail("Unterminated comment in ZModel");
      index += 1;
      out += " ";
      continue;
    }
    out += char;
  }
  if (quote) fail("Unterminated string in ZModel");
  return out;
}

interface Block {
  kind: string;
  name: string;
  body: string;
}

function blocks(source: string): Block[] {
  const found: Block[] = [];
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (!/[A-Za-z_]/.test(char)) continue;
    const previous = source[index - 1];
    if (previous && /[A-Za-z0-9_]/.test(previous)) continue;
    let end = index;
    while (end < source.length && /[A-Za-z0-9_]/.test(source[end]!)) end += 1;
    const kind = source.slice(index, end);
    if (!BLOCK_KINDS.has(kind)) {
      if (kind === "view") fail("view blocks are outside this catalog slice");
      if (kind === "import") fail("catalog schema imports are not expanded; pass one self-contained ZModel");
      index = end - 1;
      continue;
    }
    while (end < source.length && /\s/.test(source[end]!)) end += 1;
    const nameStart = end;
    while (end < source.length && /[A-Za-z0-9_]/.test(source[end]!)) end += 1;
    if (nameStart === end) fail(`Expected a name after ${kind}`);
    const name = source.slice(nameStart, end);
    while (end < source.length && /\s/.test(source[end]!)) end += 1;
    if (source[end] !== "{") fail(`Expected a block after ${kind} ${name}`);
    let depth = 0;
    let bodyQuote: "'" | "\"" | undefined;
    const bodyStart = end + 1;
    for (let cursor = end; cursor < source.length; cursor += 1) {
      const current = source[cursor]!;
      if (bodyQuote) {
        if (current === "\\") cursor += 1;
        else if (current === bodyQuote) bodyQuote = undefined;
        continue;
      }
      if (current === "'" || current === "\"") {
        bodyQuote = current;
        continue;
      }
      if (current === "{") depth += 1;
      if (current === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push({ kind, name, body: source.slice(bodyStart, cursor) });
          index = cursor;
          break;
        }
      }
    }
    if (depth !== 0) fail(`Unterminated ${kind} ${name}`);
  }
  return found;
}

function splitStatements(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let quote: "'" | "\"" | undefined;
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quote) {
      current += char;
      if (char === "\\") {
        const next = body[index + 1];
        if (next === undefined) fail("Unterminated string in ZModel");
        current += next;
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") paren += 1;
    else if (char === ")") paren -= 1;
    else if (char === "[") bracket += 1;
    else if (char === "]") bracket -= 1;
    else if (char === "{") brace += 1;
    else if (char === "}") brace -= 1;
    if (paren < 0 || bracket < 0 || brace < 0) fail("Unbalanced model syntax");
    if (char === "@" && body[index + 1] === "@" && paren === 0 && bracket === 0 && brace === 0 && current.trim()) {
      push();
      current = "@@";
      index += 1;
      continue;
    }
    if (char === "\n" && paren === 0 && bracket === 0 && brace === 0) {
      push();
      continue;
    }
    current += char;
  }
  if (quote || paren !== 0 || bracket !== 0 || brace !== 0) fail("Unbalanced model syntax");
  push();
  return parts;
}

function modelAttribute(statement: string): { name: string; args: string } | undefined {
  const matched = /^@@([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(statement);
  if (!matched) return;
  return { name: matched[1]!, args: (matched[2] ?? "").trim() };
}

function withoutStrings(input: string): string {
  return input.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
}

function hasAttribute(statement: string, name: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_@])@${name}\\b`).test(withoutStrings(statement));
}

function mappedColumn(statement: string, label: string): string | undefined {
  const found = [...statement.matchAll(/@map\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)/g)];
  if (found.length > 1) fail(`${label} has more than one @map`);
  const literal = found[0]?.[1];
  if (!literal) return;
  return stringArg(literal, `${label} @map`);
}

interface ParsedField {
  name: string;
  column: string;
  typeName: string;
  optional: boolean;
  array: boolean;
  id: boolean;
  unique: boolean;
  ignored: boolean;
}

function parseField(statement: string, label: string): ParsedField {
  let index = 0;
  const readIdent = (what: string): string => {
    const start = index;
    if (!/[A-Za-z_]/.test(statement[index] ?? "")) fail(`${label} expected ${what}`);
    index += 1;
    while (index < statement.length && /[A-Za-z0-9_]/.test(statement[index]!)) index += 1;
    return statement.slice(start, index);
  };
  const name = assertSqlName(readIdent("a field name"), `${label} field`);
  while (index < statement.length && /\s/.test(statement[index]!)) index += 1;
  let typeName = readIdent("a field type");
  let optional = false;
  let array = false;
  if (statement[index] === "?") {
    optional = true;
    index += 1;
  }
  if (statement[index] === "[") {
    if (statement[index + 1] !== "]") fail(`${label}.${name} has an unsupported list type`);
    array = true;
    index += 2;
  }
  if (statement[index] === "?") {
    optional = true;
    index += 1;
  }
  if (typeName === "Unsupported" && statement[index] === "(") {
    let depth = 0;
    let quote: "'" | "\"" | undefined;
    for (; index < statement.length; index += 1) {
      const char = statement[index]!;
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === "'" || char === "\"") {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    if (depth !== 0) fail(`${label}.${name} has an unterminated Unsupported type`);
  }
  const rest = statement.slice(index);
  if (rest.trim() && !/^\s@/.test(rest)) fail(`${label}.${name} has unsupported field syntax`);
  const column = mappedColumn(statement, `${label}.${name}`) ?? name;
  return {
    name,
    column,
    typeName,
    optional,
    array,
    id: hasAttribute(statement, "id"),
    unique: hasAttribute(statement, "unique"),
    ignored: hasAttribute(statement, "ignore"),
  };
}

function readFields(body: string, label: string): ParsedField[] {
  const fields: ParsedField[] = [];
  const names = new Set<string>();
  for (const statement of splitStatements(body)) {
    if (statement.startsWith("@@") || statement.startsWith("@")) continue;
    const field = parseField(statement, label);
    if (names.has(field.name)) fail(`${label} declares ${field.name} more than once`);
    names.add(field.name);
    fields.push(field);
  }
  return fields;
}

function providerOf(body: string): void {
  const matched = /provider\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(body);
  if (!matched?.[1]) fail("datasource provider must be postgresql");
  const provider = unquote(matched[1], "datasource provider");
  if (provider !== "postgresql") fail(`datasource provider '${provider}' is not postgresql`);
}

interface CatalogShape {
  authType: string | null;
  authClaims: string[];
  enums: Array<{ name: string; values: Array<{ name: string; value: string }> }>;
  models: Array<{
    name: string;
    schema: string;
    table: string;
    ignored: boolean;
    identity: "field" | "compound" | "none";
    fields: Array<ParsedField & { kind: "scalar" | "enum" | "relation" | "unsupported" }>;
  }>;
}

function readCatalog(source: string): CatalogShape {
  if (source.includes("\0")) fail("ZModel contains a NUL character");
  const stripped = stripComments(source.replaceAll("\r\n", "\n"));
  if (/^\s*import\b/m.test(stripped)) fail("catalog schema imports are not expanded; pass one self-contained ZModel");
  const parsed = blocks(stripped);
  for (const block of parsed) {
    if (block.kind === "datasource") providerOf(block.body);
  }
  const enums = parsed.filter((block) => block.kind === "enum").map((block) => {
    const name = assertSqlName(block.name, "enum");
    const values: Array<{ name: string; value: string }> = [];
    const seen = new Set<string>();
    for (const statement of splitStatements(block.body)) {
      if (statement.startsWith("@@") || statement.startsWith("@")) continue;
      const matched = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(statement);
      if (!matched?.[1]) fail(`enum ${name} has an unsupported value`);
      const valueName = assertSqlName(matched[1], `enum ${name}`);
      if (seen.has(valueName)) fail(`enum ${name} declares ${valueName} more than once`);
      seen.add(valueName);
      values.push({ name: valueName, value: mappedColumn(statement, `enum ${name}.${valueName}`) ?? valueName });
    }
    if (!values.length) fail(`enum ${name} has no values`);
    return { name, values };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const enumNames = new Set<string>();
  for (const item of enums) {
    if (enumNames.has(item.name)) fail(`enum ${item.name} is declared more than once`);
    enumNames.add(item.name);
  }
  const modelNames = new Set(parsed.filter((block) => block.kind === "model").map((block) => block.name));
  let authType: string | null = null;
  let authClaims: string[] = [];
  for (const block of parsed.filter((item) => item.kind === "type")) {
    const attributes = splitStatements(block.body).flatMap((statement) => {
      const attribute = modelAttribute(statement);
      return attribute ? [attribute] : [];
    });
    if (!attributes.some((attribute) => attribute.name === "auth")) continue;
    if (authType) fail("ZModel declares more than one @@auth() type");
    authType = assertSqlName(block.name, "auth type");
    const fields = readFields(block.body, block.name);
    for (const field of fields) {
      if (!SCALARS.has(field.typeName) && !enumNames.has(field.typeName)) {
        fail(`${block.name}.${field.name} cannot be an auth claim`);
      }
    }
    authClaims = fields.map((field) => field.name);
  }
  const typeNames = new Set(parsed.filter((block) => block.kind === "type").map((block) => block.name));
  const models = parsed.filter((block) => block.kind === "model").map((block) => {
    const name = assertSqlName(block.name, "model");
    let schema = "public";
    let table = name;
    let ignored = false;
    let compoundId = false;
    let sawMap = false;
    let sawSchema = false;
    for (const statement of splitStatements(block.body)) {
      const attribute = modelAttribute(statement);
      if (!attribute) continue;
      if (attribute.name === "map") {
        if (sawMap) fail(`${name} declares @@map more than once`);
        sawMap = true;
        table = stringArg(attribute.args, `${name} @@map`);
      } else if (attribute.name === "schema") {
        if (sawSchema) fail(`${name} declares @@schema more than once`);
        sawSchema = true;
        schema = stringArg(attribute.args, `${name} @@schema`);
      } else if (attribute.name === "ignore") {
        if (attribute.args) fail(`${name} @@ignore does not take arguments`);
        ignored = true;
      } else if (attribute.name === "id") {
        compoundId = true;
      }
    }
    const rawFields = readFields(block.body, name);
    if (!rawFields.length) fail(`${name} has no fields`);
    const fieldIds = rawFields.filter((field) => field.id).length;
    if (fieldIds > 1) fail(`${name} declares more than one @id`);
    if (fieldIds > 0 && compoundId) fail(`${name} declares both @id and @@id`);
    const fields = rawFields.map((field) => {
      let kind: "scalar" | "enum" | "relation" | "unsupported";
      if (field.typeName === "Unsupported") kind = "unsupported";
      else if (SCALARS.has(field.typeName)) kind = "scalar";
      else if (enumNames.has(field.typeName)) kind = "enum";
      else if (field.typeName === authType) fail(`${name}.${field.name} cannot use the auth type`);
      else if (modelNames.has(field.typeName)) kind = "relation";
      else if (typeNames.has(field.typeName)) kind = "unsupported";
      else fail(`${name}.${field.name} uses unknown type ${field.typeName}`);
      return { ...field, kind };
    });
    return {
      name,
      schema,
      table,
      ignored,
      identity: compoundId ? "compound" as const : fieldIds === 1 ? "field" as const : "none" as const,
      fields,
    };
  });
  if (!models.length) fail("ZenStack catalog requires at least one model");
  if (!models.some((model) => !model.ignored)) fail("ZenStack catalog requires at least one model that is not @@ignore");
  const seenModels = new Set<string>();
  const seenTables = new Set<string>();
  for (const model of models) {
    if (seenModels.has(model.name)) fail(`model ${model.name} is declared more than once`);
    seenModels.add(model.name);
    if (enumNames.has(model.name)) fail(`${model.name} is both a model and an enum`);
    if (typeNames.has(model.name)) fail(`${model.name} is both a model and a type`);
    const key = `${model.schema}.${model.table}`;
    if (seenTables.has(key)) fail(`${key} is mapped by more than one model`);
    seenTables.add(key);
  }
  models.sort((left, right) => left.schema.localeCompare(right.schema) || left.table.localeCompare(right.table) || left.name.localeCompare(right.name));
  return { authType, authClaims, enums, models };
}

function assertSchemaPath(schemaPath: string): void {
  if (!schemaPath || schemaPath !== schemaPath.trim() || /[\r\n\0]/.test(schemaPath)) fail("catalog schemaPath must be a relative .zmodel path");
  if (schemaPath.includes("\\") || isAbsolute(schemaPath) || win32.isAbsolute(schemaPath)) fail("catalog schemaPath must be a relative .zmodel path");
  if (schemaPath.split("/").includes("..") || !schemaPath.endsWith(".zmodel")) fail("catalog schemaPath must be a relative .zmodel path");
}

function assertRestExecution(value: string): asserts value is RestExecutionSurface {
  if (!(REST_EXECUTION_SURFACES as readonly string[]).includes(value)) {
    fail("catalog.restExecution must be postgrest, postrust, or lite. Postrust executes PostgREST-compatible REST and does not own GraphQL.");
  }
}

interface PolicyProjection {
  status: "projected" | "no-row-policy" | "not-projected";
  role: "authenticated";
  statementCount: number;
  hash: string | null;
  reason: string | null;
}

function isPolicyRlsError(error: unknown): error is { message: string } {
  return error instanceof Error && "code" in error && error.code === "policy-rls-unsupported";
}

async function projectPolicy(source: string): Promise<PolicyProjection> {
  const { emitPolicyRls } = await import("@supacloud/db/source-contracts");
  try {
    const emitted = emitPolicyRls(source);
    if (emitted.role !== "authenticated") fail("row-policy projection must stay on the authenticated role");
    const status = emitted.statements.length === 0 ? "no-row-policy" : "projected";
    return {
      status,
      role: "authenticated",
      statementCount: emitted.statements.length,
      hash: sha256(emitted.sql),
      reason: null,
    };
  } catch (error) {
    if (!isPolicyRlsError(error)) throw error;
    const reason = error.message.replaceAll(/\s+/g, " ").trim().slice(0, 200);
    return {
      status: "not-projected",
      role: "authenticated",
      statementCount: 0,
      hash: null,
      reason: reason || "row policy cannot be projected",
    };
  }
}

function assertDocument(value: unknown): DataCatalogDocument {
  if (!Value.Check(dataCatalogDocumentSchema, value)) {
    const detail = Errors(dataCatalogDocumentSchema, value)[0];
    const where = detail ? `${detail.instancePath || "/"} ${detail.message}` : "schema mismatch";
    fail(`compiled catalog does not match the data catalog contract: ${where}`);
  }
  return value;
}

/** Bind one ZModel to the shared REST and GraphQL catalog. Does not write files or routes. */
export async function compileDataCatalog(input: CompileDataCatalogInput): Promise<DataCatalogDocument> {
  assertSchemaPath(input.schemaPath);
  assertRestExecution(input.restExecution);
  if (!input.source.trim()) fail("ZenStack catalog schema is empty");
  const shape = readCatalog(input.source);
  const policyRls = await projectPolicy(input.source);
  return assertDocument({
    version: DATA_CATALOG_VERSION,
    schemaOwner: "zenstack",
    database: "postgresql",
    schemaPath: input.schemaPath,
    schemaHash: sha256(input.source),
    authType: shape.authType,
    authClaims: shape.authClaims,
    enums: shape.enums,
    models: shape.models,
    authorization: {
      identity: "gotrue-jwt",
      roles: DATA_PLANE_ROLES,
      clusterLoginRolesUnchanged: CLUSTER_LOGIN_ROLES,
      enforcement: "postgresql-grant-and-rls",
      modelPolicyAdapter: "zenstack",
      binding: "verified-jwt-role-then-postgres",
      isolation: "one-database-per-project",
      emittedGrant: false,
      emittedRowPolicy: policyRls.status === "projected",
    },
    rest: {
      schemaOwner: "zenstack",
      executionIsSchemaOwner: false,
      contract: "postgrest-compatible",
      execution: input.restExecution,
      generatedFromCatalog: false,
      openApi: "not-emitted",
    },
    graphql: {
      schemaOwner: "zenstack",
      publicPath: PUBLIC_GRAPHQL_CONTRACT.path,
      rewritePath: PUBLIC_GRAPHQL_CONTRACT.rewritePath,
      acceptProfile: PUBLIC_GRAPHQL_CONTRACT.acceptProfile,
      contentProfile: PUBLIC_GRAPHQL_CONTRACT.contentProfile,
      dialect: PUBLIC_GRAPHQL_CONTRACT.dialect,
      generatedFromCatalog: false,
      clientDefault: PUBLIC_GRAPHQL_CONTRACT.path,
      postrustHasuraDialect: "not-public-contract",
    },
    policyRls,
    gaps: DATA_CATALOG_GAPS,
  });
}

export function renderDataCatalog(document: DataCatalogDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseDataCatalogDocument(value: unknown): DataCatalogDocument {
  if (!Value.Check(dataCatalogDocumentSchema, value)) fail("Invalid ZenStack data catalog");
  return value;
}

function relativeZModel(value: string): void {
  if (!value.trim() || value !== value.trim() || /[\r\n\0]/.test(value)) fail("catalog.schema must be a relative .zmodel path");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || isAbsolute(value) || win32.isAbsolute(value) || value.includes("\\")) {
    fail("catalog.schema must be a relative .zmodel path");
  }
  if (value.split("/").includes("..") || !value.endsWith(".zmodel")) fail("catalog.schema must be a relative .zmodel path");
}

/** Parse the `catalog` object of a database-contracts configuration. */
export function parseDataCatalogConfig(value: unknown, directory: string): DataCatalogConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("catalog must be an object with schema and restExecution");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "schema" || key === "restExecution") continue;
    const forbidden = FORBIDDEN_CATALOG_KEYS[key];
    if (forbidden) fail(forbidden);
    fail(`Unknown catalog option ${key}`);
  }
  const schema = record["schema"];
  const restExecution = record["restExecution"];
  if (typeof schema !== "string") fail("catalog.schema must be a relative .zmodel path");
  relativeZModel(schema);
  if (typeof restExecution !== "string") {
    fail("catalog.restExecution must be postgrest, postrust, or lite. Postrust executes PostgREST-compatible REST and does not own GraphQL.");
  }
  assertRestExecution(restExecution);
  const absolute = resolve(directory, schema);
  const inside = relative(directory, absolute);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) fail("catalog.schema must stay inside the configuration directory");
  return { schema: absolute, restExecution };
}
