import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { StorageService } from "../../src/services/storage.service";
import { shellService } from "../../src/services/shell.service";

describe("StorageService", () => {
  let storageService: StorageService;

  beforeEach(() => {
    storageService = new StorageService();
  });

  describe("createBucket", () => {
    test("should return result object", async () => {
      const result = await storageService.createBucket("testref");
      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("should return error when shell fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: false, output: "", error: "bucket creation failed" });
      const result = await storageService.createBucket("testref");
      expect(result.success).toBe(false);
      expect(result.error).toBe("bucket creation failed");
      spy.mockRestore();
    });

    test("should parse access key and secret from output", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({
        success: true,
        output: "ACCESS_KEY=myaccesskey\nSECRET_KEY=mysecretkey\n",
      });
      const result = await storageService.createBucket("testref");
      expect(result.success).toBe(true);
      expect(result.accessKey).toBe("myaccesskey");
      expect(result.secretKey).toBe("mysecretkey");
      spy.mockRestore();
    });

    test("should handle output without keys", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({
        success: true,
        output: "Bucket created successfully",
      });
      const result = await storageService.createBucket("testref");
      expect(result.success).toBe(true);
      expect(result.accessKey).toBeUndefined();
      expect(result.secretKey).toBeUndefined();
      spy.mockRestore();
    });

    test("should handle partial key output", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({
        success: true,
        output: "ACCESS_KEY=onlyaccess\nsome other line",
      });
      const result = await storageService.createBucket("testref");
      expect(result.success).toBe(true);
      expect(result.accessKey).toBe("onlyaccess");
      expect(result.secretKey).toBeUndefined();
      spy.mockRestore();
    });

    test("should call shell service with correct args", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      await storageService.createBucket("myproj");
      expect(spy).toHaveBeenCalledWith("s3_manager.sh", ["create", "myproj"]);
      spy.mockRestore();
    });
  });

  describe("deleteBucket", () => {
    test("should return result object", async () => {
      const result = await storageService.deleteBucket("testref");
      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("should return success when shell succeeds", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "deleted" });
      const result = await storageService.deleteBucket("testref");
      expect(result.success).toBe(true);
      spy.mockRestore();
    });

    test("should return error when shell fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: false, output: "", error: "delete failed" });
      const result = await storageService.deleteBucket("testref");
      expect(result.success).toBe(false);
      expect(result.error).toBe("delete failed");
      spy.mockRestore();
    });

    test("should call shell service with correct args", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      await storageService.deleteBucket("myproj");
      expect(spy).toHaveBeenCalledWith("s3_manager.sh", ["delete", "myproj"]);
      spy.mockRestore();
    });
  });

  describe("getCredentials", () => {
    test("should return result object", async () => {
      const result = await storageService.getCredentials("testref");
      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("should return error when shell fails", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: false, output: "", error: "credentials not found" });
      const result = await storageService.getCredentials("testref");
      expect(result.success).toBe(false);
      expect(result.error).toBe("credentials not found");
      spy.mockRestore();
    });

    test("should parse access key and secret from output", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({
        success: true,
        output: "ACCESS_KEY=credaccesskey\nSECRET_KEY=credsecretkey\n",
      });
      const result = await storageService.getCredentials("testref");
      expect(result.success).toBe(true);
      expect(result.accessKey).toBe("credaccesskey");
      expect(result.secretKey).toBe("credsecretkey");
      spy.mockRestore();
    });

    test("should handle output without keys", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({
        success: true,
        output: "No credentials found",
      });
      const result = await storageService.getCredentials("testref");
      expect(result.success).toBe(true);
      expect(result.accessKey).toBeUndefined();
      expect(result.secretKey).toBeUndefined();
      spy.mockRestore();
    });

    test("should handle only secret key in output", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({
        success: true,
        output: "SECRET_KEY=onlysecret\n",
      });
      const result = await storageService.getCredentials("testref");
      expect(result.success).toBe(true);
      expect(result.accessKey).toBeUndefined();
      expect(result.secretKey).toBe("onlysecret");
      spy.mockRestore();
    });

    test("should call shell service with correct args", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({ success: true, output: "" });
      await storageService.getCredentials("myproj");
      expect(spy).toHaveBeenCalledWith("s3_manager.sh", ["credentials", "myproj"]);
      spy.mockRestore();
    });

    test("should handle multiline output with extra content", async () => {
      const spy = spyOn(shellService, "execute").mockResolvedValue({
        success: true,
        output: "Starting...\nACCESS_KEY=key1\nProcessing...\nSECRET_KEY=key2\nDone.",
      });
      const result = await storageService.getCredentials("testref");
      expect(result.success).toBe(true);
      expect(result.accessKey).toBe("key1");
      expect(result.secretKey).toBe("key2");
      spy.mockRestore();
    });
  });
});
