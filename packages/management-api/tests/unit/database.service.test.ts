import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
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
      expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe("createDatabase", () => {
    test("should return result object", async () => {
      const result = await databaseService.createDatabase("testref", "testpass");
      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("should call shell service with correct args", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      await databaseService.createDatabase("myproj", "mypass");
      expect(spy).toHaveBeenCalledWith("db_manager.sh", ["create", "myproj", "mypass"]);
      spy.mockRestore();
    });

    test("should return success when shell succeeds", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "created" });
      const result = await databaseService.createDatabase("testref", "testpass");
      expect(result.success).toBe(true);
      spy.mockRestore();
    });

    test("should return error when shell fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: false, output: "", error: "failed" });
      const result = await databaseService.createDatabase("testref", "testpass");
      expect(result.success).toBe(false);
      expect(result.error).toBe("failed");
      spy.mockRestore();
    });
  });

  describe("deleteDatabase", () => {
    test("should return result object", async () => {
      const result = await databaseService.deleteDatabase("testref");
      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("should call shell service with correct args", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      await databaseService.deleteDatabase("myproj");
      expect(spy).toHaveBeenCalledWith("db_manager.sh", ["delete", "myproj"]);
      spy.mockRestore();
    });
  });

  describe("checkStatus", () => {
    test("should return result with output", async () => {
      const result = await databaseService.checkStatus("testref");
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("output");
    });

    test("should call shell service with correct args", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "healthy" });
      await databaseService.checkStatus("myproj");
      expect(spy).toHaveBeenCalledWith("db_manager.sh", ["status", "myproj"]);
      spy.mockRestore();
    });
  });

  describe("getSecrets", () => {
    test("should return empty array when shell fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: false, output: "", error: "fail" });
      const result = await databaseService.getSecrets("testref");
      expect(result).toEqual([]);
      spy.mockRestore();
    });

    test("should return parsed JSON when shell succeeds", async () => {
      const secrets = [{ name: "API_KEY", value: "secret123" }];
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: JSON.stringify(secrets) });
      const result = await databaseService.getSecrets("testref");
      expect(result).toEqual(secrets);
      spy.mockRestore();
    });

    test("should return empty array when JSON parse fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "not valid json" });
      const result = await databaseService.getSecrets("testref");
      expect(result).toEqual([]);
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
      const result = await databaseService.upsertSecret("testref", "KEY", "value");
      expect(result).toBe(true);
      spy.mockRestore();
    });

    test("should return false when shell fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: false, output: "", error: "fail" });
      const result = await databaseService.upsertSecret("testref", "KEY", "value");
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("should call shell service with correct args", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      await databaseService.upsertSecret("myproj", "MY_KEY", "my_value");
      expect(spy).toHaveBeenCalledWith("key_manager.sh", ["set-secret", "myproj", "MY_KEY", "my_value"]);
      spy.mockRestore();
    });
  });

  describe("deleteSecret", () => {
    test("should return true when shell succeeds", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      const result = await databaseService.deleteSecret("testref", "KEY");
      expect(result).toBe(true);
      spy.mockRestore();
    });

    test("should return false when shell fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: false, output: "", error: "fail" });
      const result = await databaseService.deleteSecret("testref", "KEY");
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("should call shell service with correct args", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      await databaseService.deleteSecret("myproj", "MY_KEY");
      expect(spy).toHaveBeenCalledWith("key_manager.sh", ["delete-secret", "myproj", "MY_KEY"]);
      spy.mockRestore();
    });
  });
});
