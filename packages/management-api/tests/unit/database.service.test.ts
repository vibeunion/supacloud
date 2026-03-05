import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { DatabaseService } from "../../src/services/database.service";
import { shellService } from "../../src/services/shell.service";

describe("DatabaseService", () => {
  let databaseService: DatabaseService;
  let mockSql: any;

  beforeEach(() => {
    databaseService = new DatabaseService();
    
    // Mock SQL object - return empty array by default so "exists" checks pass (false)
    mockSql = mock((strings: any) => Promise.resolve([]));
    mockSql.unsafe = mock(() => Promise.resolve([]));
    mockSql.close = mock(() => Promise.resolve());

    // Intercept database connections
    spyOn(DatabaseService.prototype as any, "getAdminDb").mockReturnValue(mockSql);
    spyOn(DatabaseService.prototype as any, "getTenantDb").mockReturnValue(mockSql);
    
    // Mock disk space check to avoid shell dependency
    spyOn(DatabaseService.prototype as any, "checkDiskSpace").mockResolvedValue(undefined);
    
    // Mock applySupabaseSchema to avoid complex nested DB calls in simple tests
    spyOn(DatabaseService.prototype as any, "applySupabaseSchema").mockResolvedValue(undefined);
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
      mockSql.mockResolvedValueOnce([{ exists: 1 }]);
      const result = await databaseService.checkStatus("testref123");
      expect(result.success).toBe(true);
      expect(result.output).toBe("active");
    });
  });

  describe("getSecrets", () => {
    test("should return empty array when shell fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: false, output: "" });
      const result = await databaseService.getSecrets("testref");
      expect(Array.isArray(result)).toBe(true);
      spy.mockRestore();
    });

    test("should return parsed JSON when shell succeeds", async () => {
      const mockData = [{ name: "key1", value: "val1" }];
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: JSON.stringify(mockData) });
      const result = await databaseService.getSecrets("testref");
      expect(result).toEqual(mockData);
      spy.mockRestore();
    });
  });

  describe("upsertSecret", () => {
    test("should return true when shell succeeds", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      const result = await databaseService.upsertSecret("testref", "key1", "val1");
      expect(result).toBe(true);
      spy.mockRestore();
    });

    test("should return false when shell fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: false, output: "" });
      const result = await databaseService.upsertSecret("testref", "key1", "val1");
      expect(result).toBe(false);
      spy.mockRestore();
    });
  });

  describe("deleteSecret", () => {
    test("should return true when shell succeeds", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      const result = await databaseService.deleteSecret("testref", "key1");
      expect(result).toBe(true);
      spy.mockRestore();
    });
  });
});
