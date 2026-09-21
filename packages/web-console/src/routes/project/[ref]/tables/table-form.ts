import { Type, type Static } from "@sinclair/typebox";
import { tableColumnTypes } from "./table-draft";

const tableColumnTypeSchema = Type.Union([
  Type.Literal(tableColumnTypes[0]),
  Type.Literal(tableColumnTypes[1]),
  Type.Literal(tableColumnTypes[2]),
  Type.Literal(tableColumnTypes[3]),
  Type.Literal(tableColumnTypes[4]),
  Type.Literal(tableColumnTypes[5]),
  Type.Literal(tableColumnTypes[6]),
  Type.Literal(tableColumnTypes[7]),
  Type.Literal(tableColumnTypes[8]),
  Type.Literal(tableColumnTypes[9]),
  Type.Literal(tableColumnTypes[10]),
  Type.Literal(tableColumnTypes[11]),
  Type.Literal(tableColumnTypes[12]),
]);

export const tableFormSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 63, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
  columns: Type.Array(Type.Object({
    name: Type.String({ minLength: 1, maxLength: 63, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
    type: tableColumnTypeSchema,
    nullable: Type.Boolean(),
    primaryKey: Type.Optional(Type.Boolean()),
    identity: Type.Optional(Type.Boolean()),
  }), { minItems: 1, maxItems: 64 }),
});

export type TableFormValues = Static<typeof tableFormSchema>;
