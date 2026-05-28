import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function sourceFile(pathname: string): string {
  return readFileSync(resolve(import.meta.dir, "../..", pathname), "utf8");
}

describe("TenantRuntimeService port synchronization", () => {
  test("uses persisted tenant ports before hash-based allocation", () => {
    const source = sourceFile("src/services/tenant-runtime.service.ts");

    const persistedLookup = source.indexOf("const persistedPort = await this.readPersistedTenantPort(ref, type);");
    const hashAllocation = source.indexOf("const hash = Bun.hash(ref);");

    expect(persistedLookup).toBeGreaterThan(0);
    expect(hashAllocation).toBeGreaterThan(persistedLookup);
    expect(source).toContain("Ignoring persisted ${type} port ${persistedPort}");
  });

  test("persists generated runtime ports after tenant config is written", () => {
    const source = sourceFile("src/services/tenant-runtime.service.ts");

    const gotrueEnvWrite = source.indexOf("await Bun.write(path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`), gotrueEnv);");
    const persistPorts = source.indexOf("await this.persistTenantPortConfig(ref, pgrstPort, gotruePort);");

    expect(gotrueEnvWrite).toBeGreaterThan(0);
    expect(persistPorts).toBeGreaterThan(gotrueEnvWrite);
  });

  test("checks both GoTrue env and PostgREST conf files for port conflicts", () => {
    const source = sourceFile("src/services/tenant-runtime.service.ts");

    expect(source).toContain('file.endsWith("_gotrue.env")');
    expect(source).toContain("GOTRUE_API_PORT=${port}");
    expect(source).toContain('file.endsWith(".conf")');
    expect(source).toContain("server-port\\\\s*=\\\\s*${port}");
  });
});
