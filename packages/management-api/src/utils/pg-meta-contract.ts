import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const name = Type.String({ minLength: 1 });
const text = Type.String();
const nullableText = Type.Union([text, Type.Null()]);
const boolean = Type.Boolean();
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableInteger = Type.Union([integer, Type.Null()]);
const names = Type.Array(name);
const options = { additionalProperties: false };

export const pgMetaRowSchemas = {
  tables: Type.Object({
    schemaname: name, tablename: name, tableowner: name, tablespace: nullableText,
    hasindexes: boolean, hasrules: boolean, hastriggers: boolean,
  }, options),
  columns: Type.Object({
    table_schema: name, table_name: name, column_name: name,
    ordinal_position: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    data_type: name, udt_name: name,
    is_nullable: Type.Union([Type.Literal("YES"), Type.Literal("NO")]),
    column_default: nullableText, character_maximum_length: nullableInteger,
    numeric_precision: nullableInteger,
  }, options),
  indexes: Type.Object({
    schemaname: name, tablename: name, indexname: name, indexdef: text,
  }, options),
  roles: Type.Object({
    rolname: name, rolsuper: boolean, rolinherit: boolean, rolcreaterole: boolean,
    rolcreatedb: boolean, rolcanlogin: boolean, rolreplication: boolean,
    rolconnlimit: Type.Integer({ minimum: -1, maximum: 2147483647 }),
  }, options),
  schemas: Type.Object({
    schema_name: name, schema_owner: name, table_count: integer,
  }, options),
  functions: Type.Object({
    schema_name: name, function_name: name, result_type: nullableText,
    arguments: text, language_name: name,
    prokind: Type.Union([
      Type.Literal("f"), Type.Literal("p"), Type.Literal("a"), Type.Literal("w"),
    ]),
  }, options),
  triggers: Type.Object({
    schema_name: name, table_name: name, trigger_name: name, action_timing: name,
    event_manipulation: name, action_statement: text,
  }, options),
  policies: Type.Object({
    schemaname: name, tablename: name, policyname: name,
    permissive: Type.Union([Type.Literal("PERMISSIVE"), Type.Literal("RESTRICTIVE")]),
    roles: names, cmd: name, qual: nullableText, with_check: nullableText,
  }, options),
  publications: Type.Object({
    pubname: name, pubowner: integer, puballtables: boolean,
    pubinsert: boolean, pubupdate: boolean, pubdelete: boolean, pubtruncate: boolean,
  }, options),
  views: Type.Object({
    schemaname: name, viewname: name, viewowner: name, definition: nullableText,
  }, options),
  "materialized-views": Type.Object({
    schemaname: name, matviewname: name, matviewowner: name, definition: nullableText,
  }, options),
  "foreign-tables": Type.Object({
    schemaname: name, tablename: name,
    ftoptions: Type.Union([Type.Array(text), Type.Null()]), ftserver: integer,
  }, options),
  types: Type.Object({
    schema_name: name, type_name: name,
    typtype: Type.Union([Type.Literal("e"), Type.Literal("c")]), enum_value: nullableText,
  }, options),
  extensions: Type.Object({
    extname: name, extversion: name, schema_name: name,
  }, options),
  constraints: Type.Object({
    schema_name: name, table_name: name, constraint_name: name,
    constraint_type: name, definition: text,
  }, options),
};

export class InvalidPgMetaRowsError extends Error {
  constructor() {
    super("Invalid database metadata response");
    this.name = "InvalidPgMetaRowsError";
  }
}

const projectDatabaseSchema = Type.Object({
  ref: name,
  db_name: Type.String({ minLength: 1, pattern: "^[^\\u0000]+$" }),
  deleted_at: Type.Null(),
});

export function readPgMetaDatabase(value: unknown, projectRef: string): string | null {
  if (value === null) return null;
  if (!Value.Check(projectDatabaseSchema, value) || value.ref !== projectRef) {
    throw new InvalidPgMetaRowsError();
  }
  return value.db_name;
}

export function readPgMetaRows<S extends TSchema>(schema: S, value: unknown) {
  if (!Array.isArray(value)) throw new InvalidPgMetaRowsError();
  return Array.from(value, (row: unknown) => {
    if (!Value.Check(schema, row)) throw new InvalidPgMetaRowsError();
    return Value.Clone(row);
  });
}
