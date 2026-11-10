/**
 * Project ZModel row policies into PostgreSQL RLS for the PostgREST role.
 *
 * The command host role is not this projection. ZenStack still filters that
 * connection, which does not set `request.jwt.claims`. Field-level `@deny`,
 * relation predicates, grants and storage policies stay reviewed SQL.
 * Unsupported row predicates fail closed instead of being omitted.
 */

export class PolicyRlsError extends Error {
  readonly code = "policy-rls-unsupported" as const;
  constructor(message: string) {
    super(message);
    this.name = "PolicyRlsError";
  }
}

export interface EmittedPolicyRls {
  readonly role: string;
  readonly sql: string;
  readonly statements: readonly string[];
}

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCALAR = new Set(["String", "Int", "BigInt", "Boolean"]);
const OPERATIONS = ["read", "create", "update", "delete", "all"] as const;
type Operation = typeof OPERATIONS[number];
type ScalarType = "string" | "number" | "boolean";

interface FieldInfo {
  column: string;
  type: ScalarType | "other";
  relation: boolean;
}

interface ModelInfo {
  name: string;
  fields: Map<string, FieldInfo>;
}

type Expr =
  | { type: "bool"; value: boolean }
  | { type: "null" }
  | { type: "string"; value: string }
  | { type: "number"; value: string }
  | { type: "auth" }
  | { type: "auth-field"; name: string }
  | { type: "field"; name: string }
  | { type: "not"; expr: Expr }
  | { type: "binary"; op: "&&" | "||" | "==" | "!="; left: Expr; right: Expr };

type Token =
  | { kind: "id"; value: string }
  | { kind: "str"; value: string }
  | { kind: "num"; value: string }
  | { kind: "op"; value: "&&" | "||" | "==" | "!=" }
  | { kind: "punct"; value: "(" | ")" | "!" | "." | "," };

function fail(message: string): never {
  throw new PolicyRlsError(message);
}

