import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(import.meta.dir, "../..", relativePath), "utf8");
}

describe("platform infrastructure health checks", () => {
  test("PostgreSQL health uses configured database connectivity instead of localhost sudo probes", () => {
    const source = readRepoFile("src/infra/health.ts");
    const start = source.indexOf("private static async checkPostgresHealth");
    const end = source.indexOf("private static async checkPigstyStatus", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const body = source.slice(start, end);
    expect(body).toContain('await import("../db")');
    expect(body).toContain("SHOW server_version");
    expect(body).not.toContain("pg_isready -h localhost");
    expect(body).not.toContain("sudo -u postgres");
    expect(body).not.toContain("systemctl status postgres");
  });

  test("Pigsty absence is reported as a healthy generic PostgreSQL profile instead of a hard failure", () => {
    const source = readRepoFile("src/infra/health.ts");
    const start = source.indexOf("private static async checkPigstyStatus");

    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start);
    expect(body).toContain("command -v pig");
    expect(body).toContain("Database Infrastructure");
    expect(body).toContain("Generic PostgreSQL profile active; Pigsty not configured");
    expect(body).toContain("status: \"OK\"");
  });

  test("diagnostics treat Patroni as optional database infrastructure", () => {
    const source = readRepoFile("src/diagnostics/checks/platform-service.ts");
    const start = source.indexOf('id: "platform-service-status"');
    const end = source.indexOf("// --- Port listener check ---", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const body = source.slice(start, end);
    expect(body).toContain('await isSystemdUnitInstalled("patroni")');
    expect(body).toContain('optionalSkipped.push("Patroni (PostgreSQL HA)")');
    expect(body).not.toContain('{ unit: "patroni", label: "Patroni (PostgreSQL HA)" },');
  });

  test("diagnostics only check PostgreSQL listener when configured DB is local", () => {
    const source = readRepoFile("src/diagnostics/checks/platform-service.ts");
    const start = source.indexOf('id: "platform-port-listeners"');
    const end = source.indexOf("// --- Disk space check ---", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const body = source.slice(start, end);
    expect(body).toContain('const { dbConfig } = await import("../../db");');
    expect(body).toContain("if (isLocalHost(dbConfig.hostname))");
    expect(body).toContain('ports.push({ port: dbConfig.port, label: "PostgreSQL" });');
    expect(body).not.toContain("{ port: 5432, label: \"PostgreSQL\" },");
  });
});
