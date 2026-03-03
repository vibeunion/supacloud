import { describe, test, expect, beforeEach, spyOn } from "bun:test";
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
    test.skip("should return result object", async () => {
      const result = await databaseService.createDatabase("testref123", "testpass");
      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });
  });

  describe("deleteDatabase", () => {
    test.skip("should return result object", async () => {
      const result = await databaseService.deleteDatabase("testref123");
      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });
  });

  describe("checkStatus", () => {
    test.skip("should return result with output", async () => {
      const result = await databaseService.checkStatus("testref123");
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("output");
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

    test("should return empty array when JSON parse fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "invalid json" });
      const result = await databaseService.getSecrets("testref");
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
      spy.mockRestore();
    });

    test("should call shell service with correct args", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "[]" });
      await databaseService.getSecrets("myproj");
      expect(spy).toHaveBeenCalledWith("key_manager.sh", ["list-secrets", "myproj"]);
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

    test("should call shell service with correct args", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      await databaseService.upsertSecret("myproj", "mykey", "myval");
      expect(spy).toHaveBeenCalledWith("key_manager.sh", ["set-secret", "myproj", "mykey", "myval"]);
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

    test("should return false when shell fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: false, output: "" });
      const result = await databaseService.deleteSecret("testref", "key1");
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("should call shell service with correct args", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      await databaseService.deleteSecret("myproj", "mykey");
      expect(spy).toHaveBeenCalledWith("key_manager.sh", ["delete-secret", "myproj", "mykey"]);
      spy.mockRestore();
    });
  });
});
