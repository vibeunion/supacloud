import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { DatabaseService } from "../../src/services/database.service";
import { shellService } from "../../src/services/shell.service";

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

  beforeEach(() => {
    databaseService = new DatabaseService();

    mockSql = createMockSql();

    // Intercept database connections
    Object.defineProperty(DatabaseService.prototype, "adminDb", { get: () => mockSql, configurable: true });
    spyOn(DatabaseService.prototype as any, "getTenantDb").mockReturnValue(mockSql);

    // Mock disk space check to avoid shell dependency
    spyOn(DatabaseService.prototype as unknown as Record<string, unknown>, "checkDiskSpace").mockResolvedValue(undefined);

    // Mock applySupabaseSchema to avoid complex nested DB calls in simple tests
    spyOn(DatabaseService.prototype as unknown as Record<string, unknown>, "applySupabaseSchema").mockResolvedValue(undefined);
  });

  describe("generatePassword", () => {
    test("should generate a password string", () => {
      const password = databaseService.generatePassword();
      expect(typeof password).toBe("string");
      expect(password.length).toBe(24);
    });

    test("should generate unique passwords", () => {
      const password1 = databaseService.generatePassword();
      const password2 = databaseService.generatePassword();
      expect(password1).not.toBe(password2);
    });

    test("should only contain URL-safe characters", () => {
      const password = databaseService.generatePassword();
      expect(password).toMatch(/^[A-Za-z0-9]+$/);
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
