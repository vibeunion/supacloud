import { expect, test } from "bun:test";
import { SQL } from "bun";
import { startStarterPostgres } from "../../../../scripts/lib/starter-postgres";
import { starterDatabaseOptions } from "../../src/services/application-starter-compatibility";

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;

test("starter TCP URL parsing emits explicit connection fields and preserves sslmode", () => {
  const url = "postgresql://user%40tenant:pass%3Aword@[::1]:6543/supa%20tenant?sslmode=verify-full&application_name=probe";
  expect(starterDatabaseOptions(url)).toEqual({
    url,
    adapter: "postgres", hostname: "::1", port: 6543,
    username: "user@tenant", password: "pass:word", database: "supa tenant",
  });
  for (const mode of ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]) {
    const input = `postgres://u:p@127.0.0.1/db?sslmode=${mode}`;
    expect(starterDatabaseOptions(input).url).toBe(input);
    expect(starterDatabaseOptions(input)).not.toHaveProperty("tls");
  }
  expect(() => starterDatabaseOptions("postgres://u:p@127.0.0.1/db?host=wrong-tenant"))
    .toThrow("Invalid PostgreSQL connection URL");
});

test.skipIf(!bin)("starter TCP connection ignores ambient management DATABASE_URL and reaches URL database", async () => {
  const postgres = await startStarterPostgres(bin!);
  let target: SQL | undefined;
  let secure: SQL | undefined;
  const prior = process.env.DATABASE_URL;
  try {
    const base = await postgres.withConnection(async url => url);
    const first = new URL(base), second = new URL(base);
    first.pathname = "/starter_target_a";
    second.pathname = "/starter_target_b";
    await postgres.exec("CREATE DATABASE starter_target_a");
    await postgres.exec("CREATE DATABASE starter_target_b");
    process.env.DATABASE_URL = second.href;
    target = new SQL(starterDatabaseOptions(first.href));
    const [identity] = await target`SELECT current_database() AS database, current_user AS role`;
    expect(identity).toEqual({ database: "starter_target_a", role: "starter_test" });
    first.searchParams.set("sslmode", "require");
    secure = new SQL({ ...starterDatabaseOptions(first.href), connectionTimeout: 2 });
    await expect((async () => { await secure!`SELECT 1`; })()).rejects.toThrow();
  } finally {
    if (prior === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior;
    await target?.close({ timeout: 1 });
    await secure?.close({ timeout: 1 });
    await postgres.close();
  }
});
