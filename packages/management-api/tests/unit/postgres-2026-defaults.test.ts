import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("uses current Supabase PostgreSQL defaults", () => {
  expect(read("config.env")).toContain("PG_VERSION=18");
  expect(read("infra/postgres/pg_tune.sh")).toContain('alter_system "log_connections"          "off"');
  expect(read("packages/management-api/src/services/database.service.ts")).not.toContain('"pgjwt", "pg_net"');
  expect(read("docker/self-host/postgres/initdb/01-bootstrap-extensions.sql")).not.toContain("'pgjwt'");
  expect(read("docker/self-host/postgres/Dockerfile")).not.toContain("postgresql-18-pgjwt");
});
