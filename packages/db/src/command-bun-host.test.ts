import { expect, test } from "bun:test";
import { createBunSqlHost } from "./command-bun";

test("Bun SQL host validates and owns the runtime connection settings", async () => {
  const host = createBunSqlHost({
    env: { DATABASE_URL: "postgres://user:secret@127.0.0.1:5432/app" },
    max: 2,
    connectionTimeout: 1,
  });
  expect(host.pool).toBeDefined();
  await host.close();
  await host.close();
});

test("Bun SQL host rejects conflicting or invalid connection settings", () => {
  expect(() => createBunSqlHost({
    env: { DATABASE_URL: "postgres://user:secret@127.0.0.1/app", DATABASE_SOCKET_PATH: "/tmp/app.sock" },
  })).toThrow("Conflicting database connection settings");
  expect(() => createBunSqlHost({ env: { DATABASE_URL: "https://example.test/db" } }))
    .toThrow("Invalid database URL");
});

