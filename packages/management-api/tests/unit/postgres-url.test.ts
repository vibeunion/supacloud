import { expect, test } from "bun:test";
import { parsePostgresUrl, withPostgresDatabase } from "../../src/utils/postgres-url";

test("parses encoded credentials, IPv6, query options and the default port", () => {
  expect(parsePostgresUrl("postgresql://u%25%40:p%25%40%3A@[::1]/my%20db?sslmode=require")).toEqual({
    username: "u%@", password: "p%@:", hostname: "::1", port: 5432, database: "my db",
  });
});

test.each([
  "http://user:synthetic@localhost:5432/db", "postgres://user:synthetic@localhost:0/db",
  "postgres://user:synthetic@localhost/db%00", "postgres://user:synthetic@localhost/db?host=elsewhere",
  "postgres://user:synthetic@localhost/db?user=other", "postgres://user:synthetic@localhost/db#fragment",
  "postgres://user:synthetic%ZZ@localhost/db", "postgres://user:synthetic@localhost/",
])("rejects invalid or ambiguous connection strings %#", (url) => {
  expect(() => parsePostgresUrl(url)).toThrow("Invalid PostgreSQL connection URL");
  try {
    parsePostgresUrl(url);
  } catch (error) {
    expect(String(error)).not.toContain("synthetic");
  }
});

test("project pool URLs retain TLS settings without double decoding credentials", () => {
  const url = withPostgresDatabase(
    "postgres://admin:p%25%2540@localhost/meta?sslmode=require",
    "tenant%20db", "user%@", "pass%@:",
  );
  expect(parsePostgresUrl(url)).toEqual({
    hostname: "localhost", port: 5432, database: "tenant%20db", username: "user%@", password: "pass%@:",
  });
  expect(new URL(url).searchParams.get("sslmode")).toBe("require");
  expect(parsePostgresUrl(withPostgresDatabase(url, "another")).password).toBe("pass%@:");
  expect(parsePostgresUrl(withPostgresDatabase(url, "another", "user", "")).password).toBe("");
  expect(() => withPostgresDatabase(url, "invalid\0db")).toThrow();
});