function quoteIdent(value: string): string {
  if (!IDENT.test(value) || value.length > 63) fail(`Unsupported SQL identifier '${value}'`);
  return `"${value.replaceAll('"', '""')}"`;
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

function blocks(source: string): Array<{ kind: string; name: string; body: string }> {
  const found: Array<{ kind: string; name: string; body: string }> = [];
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
    if (!["model", "type", "enum", "datasource", "plugin"].includes(kind)) {
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

function attribute(statement: string): { name: string; args: string } | undefined {
  const matched = /^@@([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(statement);
  if (!matched) return;
  return { name: matched[1]!, args: matched[2] ?? "" };
}

function mappedName(args: string, label: string): string {
  const tokens = tokenize(args, label);
  if (tokens.length !== 1 || tokens[0]?.kind !== "str" || !IDENT.test(tokens[0].value)) {
    fail(`${label} requires one identifier string`);
  }
  return tokens[0].value;
}

function tokenize(input: string, label: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (/\s/.test(char)) continue;
    if (char === "'" || char === "\"") {
      let value = "";
      index += 1;
      while (index < input.length && input[index] !== char) {
        if (input[index] === "\\") {
          const next = input[index + 1];
          if (next === undefined) fail(`${label} has a bad string escape`);
          value += next;
          index += 2;
          continue;
        }
        value += input[index];
        index += 1;
      }
      if (input[index] !== char) fail(`${label} has an unterminated string`);
      tokens.push({ kind: "str", value });
      continue;
    }
    if (/[0-9]/.test(char)) {
      let value = "";
      while (index < input.length && /[0-9]/.test(input[index]!)) {
        value += input[index];
        index += 1;
      }
      if (input[index] === ".") fail(`${label} has an unsupported numeric literal`);
      tokens.push({ kind: "num", value });
      index -= 1;
      continue;
    }
    const pair = input.slice(index, index + 2);
    if (pair === "&&" || pair === "||" || pair === "==" || pair === "!=") {
      tokens.push({ kind: "op", value: pair });
      index += 1;
      continue;
    }
    if (char === "(" || char === ")" || char === "!" || char === "." || char === ",") {
      tokens.push({ kind: "punct", value: char });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = "";
      while (index < input.length && /[A-Za-z0-9_]/.test(input[index]!)) {
        value += input[index];
        index += 1;
      }
      tokens.push({ kind: "id", value });
      index -= 1;
      continue;
    }
    fail(`${label} contains unsupported syntax '${char}'`);
  }
  return tokens;
}

class ExpressionParser {
  private index = 0;
  constructor(private readonly tokens: readonly Token[], private readonly label: string) {}
  parse(): Expr {
    const expr = this.parseOr();
    if (this.index !== this.tokens.length) fail(`${this.label} has unsupported trailing syntax`);
    return expr;
  }
  private peek(): Token | undefined {
    return this.tokens[this.index];
  }
  private take(): Token {
    const token = this.tokens[this.index];
    if (!token) fail(`${this.label} ended early`);
    this.index += 1;
    return token;
  }
  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek()?.kind === "op" && this.peek()?.value === "||") {
      this.take();
      left = { type: "binary", op: "||", left, right: this.parseAnd() };
    }
    return left;
  }
  private parseAnd(): Expr {
    let left = this.parseCmp();
    while (this.peek()?.kind === "op" && this.peek()?.value === "&&") {
      this.take();
      left = { type: "binary", op: "&&", left, right: this.parseCmp() };
    }
    return left;
  }
  private parseCmp(): Expr {
    const left = this.parseUnary();
    const op = this.peek();
    if (op?.kind === "op" && (op.value === "==" || op.value === "!=")) {
      this.take();
      return { type: "binary", op: op.value, left, right: this.parseUnary() };
    }
    return left;
  }
  private parseUnary(): Expr {
    if (this.peek()?.kind === "punct" && this.peek()?.value === "!") {
      this.take();
      return { type: "not", expr: this.parseUnary() };
    }
    return this.parsePost();
  }
  private parsePost(): Expr {
    let expr = this.parseAtom();
    while (this.peek()?.kind === "punct" && this.peek()?.value === ".") {
      this.take();
      const member = this.take();
      if (member.kind !== "id") fail(`${this.label} expected a member name`);
      if (expr.type === "auth") expr = { type: "auth-field", name: member.value };
      else if (expr.type === "field") fail(`${this.label} relation predicate '${expr.name}.${member.value}' cannot be emitted as RLS`);
      else fail(`${this.label} has unsupported member access`);
    }
    return expr;
  }
  private parseAtom(): Expr {
    const token = this.take();
    if (token.kind === "punct" && token.value === "(") {
      const expr = this.parseOr();
      const close = this.take();
      if (close.kind !== "punct" || close.value !== ")") fail(`${this.label} expected ')'`);
      return expr;
    }
    if (token.kind === "str") return { type: "string", value: token.value };
    if (token.kind === "num") return { type: "number", value: token.value };
    if (token.kind === "id" && token.value === "true") return { type: "bool", value: true };
    if (token.kind === "id" && token.value === "false") return { type: "bool", value: false };
    if (token.kind === "id" && token.value === "null") return { type: "null" };
    if (token.kind === "id") {
      if (this.peek()?.kind === "punct" && this.peek()?.value === "(") {
        this.take();
        if (this.peek()?.kind === "punct" && this.peek()?.value === ")") this.take();
        else fail(`${this.label} function '${token.value}' cannot be emitted as RLS`);
        if (token.value !== "auth") fail(`${this.label} function '${token.value}' cannot be emitted as RLS`);
        return { type: "auth" };
      }
      return { type: "field", name: token.value };
    }
    fail(`${this.label} contains unsupported syntax`);
  }
}

function parseExpression(input: string, label: string): Expr {
  return new ExpressionParser(tokenize(input, label), label).parse();
}

function fieldType(typeName: string, enums: ReadonlySet<string>): FieldInfo["type"] {
  if (typeName === "String" || enums.has(typeName)) return "string";
  if (typeName === "Int" || typeName === "BigInt") return "number";
  if (typeName === "Boolean") return "boolean";
  return "other";
}

function readFields(body: string, enums: ReadonlySet<string>, label: string): Map<string, FieldInfo> {
  const fields = new Map<string, FieldInfo>();
  for (const statement of splitStatements(body)) {
    if (statement.startsWith("@@") || statement.startsWith("@")) continue;
    const matched = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?/.exec(statement);
    if (!matched) continue;
    const name = matched[1]!;
    const typeName = matched[2]!;
    const array = matched[3] === "[]";
    const map = /@map\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)/.exec(statement);
    let column = name;
    if (map) {
      const literal = map[1]!;
      column = literal.slice(1, -1).replaceAll("\\\\", "\\").replaceAll("\\'", "'").replaceAll('\\"', '"');
      if (!IDENT.test(column)) fail(`${label} maps '${name}' to an unsupported column`);
    }
    const relation = array || (!SCALAR.has(typeName) && !enums.has(typeName));
    fields.set(name, { column, type: relation ? "other" : fieldType(typeName, enums), relation });
  }
  return fields;
}

function policyArgs(args: string, label: string): { operation: Operation; expr: Expr } {
  const tokens = tokenize(args, label);
  const operation = tokens[0];
  const comma = tokens[1];
  if (!operation || operation.kind !== "str" || !OPERATIONS.includes(operation.value as Operation) || comma?.kind !== "punct" || comma.value !== ",") {
    fail(`${label} requires an operation of read, create, update, delete or all`);
  }
  let depth = 0;
  let start = -1;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index]!;
    if (char === "'" || char === "\"") {
      const quote = char;
      index += 1;
      while (index < args.length && args[index] !== quote) {
        if (args[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (char === "," && depth === 0) {
      start = index + 1;
      break;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
  }
  if (start < 0 || !args.slice(start).trim()) fail(`${label} requires a condition`);
  return { operation: operation.value as Operation, expr: parseExpression(args.slice(start), label) };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function claim(name: string): string {
  if (!IDENT.test(name)) fail(`Unsupported auth field '${name}'`);
  return `(auth.jwt() ->> '${name}')`;
}

function requireField(model: ModelInfo, name: string): FieldInfo {
  const field = model.fields.get(name);
  if (!field) fail(`${model.name} policy references unknown field '${name}'`);
  if (field.relation) fail(`${model.name} relation predicate '${name}' cannot be emitted as RLS`);
  if (field.type === "other") fail(`${model.name} field '${name}' cannot be emitted as RLS`);
  return field;
}

function sqlCondition(expr: Expr, model: ModelInfo, auth: ReadonlyMap<string, ScalarType | "other">): string {
  if (expr.type === "binary" && expr.op === "&&") return `(${sqlCondition(expr.left, model, auth)} AND ${sqlCondition(expr.right, model, auth)})`;
  if (expr.type === "binary" && expr.op === "||") return `(${sqlCondition(expr.left, model, auth)} OR ${sqlCondition(expr.right, model, auth)})`;
  if (expr.type === "binary") return sqlCompare(expr, model, auth);
  if (expr.type === "not") return `(NOT ${sqlCondition(expr.expr, model, auth)})`;
  if (expr.type === "bool") return expr.value ? "TRUE" : "FALSE";
  if (expr.type === "field") {
    const field = requireField(model, expr.name);
    if (field.type !== "boolean") fail(`${model.name} field '${expr.name}' is not a boolean policy condition`);
    return `(${quoteIdent(field.column)} = TRUE)`;
  }
  if (expr.type === "auth-field") {
    if (auth.get(expr.name) !== "boolean") fail(`${model.name} auth().${expr.name} is not a boolean policy condition`);
    return `(${claim(expr.name)} = 'true')`;
  }
  if (expr.type === "auth") fail(`${model.name} auth() must be compared with null`);
  fail(`${model.name} policy condition cannot be emitted as RLS`);
}

interface Operand { sql: string; type: ScalarType }

function operand(expr: Expr, model: ModelInfo, auth: ReadonlyMap<string, ScalarType | "other">): Operand {
  if (expr.type === "string") return { sql: sqlLiteral(expr.value), type: "string" };
  if (expr.type === "number") return { sql: expr.value, type: "number" };
  if (expr.type === "bool") return { sql: expr.value ? "TRUE" : "FALSE", type: "boolean" };
  if (expr.type === "field") {
    const field = requireField(model, expr.name);
    if (field.type === "other") fail(`${model.name} field '${expr.name}' cannot be emitted as RLS`);
    return { sql: quoteIdent(field.column), type: field.type };
  }
  if (expr.type === "auth-field") {
    const type = auth.get(expr.name);
    if (type !== "string") fail(`${model.name} auth().${expr.name} cannot be emitted as RLS`);
    return { sql: claim(expr.name), type: "string" };
  }
  fail(`${model.name} comparison cannot be emitted as RLS`);
}

function booleanClaim(expr: Expr, auth: ReadonlyMap<string, ScalarType | "other">): string | undefined {
  if (expr.type !== "auth-field" || auth.get(expr.name) !== "boolean") return;
  return claim(expr.name);
}

function booleanText(expr: Expr): string | undefined {
  if (expr.type === "bool") return expr.value ? "'true'" : "'false'";
  return;
}

function sqlCompare(expr: Extract<Expr, { type: "binary" }>, model: ModelInfo, auth: ReadonlyMap<string, ScalarType | "other">): string {
  const op = expr.op === "!=" ? "<>" : "=";
  const authNull = (node: Expr, other: Expr) => node.type === "auth" && other.type === "null";
  if (authNull(expr.left, expr.right) || authNull(expr.right, expr.left)) {
    return expr.op === "!=" ? "(auth.jwt() IS NOT NULL)" : "(auth.jwt() IS NULL)";
  }
  const leftClaim = booleanClaim(expr.left, auth);
  const rightClaim = booleanClaim(expr.right, auth);
  const leftText = booleanText(expr.left);
  const rightText = booleanText(expr.right);
  if (leftClaim && rightText) return `(${leftClaim} ${op} ${rightText})`;
  if (rightClaim && leftText) return `(${rightClaim} ${op} ${leftText})`;
  if (expr.left.type === "null" || expr.right.type === "null" || expr.left.type === "auth" || expr.right.type === "auth" || leftClaim || rightClaim) {
    fail(`${model.name} comparison cannot be emitted as RLS`);
  }
  const left = operand(expr.left, model, auth);
  const right = operand(expr.right, model, auth);
  if (left.type !== right.type) fail(`${model.name} compares ${left.type} with ${right.type}`);
  return `(${left.sql} ${op} ${right.sql})`;
}

function predicate(exprs: readonly Expr[], model: ModelInfo, auth: ReadonlyMap<string, ScalarType | "other">, joiner: "OR" | "AND"): string {
  return exprs.map(expr => sqlCondition(expr, model, auth)).join(` ${joiner} `);
}

function clause(operation: Operation, sql: string, deny: boolean): string {
  const condition = deny ? `(NOT (${sql}))` : `(${sql})`;
  if (operation === "create") return `WITH CHECK ${condition}`;
  if (operation === "read" || operation === "delete") return `USING ${condition}`;
  return `USING ${condition} WITH CHECK ${condition}`;
}

function renderPolicyRls(role: string, statements: readonly string[]): string {
  const lines = [
    "-- GENERATED BY supacloud-db policy-rls. Do not edit.",
    `-- ${role} row policies projected from ZModel @@allow/@@deny.`,
    "-- Field-level @deny, relation predicates, grants and the command host role are outside this projection.",
    "-- The migration ledger must contain every statement below.",
  ];
  if (!statements.length) lines.push("-- no row policies");
  return `${lines.join("\n")}\n${statements.length ? `${statements.join("\n")}\n` : ""}`;
}

function commandOf(operation: Operation): string {
  if (operation === "read") return "SELECT";
  if (operation === "create") return "INSERT";
  if (operation === "update") return "UPDATE";
  if (operation === "delete") return "DELETE";
  return "ALL";
}

/** Emit RLS for one ZModel. The role defaults to the PostgREST `authenticated` role. */
export function emitPolicyRls(source: string, options?: { role?: string }): EmittedPolicyRls {
  const role = options?.role ?? "authenticated";
  if (!ROLE.test(role)) fail("RLS role must be a lowercase identifier");
  const parsed = blocks(stripComments(source));
  const enums = new Set(parsed.filter(block => block.kind === "enum").map(block => block.name));
  const authBlock = parsed.find(block => block.kind === "type" && splitStatements(block.body).some(statement => attribute(statement)?.name === "auth"));
  const auth = new Map<string, ScalarType | "other">();
  if (authBlock) {
    for (const [name, field] of readFields(authBlock.body, enums, authBlock.name)) {
      if (field.relation) fail(`${authBlock.name}.${name} cannot be an auth claim`);
      auth.set(name, field.type);
    }
  }
  const statements: string[] = [];
  let needsRole = false;
  for (const block of parsed.filter(item => item.kind === "model")) {
    const fields = readFields(block.body, enums, block.name);
    let schema = "public";
    let table = block.name;
    const allows = new Map<Operation, Expr[]>();
    const denies = new Map<Operation, Expr[]>();
    for (const statement of splitStatements(block.body)) {
      const attr = attribute(statement);
      if (!attr) continue;
      if (attr.name === "map") table = mappedName(attr.args, `${block.name} @@map`);
      else if (attr.name === "schema") schema = mappedName(attr.args, `${block.name} @@schema`);
      else if (attr.name === "allow" || attr.name === "deny") {
        const policy = policyArgs(attr.args, `${block.name} @@${attr.name}`);
        const target = attr.name === "allow" ? allows : denies;
        target.set(policy.operation, [...(target.get(policy.operation) ?? []), policy.expr]);
      }
    }
    if (!allows.size && !denies.size) continue;
    if (!authBlock && [...allows.values(), ...denies.values()].some(items => items.some(usesAuth))) {
      fail(`${block.name} uses auth() without an @@auth() type`);
    }
    needsRole = true;
    const model: ModelInfo = { name: block.name, fields };
    const qualified = `${quoteIdent(schema)}.${quoteIdent(table)}`;
    statements.push(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`);
    for (const operation of OPERATIONS) {
      const allowed = allows.get(operation) ?? [];
      const denied = denies.get(operation) ?? [];
      const command = commandOf(operation);
      if (allowed.length) {
        const name = `${table}_${command.toLowerCase()}`;
        if (name.length > 63) fail(`${model.name} policy name '${name}' exceeds 63 characters`);
        const body = clause(operation, predicate(allowed, model, auth, "OR"), false);
        statements.push(`DROP POLICY IF EXISTS ${quoteIdent(name)} ON ${qualified};`);
        statements.push(`CREATE POLICY ${quoteIdent(name)} ON ${qualified} FOR ${command} TO ${quoteIdent(role)} ${body};`);
      }
      if (denied.length) {
        const name = `${table}_${command.toLowerCase()}_deny`;
        if (name.length > 63) fail(`${model.name} policy name '${name}' exceeds 63 characters`);
        const body = clause(operation, predicate(denied, model, auth, "OR"), true);
        statements.push(`DROP POLICY IF EXISTS ${quoteIdent(name)} ON ${qualified};`);
        statements.push(`CREATE POLICY ${quoteIdent(name)} ON ${qualified} AS RESTRICTIVE FOR ${command} TO ${quoteIdent(role)} ${body};`);
      }
    }
  }
  if (needsRole) {
    statements.unshift(`DO $supacloud_policy_rls$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${sqlLiteral(role)}) THEN CREATE ROLE ${quoteIdent(role)} NOLOGIN; END IF; END $supacloud_policy_rls$;`);
  }
  return { role, statements, sql: renderPolicyRls(role, statements) };
}

function usesAuth(expr: Expr): boolean {
  if (expr.type === "auth" || expr.type === "auth-field") return true;
  if (expr.type === "not") return usesAuth(expr.expr);
  if (expr.type === "binary") return usesAuth(expr.left) || usesAuth(expr.right);
  return false;
}

export function combinePolicyRls(parts: readonly EmittedPolicyRls[]): EmittedPolicyRls {
  const role = parts[0]?.role ?? "authenticated";
  if (parts.some(part => part.role !== role)) fail("Policy RLS projections must use one role");
  const statements: string[] = [];
  const names = new Set<string>();
  for (const part of parts) {
    for (const statement of part.statements) {
      if (statement.startsWith("DO $supacloud_policy_rls$") && statements.some(item => item.startsWith("DO $supacloud_policy_rls$"))) continue;
      const created = /^CREATE POLICY "([^"]+)" /.exec(statement);
      if (created) {
        if (names.has(created[1]!)) fail(`Duplicate emitted policy '${created[1]}'`);
        names.add(created[1]!);
      }
      statements.push(statement);
    }
  }
  return { role, statements, sql: renderPolicyRls(role, statements) };
}

/** Statements from the model projection that the migration ledger does not contain. */
export function policyRlsDivergence(emitted: EmittedPolicyRls, migrations: readonly string[]): string[] {
  const blob = migrations.join("\n").replace(/\s+/g, " ");
  return emitted.statements.filter(statement => !blob.includes(statement.replace(/\s+/g, " ").trim()));
}
