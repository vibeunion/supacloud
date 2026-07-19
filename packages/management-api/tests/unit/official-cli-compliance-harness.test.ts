import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  buildCliMigrationHistoryFixtures,
  parseCliHarnessDatabaseUrl,
} from "../scripts/official-cli-compliance-harness";

describe("official CLI compliance harness", () => {
  test("creates a metadata-only project without starting the provisioning saga", () => {
    const source = readFileSync(
      new URL("../scripts/run-official-cli-compliance.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("projectRepository.create");
    expect(source).not.toContain("new ProjectService");
    expect(source).not.toContain("createProject(");
    expect(source).toContain("if (projectId !== null)");
    expect(source).toContain("DELETE FROM projects WHERE id = ${projectId}");
    expect(source).not.toContain("DELETE FROM projects WHERE ref = ${rawRef}");
  });

  test("bridges the Management API project to the direct database target", () => {
    expect(parseCliHarnessDatabaseUrl(
      "postgresql://supabase_admin:p%40ss@127.0.0.1:5432/postgres?sslmode=disable",
    )).toEqual({
      dbName: "postgres",
      dbUser: "supabase_admin",
      dbPassword: "p@ss",
    });
  });

  test("mirrors existing remote migration versions into deterministic local fixtures", () => {
    expect(buildCliMigrationHistoryFixtures([
      { version: "20260709151810" },
      { version: 20220329161857n },
      { version: "20260709151810" },
      { version: "20990101000000" },
      { version: 0 },
    ])).toEqual([
      {
        fileName: "0_remote_history.sql",
        contents: "-- Existing remote migration 0; history fixture only.\n",
      },
      {
        fileName: "20220329161857_remote_history.sql",
        contents: "-- Existing remote migration 20220329161857; history fixture only.\n",
      },
      {
        fileName: "20260709151810_remote_history.sql",
        contents: "-- Existing remote migration 20260709151810; history fixture only.\n",
      },
    ]);
  });

  test("rejects malformed migration versions instead of creating ambiguous files", () => {
    expect(() => buildCliMigrationHistoryFixtures([{ version: "not-a-version" }])).toThrow(
      "Invalid remote migration version",
    );
  });
});
