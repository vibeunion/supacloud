import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

import { branchService } from "../../src/services/branch.service";
import { databaseService } from "../../src/services/database.service";
import { tenantRuntimeService } from "../../src/services/tenant-runtime.service";
import { projectRepository } from "../../src/repositories/project.repository";

type SpawnInvocation = {
  cmd: string[];
  env?: Record<string, string | undefined>;
  stdin?: unknown;
};

function fakeSubprocess(options: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  return {
    exited: Promise.resolve(options.exitCode ?? 0),
    stdout: new Response(options.stdout ?? "").body,
    stderr: new Response(options.stderr ?? "").body,
  } as unknown as ReturnType<typeof Bun.spawn>;
}

describe("branchService", () => {
  afterEach(() => {
    // bun:test restores spies individually; keep cleanup explicit for this service-level test.
  });

  test("createBranch restores into an empty database instead of pre-applying the tenant schema", async () => {
    const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue({
      ref: "parent",
      name: "Parent Project",
      db_password: "parent-password",
      jwt_secret: "jwt-secret",
      anon_key: "anon-key",
      service_role_key: "service-role-key",
      region: "local",
      config: {},
    } as never);
    const createProjectSpy = spyOn(projectRepository, "create").mockResolvedValue({ ref: "branch" } as never);
    const createDatabaseSpy = spyOn(databaseService, "createDatabase").mockResolvedValue({ success: true });
    const restartSpy = spyOn(tenantRuntimeService, "restartRuntime").mockResolvedValue({ success: true } as never);

    const createEmptySpy = spyOn(branchService as unknown as { createEmptyTenantDatabase: () => Promise<void> }, "createEmptyTenantDatabase").mockResolvedValue(undefined);
    const cloneSpy = spyOn(branchService as unknown as { cloneDatabase: () => Promise<void> }, "cloneDatabase").mockResolvedValue(undefined);
    const grantsSpy = spyOn(branchService as unknown as { applyRuntimeGrants: () => Promise<void> }, "applyRuntimeGrants").mockResolvedValue(undefined);

    try {
      await branchService.createBranch({ parentRef: "parent", branchRef: "branch", name: "feature-x" });

      expect(createProjectSpy).toHaveBeenCalledTimes(1);
      expect(createEmptySpy).toHaveBeenCalledTimes(1);
      expect(cloneSpy).toHaveBeenCalledWith("supa_parent", "supa_branch");
      expect(grantsSpy).toHaveBeenCalledTimes(1);
      expect(createDatabaseSpy).not.toHaveBeenCalled();
      expect(restartSpy).toHaveBeenCalledWith("branch");
    } finally {
      findSpy.mockRestore();
      createProjectSpy.mockRestore();
      createDatabaseSpy.mockRestore();
      restartSpy.mockRestore();
      createEmptySpy.mockRestore();
      cloneSpy.mockRestore();
      grantsSpy.mockRestore();
    }
  });

  test("cloneDatabase keeps special-character credentials out of structured pg argv", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const password = `p@#?/ '"$()`;
    process.env.DATABASE_URL = `postgresql://admin:${encodeURIComponent(password)}@db.internal:5432/control?sslmode=require`;
    const conflictingEnvironment = {
      PGPASSWORD: "stale-password",
      PGPASSFILE: "/tmp/stale.pgpass",
      PGSERVICE: "stale-service",
      PGSERVICEFILE: "/tmp/stale-service.conf",
      PGHOST: "attacker.invalid",
      PGPORT: "9999",
      PGUSER: "attacker",
      PGDATABASE: "attacker",
      PGOPTIONS: "-c role=attacker",
      PGSSLMODE: "disable",
      PGCONNECT_TIMEOUT: "1",
      PGAPPNAME: "attacker-app",
      PGSSLROOTCERT: "/tmp/attacker-ca.pem",
    } as const;
    const originalConflictingEnvironment = Object.fromEntries(
      Object.keys(conflictingEnvironment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, conflictingEnvironment);

    const invocations: SpawnInvocation[] = [];
    const dump = fakeSubprocess({ stdout: "SELECT 1;" });
    const restore = fakeSubprocess();
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((options: SpawnInvocation) => {
      invocations.push(options);
      return invocations.length === 1 ? dump : restore;
    }) as typeof Bun.spawn);

    try {
      await (branchService as unknown as {
        cloneDatabase(sourceDb: string, targetDb: string): Promise<void>;
      }).cloneDatabase("supa_parent", "supa_branch");

      expect(invocations).toHaveLength(2);
      expect(invocations[0]?.cmd).toEqual([
        "pg_dump",
        "--no-owner",
        "--no-privileges",
        "--host", "db.internal",
        "--port", "5432",
        "--username", "admin",
        "--dbname", "supa_parent",
      ]);
      expect(invocations[1]?.cmd).toEqual([
        "psql",
        "--host", "db.internal",
        "--port", "5432",
        "--username", "admin",
        "--dbname", "supa_branch",
        "--set", "ON_ERROR_STOP=on",
        "--quiet",
      ]);
      expect(invocations[0]?.env?.PGPASSWORD).toBe(password);
      expect(invocations[1]?.env?.PGPASSWORD).toBe(password);
      expect(invocations[0]?.env?.PGSSLMODE).toBe("require");
      expect(invocations[0]?.env?.DATABASE_URL).toBeUndefined();
      expect(invocations[1]?.env?.DATABASE_URL).toBeUndefined();
      for (const key of Object.keys(conflictingEnvironment)) {
        if (key === "PGPASSWORD" || key === "PGSSLMODE") continue;
        expect(invocations[0]?.env?.[key]).toBeUndefined();
        expect(invocations[1]?.env?.[key]).toBeUndefined();
      }
      expect(invocations[1]?.stdin).toBe(dump.stdout);

      const serializedArgv = JSON.stringify(invocations.map(({ cmd }) => cmd));
      expect(serializedArgv).not.toContain(password);
      expect(serializedArgv).not.toContain(encodeURIComponent(password));
      expect(serializedArgv).not.toContain("postgresql://");
    } finally {
      spawnSpy.mockRestore();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      for (const [key, value] of Object.entries(originalConflictingEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("cloneDatabase fails closed for malformed or incomplete DATABASE_URL values", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const invalidUrls = [
      "not-a-url",
      "https://admin:secret@db.internal:5432/control",
      "postgresql://admin@db.internal:5432/control",
      "postgresql://:secret@db.internal:5432/control",
      "postgresql://admin:secret@db.internal:5432/",
      "postgresql://admin:secret@db.internal:0/control",
      "postgresql://admin:secret@db.internal:5432/control\rPGPASSWORD=attacker",
      `postgresql://admin:${"p".repeat(1_025)}@db.internal:5432/control`,
      "postgresql://admin:secret@db.internal:5432/control?sslmode=require%0APGHOST=attacker",
    ];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
      throw new Error("subprocess must not start for an invalid DATABASE_URL");
    }) as typeof Bun.spawn);

    try {
      for (const invalidUrl of invalidUrls) {
        process.env.DATABASE_URL = invalidUrl;
        await expect((branchService as unknown as {
          cloneDatabase(sourceDb: string, targetDb: string): Promise<void>;
        }).cloneDatabase("supa_parent", "supa_branch")).rejects.toThrow("DATABASE_URL");
      }
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  test("cloneDatabase fails on either pipeline process and bounds redacted diagnostics", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const password = `admin@#?/ '"$()`;
    const encodedPassword = encodeURIComponent(password);
    process.env.DATABASE_URL = `postgresql://admin:${encodedPassword}@db.internal:5432/control`;

    let subprocesses: ReturnType<typeof Bun.spawn>[] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
      const next = subprocesses.shift();
      if (!next) throw new Error("unexpected Bun.spawn call");
      return next;
    }) as typeof Bun.spawn);

    try {
      for (const scenario of [
        { label: "pg_dump", dumpExit: 9, restoreExit: 0 },
        { label: "psql", dumpExit: 0, restoreExit: 7 },
      ]) {
        const noisySecret = `${password}:${encodedPassword}:${"x".repeat(20_000)}`;
        subprocesses = [
          fakeSubprocess({ exitCode: scenario.dumpExit, stdout: "SELECT 1;", stderr: scenario.dumpExit ? noisySecret : "" }),
          fakeSubprocess({ exitCode: scenario.restoreExit, stderr: scenario.restoreExit ? noisySecret : "" }),
        ];

        const rejection = (branchService as unknown as {
          cloneDatabase(sourceDb: string, targetDb: string): Promise<void>;
        }).cloneDatabase("supa_parent", "supa_branch");
        try {
          await rejection;
          throw new Error("expected cloneDatabase to reject");
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).toContain(`${scenario.label} exited with code`);
          expect(message).not.toContain(password);
          expect(message).not.toContain(encodedPassword);
          expect(message).toContain("[output truncated]");
          expect(message.length).toBeLessThanOrEqual(4_500);
        }
      }
    } finally {
      spawnSpy.mockRestore();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  test("applyRuntimeGrants sends SQL on stdin without repeating role passwords in argv", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const adminPassword = `admin @/#?'"$()`;
    const tenantPassword = `tenant @/#?'"$()`;
    process.env.DATABASE_URL = `postgresql://postgres:${encodeURIComponent(adminPassword)}@db.internal:5432/control`;

    let invocation: SpawnInvocation | undefined;
    const stderr = `${adminPassword}:${encodeURIComponent(adminPassword)}:${tenantPassword}:${encodeURIComponent(tenantPassword)}:${"z".repeat(20_000)}`;
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((options: SpawnInvocation) => {
      invocation = options;
      return fakeSubprocess({ exitCode: 6, stderr });
    }) as typeof Bun.spawn);

    try {
      let message = "";
      try {
        await (branchService as unknown as {
          applyRuntimeGrants(dbName: string, projectRef: string, password: string): Promise<void>;
        }).applyRuntimeGrants("supa_branch", "branch", tenantPassword);
        throw new Error("expected applyRuntimeGrants to reject");
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(invocation?.cmd).toEqual([
        "psql",
        "--host", "db.internal",
        "--port", "5432",
        "--username", "postgres",
        "--dbname", "supa_branch",
        "--set", "ON_ERROR_STOP=on",
        "--quiet",
      ]);
      expect(invocation?.env?.PGPASSWORD).toBe(adminPassword);
      const serializedArgv = JSON.stringify(invocation?.cmd ?? []);
      expect(serializedArgv).not.toContain(adminPassword);
      expect(serializedArgv).not.toContain(tenantPassword);
      expect(serializedArgv).not.toContain("postgresql://");
      expect(serializedArgv).not.toContain("--command");

      expect(invocation?.stdin).toBeInstanceOf(Blob);
      const sqlText = await (invocation?.stdin as Blob).text();
      expect(sqlText).toContain("GRANT anon, authenticated, service_role");
      expect(sqlText).not.toContain("ALTER ROLE");
      expect(sqlText).not.toContain(tenantPassword);

      expect(message).toContain("apply runtime grants failed");
      expect(message).toContain("psql exited with code 6");
      expect(message).not.toContain(adminPassword);
      expect(message).not.toContain(encodeURIComponent(adminPassword));
      expect(message).not.toContain(tenantPassword);
      expect(message).not.toContain(encodeURIComponent(tenantPassword));
      expect(message).toContain("[output truncated]");
      expect(message.length).toBeLessThanOrEqual(4_500);
    } finally {
      spawnSpy.mockRestore();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  test("createEmptyTenantDatabase sends only a client-generated SCRAM verifier to unsafe SQL", async () => {
    const password = `tenant-plain @/#?'"$()-must-never-enter-sql`;
    const service = branchService as unknown as {
      databaseExists(dbName: string): Promise<boolean>;
      executeUnsafeSql(statement: string): Promise<void>;
      createEmptyTenantDatabase(dbName: string, projectRef: string, password: string): Promise<void>;
    };
    const databaseExistsSpy = spyOn(service, "databaseExists").mockResolvedValue(false);
    const statements: string[] = [];
    const unsafeSpy = spyOn(service, "executeUnsafeSql").mockImplementation(async (statement: string) => {
      statements.push(statement);
    });

    try {
      await service.createEmptyTenantDatabase("supa_branch", "branch", password);

      const roleSql = statements.find((statement) => statement.includes("CREATE ROLE"));
      expect(roleSql).toBeDefined();
      expect(roleSql).not.toContain(password);
      expect(roleSql).not.toContain(encodeURIComponent(password));
      expect(roleSql?.match(/PASSWORD/g)).toHaveLength(4);
      expect(roleSql?.match(/SCRAM-SHA-256/g)).toHaveLength(4);

      const verifierMatch = roleSql?.match(
        /SCRAM-SHA-256\$4096:([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)/,
      );
      expect(verifierMatch).not.toBeNull();
      const [, saltBase64, storedKeyBase64, serverKeyBase64] = verifierMatch ?? [];
      const saltedPassword = pbkdf2Sync(password, Buffer.from(saltBase64 ?? "", "base64"), 4_096, 32, "sha256");
      const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
      const expectedStoredKey = createHash("sha256").update(clientKey).digest("base64");
      const expectedServerKey = createHmac("sha256", saltedPassword).update("Server Key").digest("base64");
      expect(storedKeyBase64).toBe(expectedStoredKey);
      expect(serverKeyBase64).toBe(expectedServerKey);
    } finally {
      unsafeSpy.mockRestore();
      databaseExistsSpy.mockRestore();
    }
  });

  test("PostgreSQL diagnostics redact secrets across the capture boundary and stay within 4096 UTF-8 bytes", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const adminPassword = "ADMIN-BOUNDARY-SECRET-@/#?$()";
    const tenantPassword = "TENANT-BOUNDARY-SECRET-@/#?$()";
    process.env.DATABASE_URL = `postgresql://postgres:${encodeURIComponent(adminPassword)}@db.internal:5432/control`;

    let subprocesses: ReturnType<typeof Bun.spawn>[] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
      const next = subprocesses.shift();
      if (!next) throw new Error("unexpected Bun.spawn call");
      return next;
    }) as typeof Bun.spawn);

    try {
      subprocesses = [
        fakeSubprocess({
          exitCode: 9,
          stdout: "SELECT 1;",
          stderr: `${"界".repeat(1_362)}${adminPassword}${"x".repeat(8_000)}`,
        }),
        fakeSubprocess(),
      ];
      let cloneMessage = "";
      try {
        await (branchService as unknown as {
          cloneDatabase(sourceDb: string, targetDb: string): Promise<void>;
        }).cloneDatabase("supa_parent", "supa_branch");
      } catch (error: unknown) {
        cloneMessage = error instanceof Error ? error.message : String(error);
      }

      expect(cloneMessage).not.toContain(adminPassword);
      expect(cloneMessage).not.toContain(adminPassword.slice(0, 8));
      expect(new TextEncoder().encode(cloneMessage).byteLength).toBeLessThanOrEqual(4_096);
      expect(cloneMessage).toContain("[output truncated]");

      subprocesses = [
        fakeSubprocess({
          exitCode: 7,
          stderr: `${"界".repeat(1_362)}${encodeURIComponent(tenantPassword)}${"y".repeat(8_000)}`,
        }),
      ];
      let grantsMessage = "";
      try {
        await (branchService as unknown as {
          applyRuntimeGrants(dbName: string, projectRef: string, password: string): Promise<void>;
        }).applyRuntimeGrants("supa_branch", "branch", tenantPassword);
      } catch (error: unknown) {
        grantsMessage = error instanceof Error ? error.message : String(error);
      }

      expect(grantsMessage).not.toContain(tenantPassword);
      expect(grantsMessage).not.toContain(encodeURIComponent(tenantPassword));
      expect(grantsMessage).not.toContain(encodeURIComponent(tenantPassword).slice(0, 8));
      expect(new TextEncoder().encode(grantsMessage).byteLength).toBeLessThanOrEqual(4_096);
      expect(grantsMessage).toContain("[output truncated]");
    } finally {
      spawnSpy.mockRestore();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });
});
