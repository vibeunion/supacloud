import { describe, test, expect, beforeEach, mock } from "bun:test";

const mockShell = {
  execute: mock(() => Promise.resolve({ success: true, output: "" })),
};

mock.module("../../src/services/shell.service", () => ({
  shellService: mockShell,
}));

import { DatabaseService } from "../../src/services/database.service";
import { shellService } from "../../src/services/shell.service";

describe("DatabaseService", () => {
  let databaseService: DatabaseService;

  beforeEach(() => {
    databaseService = new DatabaseService();
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
      const mockResult = { success: true, output: "" };
      mockShell.execute.mockResolvedValueOnce(mockResult);
      
      const result = await databaseService.createDatabase("testref123", "testpass");
      expect(result.success).toBe(true);
      expect(mockShell.execute).toHaveBeenCalledWith("db_manager.sh", ["create", "testref123", "testpass"]);
    });
  });

  describe("deleteDatabase", () => {
    test("should return result object", async () => {
      const mockResult = { success: true, output: "" };
      mockShell.execute.mockResolvedValueOnce(mockResult);

      const result = await databaseService.deleteDatabase("testref123");
      expect(result.success).toBe(true);
      expect(mockShell.execute).toHaveBeenCalledWith("db_manager.sh", ["delete", "testref123"]);
    });
  });

  describe("checkStatus", () => {
    test("should return result with output", async () => {
      const mockResult = { success: true, output: "RUNNING" };
      mockShell.execute.mockResolvedValueOnce(mockResult);

      const result = await databaseService.checkStatus("testref123");
      expect(result.success).toBe(true);
      expect(result.output).toBe("RUNNING");
      expect(mockShell.execute).toHaveBeenCalledWith("db_manager.sh", ["status", "testref123"]);
    });
  });

  describe("getSecrets", () => {
    test("should return empty array when shell fails", async () => {
      mockShell.execute.mockResolvedValueOnce({ success: false, output: "" });
      const result = await databaseService.getSecrets("testref");
      expect(Array.isArray(result)).toBe(true);
    });

    test("should return parsed JSON when shell succeeds", async () => {
      const mockData = [{ name: "key1", value: "val1" }];
      mockShell.execute.mockResolvedValueOnce({ success: true, output: JSON.stringify(mockData) });
      const result = await databaseService.getSecrets("testref");
      expect(result).toEqual(mockData);
    });

    test("should return empty array when JSON parse fails", async () => {
      mockShell.execute.mockResolvedValueOnce({ success: true, output: "invalid json" });
      const result = await databaseService.getSecrets("testref");
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    test("should call shell service with correct args", async () => {
      mockShell.execute.mockResolvedValueOnce({ success: true, output: "[]" });
      await databaseService.getSecrets("myproj");
      expect(mockShell.execute).toHaveBeenCalledWith("key_manager.sh", ["list-secrets", "myproj"]);
    });
  });

  describe("upsertSecret", () => {
    test("should return true when shell succeeds", async () => {
      mockShell.execute.mockResolvedValueOnce({ success: true, output: "" });
      const result = await databaseService.upsertSecret("testref", "key1", "val1");
      expect(result).toBe(true);
    });

    test("should return false when shell fails", async () => {
      mockShell.execute.mockResolvedValueOnce({ success: false, output: "" });
      const result = await databaseService.upsertSecret("testref", "key1", "val1");
      expect(result).toBe(false);
    });

    test("should call shell service with correct args", async () => {
      mockShell.execute.mockResolvedValueOnce({ success: true, output: "" });
      await databaseService.upsertSecret("myproj", "mykey", "myval");
      expect(mockShell.execute).toHaveBeenCalledWith("key_manager.sh", ["set-secret", "myproj", "mykey", "myval"]);
    });
  });

  describe("deleteSecret", () => {
    test("should return true when shell succeeds", async () => {
      mockShell.execute.mockResolvedValueOnce({ success: true, output: "" });
      const result = await databaseService.deleteSecret("testref", "key1");
      expect(result).toBe(true);
    });

    test("should return false when shell fails", async () => {
      mockShell.execute.mockResolvedValueOnce({ success: false, output: "" });
      const result = await databaseService.deleteSecret("testref", "key1");
      expect(result).toBe(false);
    });

    test("should call shell service with correct args", async () => {
      mockShell.execute.mockResolvedValueOnce({ success: true, output: "" });
      await databaseService.deleteSecret("myproj", "mykey");
      expect(mockShell.execute).toHaveBeenCalledWith("key_manager.sh", ["delete-secret", "myproj", "mykey"]);
    });
  });
});
