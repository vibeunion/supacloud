import { describe, expect, test } from "bun:test";
import {
  effectivePostgrestSchemas,
  normalizeCustomPostgrestSchemas,
  postgrestSchemasRevision,
  projectCustomPostgrestSchemas,
} from "../../src/utils/postgrest-schema-config";

describe("PostgREST schema configuration", () => {
  test("normalizes project-owned schemas deterministically", () => {
    expect(normalizeCustomPostgrestSchemas(["RPC", " api ", "rpc"])).toEqual(["api", "rpc"]);
    expect(projectCustomPostgrestSchemas({ postgrest: { exposed_schemas: ["workflow", "api"] } }))
      .toEqual(["api", "workflow"]);
    expect(effectivePostgrestSchemas(["api"], true)).toEqual([
      "public", "storage", "graphql_public", "pgmq_public", "api",
    ]);
  });

  test("rejects reserved, quoted, and platform-owned schemas", () => {
    for (const schema of ["auth", "pg_catalog", "pg_secret", "supabase_demo", "supacloud_demo", "Api-V2"]) {
      expect(() => normalizeCustomPostgrestSchemas([schema])).toThrow();
    }
  });

  test("binds revisions to the normalized schema set", () => {
    const first = normalizeCustomPostgrestSchemas(["rpc", "api"]);
    const second = normalizeCustomPostgrestSchemas(["api", "rpc"]);
    expect(postgrestSchemasRevision(first)).toBe(postgrestSchemasRevision(second));
    expect(postgrestSchemasRevision(first)).not.toBe(postgrestSchemasRevision(["api"]));
  });
});
