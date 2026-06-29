import { beforeEach, describe, expect, mock, test } from "bun:test";

type SqlCall = { text: string; values: unknown[] };

const sqlCalls: SqlCall[] = [];

const projectDb = Object.assign(
  mock((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join("?"), values });
    return Promise.resolve([]);
  }),
  {
    unsafe: mock((text: string, values: unknown[] = []) => {
      sqlCalls.push({ text, values });
      if (text.includes("information_schema.schemata")) {
        return Promise.resolve([
          { schema_name: "public" },
          { schema_name: "auth" },
          { schema_name: "storage" },
          { schema_name: "supabase_functions" },
          { schema_name: "supabase_migrations" },
        ]);
      }
      if (text.includes("information_schema.tables") && text.includes("table_schema = 'auth'")) {
        return Promise.resolve([
          { table_name: "users" },
          { table_name: "sessions" },
          { table_name: "refresh_tokens" },
          { table_name: "identities" },
        ]);
      }
      return Promise.resolve([]);
    }),
  },
);

mock.module("../../src/db", () => ({
  sql: projectDb,
  resolveDbName: mock(async () => "supa_proj_1"),
  resolveAuthenticatorName: mock((ref: string) => `authenticator_${ref}`),
  resolvePgrstChannel: mock((ref: string) => `pgrst_${ref}`),
  getProjectDb: mock(() => projectDb),
}));

await import("../../src/diagnostics/checks/project-database");
const { getCheck } = await import("../../src/services/diagnostics.registry");

function context() {
  return {
    scope: "project" as const,
    projectRef: "proj_1",
    cache: new Map<string, unknown>(),
    metaDb: projectDb as never,
  };
}

describe("project database diagnostics", () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    projectDb.mockClear();
    projectDb.unsafe.mockClear();
  });

  test("required schema check uses SQL IN literals instead of array binding", async () => {
    const check = getCheck("project-required-schemas");
    expect(check).toBeDefined();

    const result = await check?.run(context());
    const query = sqlCalls.at(-1);

    expect(result?.status).toBe("pass");
    expect(query?.text).toContain("schema_name IN ('public', 'auth', 'storage', 'supabase_functions', 'supabase_migrations')");
    expect(query?.text).not.toContain("ANY(");
    expect(query?.values).toEqual([]);
  });

  test("auth schema check uses SQL IN literals instead of array binding", async () => {
    const check = getCheck("project-auth-schema");
    expect(check).toBeDefined();

    const result = await check?.run(context());
    const query = sqlCalls.at(-1);

    expect(result?.status).toBe("pass");
    expect(query?.text).toContain("table_name IN ('users', 'sessions', 'refresh_tokens', 'identities')");
    expect(query?.text).not.toContain("ANY(");
    expect(query?.values).toEqual([]);
  });
});
