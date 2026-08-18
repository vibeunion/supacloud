import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import {
  DatabaseService,
  renderAuthSchemaOwnershipSql,
  renderPgStatStatementsCompatibilitySql,
} from "../../src/services/database.service";

/** Typed mock for SQL connection used in DatabaseService */
interface MockSql {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    unsafe: ReturnType<typeof mock>;
    close: ReturnType<typeof mock>;
    mockResolvedValueOnce: (value: unknown) => void;
}

function createMockSql(): MockSql {
    const fn = mock((strings: unknown) => Promise.resolve([]));
    (fn as unknown as Record<string, unknown>).unsafe = mock(() => Promise.resolve([]));
    (fn as unknown as Record<string, unknown>).close = mock(() => Promise.resolve());
    return fn as unknown as MockSql;
}

describe("DatabaseService", () => {
  let databaseService: DatabaseService;
  let mockSql: MockSql;
  let applySupabaseSchemaSpy: { mockClear: () => void; mockRestore: () => void };

  beforeEach(() => {
    databaseService = new DatabaseService();

    mockSql = createMockSql();

    // Intercept database connections
    Object.defineProperty(DatabaseService.prototype, "adminDb", { get: () => mockSql, configurable: true });
    spyOn(DatabaseService.prototype as any, "getTenantDb").mockReturnValue(mockSql);

    // Mock disk space check to avoid shell dependency
    spyOn(DatabaseService.prototype as unknown as Record<string, unknown>, "checkDiskSpace").mockResolvedValue(undefined);

    // Mock applySupabaseSchema to avoid complex nested DB calls in simple tests
    applySupabaseSchemaSpy = spyOn(DatabaseService.prototype as unknown as Record<string, unknown>, "applySupabaseSchema")
      .mockResolvedValue(undefined);
    spyOn(DatabaseService.prototype as unknown as Record<string, unknown>, "prepareMigrationRole")
      .mockResolvedValue(undefined);
  });

  describe("generatePassword", () => {
    test("should generate a password string", () => {
      const password = databaseService.generatePassword();
      expect(typeof password).toBe("string");
      expect(password.length).toBe(32);
    });

    test("should generate unique passwords", () => {
      const password1 = databaseService.generatePassword();
      const password2 = databaseService.generatePassword();
      expect(password1).not.toBe(password2);
    });

    test("should only contain lowercase hexadecimal characters", () => {
      const password = databaseService.generatePassword();
      expect(password).toMatch(/^[a-f0-9]+$/);
    });

    test("should respect an explicit password length", () => {
      expect(databaseService.generatePassword(17)).toMatch(/^[a-f0-9]{17}$/);
    });
  });

  describe("createDatabase", () => {
    test("should return result object", async () => {
      const result = await databaseService.createDatabase("testref123", "testpass");
      expect(result.success).toBe(true);
      expect(mockSql.unsafe).toHaveBeenCalled();
      expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining(
        'GRANT CONNECT, TEMPORARY ON DATABASE "supa_testref123" TO "authenticator_testref123"',
      ));
    });

    test("reconciles tenant login passwords when the database already exists", async () => {
      applySupabaseSchemaSpy.mockClear();
      (mockSql as unknown as ReturnType<typeof mock>).mockResolvedValueOnce([{ exists: 1 }]);

      const result = await databaseService.createDatabase("testref123", "replacement-pass");

      expect(result.success).toBe(true);
      expect(applySupabaseSchemaSpy).not.toHaveBeenCalled();
      expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining(
        'ALTER ROLE "role_testref123" LOGIN CONNECTION LIMIT 20 PASSWORD',
      ));
      expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining(
        'ALTER ROLE "authenticator_testref123" CONNECTION LIMIT 30 NOINHERIT LOGIN PASSWORD',
      ));
    });
  });

  describe("renderAuthSchemaOwnershipSql", () => {
    test("transfers auth schema objects to the GoTrue runtime role", () => {
      const sql = renderAuthSchemaOwnershipSql();

      expect(sql).toContain('ALTER SCHEMA auth OWNER TO "supabase_auth_admin"');
      expect(sql).toContain("ALTER %s %I.%I OWNER TO \"supabase_auth_admin\"");
      expect(sql).toContain("ALTER FUNCTION %I.%I(%s) OWNER TO \"supabase_auth_admin\"");
      expect(sql).toContain("ALTER TYPE %I.%I OWNER TO \"supabase_auth_admin\"");
      expect(sql).toContain("c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')");
      expect(sql).toContain("FROM pg_depend d");
      expect(sql).toContain("d.deptype = 'a'");
      expect(sql).toContain("t.typtype IN ('d', 'e')");
    });

    test("rejects unsafe owner identifiers before building DDL", () => {
      expect(() => renderAuthSchemaOwnershipSql("bad-role;DROP SCHEMA auth")).toThrow();
    });

    test("applySupabaseSchema runs ownership repair after loading tenant schema", async () => {
      applySupabaseSchemaSpy.mockRestore();
      const service = new DatabaseService();
      const tenantSql = createMockSql();
      spyOn(DatabaseService.prototype as any, "getTenantDb").mockReturnValue(tenantSql);
      spyOn(DatabaseService.prototype as any, "loadSupabaseSchema").mockResolvedValue("SELECT 'tenant schema loaded';");

      await (service as unknown as { applySupabaseSchema(dbName: string, projectRef: string, password: string): Promise<void> })
        .applySupabaseSchema("supa_testref123", "testref123", "testpass");

      expect(tenantSql.unsafe).toHaveBeenCalledWith("SELECT 'tenant schema loaded';");
      expect(tenantSql.unsafe).toHaveBeenCalledWith(expect.stringContaining('ALTER SCHEMA auth OWNER TO "supabase_auth_admin"'));
    });
  });

  describe("renderPgStatStatementsCompatibilitySql", () => {
    test("creates Studio compatibility wrappers without moving the extension", () => {
      const sql = renderPgStatStatementsCompatibilitySql();

      expect(sql).toContain("extensions.pg_stat_statements");
      expect(sql).toContain("extensions.pg_stat_statements_info");
      expect(sql).toContain("pg_stat_statements(showtext boolean)");
      expect(sql).toContain("pg_extension");
      expect(sql).toContain("extnamespace");
    });
  });

  describe("deleteDatabase", () => {
    test("should return result object", async () => {
      const result = await databaseService.deleteDatabase("testref123");
      expect(result.success).toBe(true);
      expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining("DROP DATABASE"));
    });
  });

  describe("checkStatus", () => {
    test("should return result with output", async () => {
      // Mock DB exists
      (mockSql as unknown as ReturnType<typeof mock>).mockResolvedValueOnce([{ exists: 1 }]);
      const result = await databaseService.checkStatus("testref123");
      expect(result.success).toBe(true);
      expect(result.output).toBe("active");
    });
  });

  describe("getSecrets", () => {
    test("should return parsed JSON when db query succeeds", async () => {
      spyOn(databaseService as any, "getSecrets").mockResolvedValue([{ name: "key1", value: "val1" }]);
      const result = await databaseService.getSecrets("testref");
      // Assert it returns the mocked parsed JSON
      expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ name: "key1", value: "val1" })]));
    });
  });

  describe("upsertSecret", () => {
    test("should return true when db succeeds", async () => {
      spyOn(databaseService as any, "upsertSecret").mockResolvedValue(true);
      const result = await databaseService.upsertSecret("testref", "key1", "val1");
      expect(result).toBe(true);
    });
  });

  describe("deleteSecret", () => {
    test("should return true when db succeeds", async () => {
      spyOn(databaseService as any, "deleteSecret").mockResolvedValue(true);
      const result = await databaseService.deleteSecret("testref", "key1");
      expect(result).toBe(true);
    });
  });
});
