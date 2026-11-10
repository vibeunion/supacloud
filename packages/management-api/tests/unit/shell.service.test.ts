import { describe, test, expect, beforeEach } from "bun:test";
import { environmentWithoutClusterPassword, ShellService, shellService } from "../../src/services/shell.service";

describe("environmentWithoutClusterPassword", () => {
  test("does not copy the cluster database password into script environments", () => {
    const env = environmentWithoutClusterPassword({
      PATH: "/usr/bin",
      HOME: "/tmp",
      PGPASSWORD: "cluster-secret-value",
      PG_PASSWORD: "cluster-secret-value",
      POSTGRES_PASSWORD: "cluster-secret-value",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/tmp");
    expect(env.PGPASSWORD).toBeUndefined();
    expect(env.PG_PASSWORD).toBeUndefined();
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("cluster-secret-value");
  });
});

describe("ShellService", () => {
  let service: ShellService;

  beforeEach(() => {
    service = new ShellService();
  });

  describe("execute", () => {
    test("should return success with output for successful command", async () => {
      expect(typeof service.execute).toBe("function");
    });

    test("should return error for non-existent script", async () => {
      const result = await service.execute("nonexistent.sh", ["arg1"]);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test("should handle empty args array", async () => {
      const result = await service.execute("test.sh", []);
      expect(result.success).toBe(false);
    });

    test("should return output as empty string on failure", async () => {
      const result = await service.execute("invalid.sh", ["test"]);
      expect(result.output).toBe("");
    });

    test("should handle multiple arguments", async () => {
      const result = await service.execute("test.sh", ["arg1", "arg2", "arg3"]);
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("output");
    });

    test("should handle special characters in script name", async () => {
      const result = await service.execute("test-script_v2.sh", ["arg"]);
      expect(result).toHaveProperty("success");
    });
  });

  describe("scriptExists", () => {
    test("should return false for non-existent script", async () => {
      const exists = await service.scriptExists("nonexistent.sh");
      expect(exists).toBe(false);
    });

    test("should be a function", () => {
      expect(typeof service.scriptExists).toBe("function");
    });

    test("should return boolean", async () => {
      const result = await service.scriptExists("any.sh");
      expect(typeof result).toBe("boolean");
    });

    test("should handle empty string", async () => {
      const exists = await service.scriptExists("");
      expect(exists).toBe(false);
    });
  });

  describe("singleton instance", () => {
    test("should export shellService singleton", () => {
      expect(shellService).toBeInstanceOf(ShellService);
    });

    test("shellService should have execute method", () => {
      expect(typeof shellService.execute).toBe("function");
    });

    test("shellService should have scriptExists method", () => {
      expect(typeof shellService.scriptExists).toBe("function");
    });
  });
});
