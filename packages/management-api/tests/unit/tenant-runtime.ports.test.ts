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

    const gotrueConfigDirWrite = source.indexOf('await Bun.write(path.join(gotrueConfigDir, "runtime.env"), gotrueEnv);');
    const gotrueEnvWrite = source.indexOf("await Bun.write(gotrueEnvPath, gotrueEnv);");
    const persistPorts = source.indexOf("await this.persistTenantPortConfig(ref, pgrstPort, gotruePort);");

    expect(gotrueConfigDirWrite).toBeGreaterThan(0);
    expect(gotrueEnvWrite).toBeGreaterThan(gotrueConfigDirWrite);
    expect(persistPorts).toBeGreaterThan(gotrueEnvWrite);
  });

  test("checks both GoTrue env and PostgREST conf files for port conflicts", () => {
    const source = sourceFile("src/services/tenant-runtime.service.ts");

    expect(source).toContain('file.endsWith("_gotrue.env")');
    expect(source).toContain("GOTRUE_API_PORT=${port}");
    expect(source).toContain('file.endsWith(".conf")');
    expect(source).toContain("server-port\\\\s*=\\\\s*${port}");
  });

  test("starts GoTrue with a watched config directory for hot reload", () => {
    const source = sourceFile("src/services/tenant-runtime.service.ts");

    expect(source).toContain("GOTRUE_RELOADING_SIGNAL_ENABLED=true");
    expect(source).toContain("GOTRUE_RELOADING_POLLER_ENABLED=true");
    expect(source).toContain("ExecStart=${this.GOTRUE_BIN} --config-dir ${this.TENANT_CONFIG_DIR}/%i_gotrue.d");
    expect(source).toContain("ExecReload=/bin/kill -USR1 $MAINPID");
    expect(source).toContain('!currentGotrueUnit.includes("--config-dir")');
  });

  test("OAuth edits reload GoTrue and keep runtime config dir in sync", () => {
    const source = sourceFile("src/services/tenant-oauth.service.ts");

    expect(source).toContain("return path.join(this.gotrueConfigDir(ref), \"runtime.env\");");
    expect(source).toContain("await Bun.write(this.gotrueRuntimeEnvPath(ref), content);");
    expect(source).toContain("await Bun.write(this.gotrueLegacyEnvPath(ref), content);");
    expect(source).toContain("systemctl reload supacloud-gotrue@${ref}");
    expect(source).toContain("systemctl restart supacloud-gotrue@${ref}");
    expect(source).toContain("updatedLines.push(`${enabledKey}=false`);");
  });
});
