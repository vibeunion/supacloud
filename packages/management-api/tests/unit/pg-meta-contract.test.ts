import { describe, expect, test } from "bun:test";
import { InvalidPgMetaRowsError, pgMetaRowSchemas, readPgMetaDatabase, readPgMetaRows } from "../../src/utils/pg-meta-contract";
import { pgMetaFixtures } from "../helpers/pg-meta-fixtures";

describe("catalog row contracts", () => {
  test("project database binding preserves absence without inventing a database name", () => {
    expect(readPgMetaDatabase(null, "proj_1")).toBeNull();
    expect(readPgMetaDatabase({ ref: "proj_1", db_name: "custom-db", deleted_at: null }, "proj_1"))
      .toBe("custom-db");
    for (const value of [
      undefined, false, 0, "", [], {},
      { ref: "proj_1", db_name: "fixture" },
      { ref: "other-project", db_name: "fixture", deleted_at: null },
      { ref: "proj_1", db_name: 123, deleted_at: null },
      { ref: "proj_1", db_name: "", deleted_at: null },
      { ref: "proj_1", db_name: "invalid\u0000database", deleted_at: null },
      { ref: "proj_1", db_name: "fixture", deleted_at: new Date(0) },
    ]) {
      expect(() => readPgMetaDatabase(value, "proj_1")).toThrow(InvalidPgMetaRowsError);
    }
  });

  for (const [name, schema] of Object.entries(pgMetaRowSchemas)) {
    const fixture = Object.entries(pgMetaFixtures).find(([key]) => key === name)?.[1];
    if (fixture === undefined) throw new Error(`Missing catalog fixture: ${name}`);

    test(`${name} accepts empty results and valid native-shaped rows`, () => {
      expect(readPgMetaRows(schema, [])).toEqual([]);
      expect(readPgMetaRows(schema, [fixture])).toEqual([fixture]);
    });

    for (const value of [null, undefined, false, 0, "", {}, [null], [false], [0], [[]], new Array(1)]) {
      test(`${name} rejects non-row input ${JSON.stringify(value)}`, () => {
        expect(() => readPgMetaRows(schema, value)).toThrow(InvalidPgMetaRowsError);
      });
    }

    for (const field of Object.keys(schema.properties)) {
      test(`${name}.${field} cannot be missing or undefined`, () => {
        const incomplete = { ...fixture };
        Reflect.deleteProperty(incomplete, field);
        expect(() => readPgMetaRows(schema, [incomplete])).toThrow(InvalidPgMetaRowsError);
        expect(() => readPgMetaRows(schema, [{ ...incomplete, [field]: undefined }])).toThrow(InvalidPgMetaRowsError);
      });
    }

    test(`${name} rejects unselected fields`, () => {
      expect(() => readPgMetaRows(schema, [{ ...fixture, private_value: "synthetic" }]))
        .toThrow(InvalidPgMetaRowsError);
    });
  }

  test("does not coerce booleans, integers, nulls or policy role arrays", () => {
    for (const value of ["true", 1, null]) {
      expect(() => readPgMetaRows(pgMetaRowSchemas.tables, [{ ...pgMetaFixtures.tables, hasindexes: value }]))
        .toThrow(InvalidPgMetaRowsError);
    }
    for (const value of ["1", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => readPgMetaRows(pgMetaRowSchemas.schemas, [{ ...pgMetaFixtures.schemas, table_count: value }]))
        .toThrow(InvalidPgMetaRowsError);
    }
    for (const roles of ["{public}", [1], [null], new Array(1)]) {
      expect(() => readPgMetaRows(pgMetaRowSchemas.policies, [{ ...pgMetaFixtures.policies, roles }]))
        .toThrow(InvalidPgMetaRowsError);
    }
  });

  test("snapshots nested catalog arrays without changing the input", () => {
    const row = { ...pgMetaFixtures.policies, roles: ["public"] };
    const rows = readPgMetaRows(pgMetaRowSchemas.policies, [row]);
    row.roles.push("later-role");
    expect(rows[0]?.roles).toEqual(["public"]);
    expect(row.roles).toEqual(["public", "later-role"]);
  });

  test("schema-derived results retain concrete field types", () => {
    const table = readPgMetaRows(pgMetaRowSchemas.tables, [pgMetaFixtures.tables])[0];
    const policy = readPgMetaRows(pgMetaRowSchemas.policies, [pgMetaFixtures.policies])[0];
    if (!table || !policy) throw new Error("Expected catalog fixtures");
    const indexed: boolean = table.hasindexes;
    const tablespace: string | null = table.tablespace;
    const roles: string[] = policy.roles;
    expect(indexed).toBe(true);
    expect(tablespace).toBeNull();
    expect(roles).toEqual(["public"]);
    // @ts-expect-error Catalog flags cannot be assigned to strings.
    const stringFlag: string = table.hasindexes;
    // @ts-expect-error Nullable tablespaces cannot be treated as always present.
    const requiredTablespace: string = table.tablespace;
    // @ts-expect-error Policy roles are a string array, not a PostgreSQL array literal.
    const stringRoles: string = policy.roles;
    void stringFlag;
    void requiredTablespace;
    void stringRoles;
  });
});
