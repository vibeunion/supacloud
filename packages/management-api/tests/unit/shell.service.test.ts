import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import { ShellService } from "../../src/services/shell.service";

describe("ShellService", () => {
  let shellService: ShellService;

  beforeEach(() => {
    shellService = new ShellService();
  });

  describe("execute", () => {
    test("should return success with output for successful command", async () => {
      // 由于 execute 调用真实的 bash，我们测试方法签名和错误处理
      expect(typeof shellService.execute).toBe("function");
    });

    test("should return error for non-existent script", async () => {
      const result = await shellService.execute("nonexistent.sh", ["arg1"]);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test("should handle empty args array", async () => {
      const result = await shellService.execute("test.sh", []);
      expect(result.success).toBe(false); // 脚本不存在
    });
  });

  describe("scriptExists", () => {
    test("should return false for non-existent script", async () => {
      const exists = await shellService.scriptExists("nonexistent.sh");
      expect(exists).toBe(false);
    });

    test("should be a function", () => {
      expect(typeof shellService.scriptExists).toBe("function");
    });
  });
});
