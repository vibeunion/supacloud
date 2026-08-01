import { describe, test, expect, spyOn, mock } from "bun:test";
import { storageService, StorageService } from "../../src/services/storage.service";

// We must mock the adapter module since StorageService now uses it internally
const mockStorageDriver = {
  createBucket: mock().mockResolvedValue(true),
  deleteBucket: mock().mockResolvedValue(true),
  emptyBucket: mock().mockResolvedValue(true),
  listBuckets: mock().mockResolvedValue([]),
  listFiles: mock().mockResolvedValue([]),
  isBucketEmpty: mock().mockResolvedValue(true),
  uploadFile: mock().mockResolvedValue(true),
  deleteFile: mock().mockResolvedValue(true),
  getDownloadResponse: mock().mockResolvedValue(new Response()),
};

mock.module("../../src/services/storage.adapter", () => {
    return {
        getStorageDriver: () => mockStorageDriver
    };
});

describe("StorageService (using adapter)", () => {
  const service = storageService;

  describe("createBucket", () => {
    test("should return success when driver succeeds", async () => {
      mockStorageDriver.createBucket.mockResolvedValueOnce(true);
      const result = await storageService.createBucket("testref");
      expect(result.success).toBe(true);
    });

    test("should handle error when driver fails", async () => {
      mockStorageDriver.createBucket.mockResolvedValueOnce(false);
      const result = await storageService.createBucket("testref");
      expect(result.success).toBe(false);
    });

    test("should pass correct params to driver", async () => {
      mockStorageDriver.createBucket.mockResolvedValueOnce(true);
      await storageService.createBucket("myproj", "bucket");
      expect(mockStorageDriver.createBucket).toHaveBeenCalledWith("myproj", "bucket");
    });
  });

  describe("deleteBucket", () => {
    test("should return success when driver succeeds", async () => {
      mockStorageDriver.deleteBucket.mockResolvedValueOnce(true);
      const result = await storageService.deleteBucket("testref");
      expect(result.success).toBe(true);
    });

    test("should pass correct params to driver", async () => {
      mockStorageDriver.deleteBucket.mockResolvedValueOnce(true);
      await storageService.deleteBucket("myproj", "bucket");
      expect(mockStorageDriver.deleteBucket).toHaveBeenCalledWith("myproj", "bucket");
    });
  });

  describe("isBucketEmpty", () => {
    test("should preserve strict driver failures", async () => {
      mockStorageDriver.isBucketEmpty.mockRejectedValueOnce(new Error("storage unavailable"));
      await expect(StorageService.isBucketEmpty("myproj", "bucket")).rejects.toThrow("storage unavailable");
    });
  });

  describe("JuiceFS Methods / Status", () => {
    test("startMigration sends credentials over stdin instead of argv", async () => {
      let writtenCredentials = "";
      const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => ({
        stdin: {
          write(chunk: string) {
            writtenCredentials += chunk;
          },
          end() {},
        },
        stdout: new ReadableStream({ start(controller) { controller.close(); } }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
      })) as typeof Bun.spawn);

      const credentials = { access_key: "ak", secret_key: "sk", endpoint: "ep" };
      try {
        const result = await service.startMigration("s3://bucket", credentials);

        expect(result).toHaveProperty("jobId");
        const command = spawnSpy.mock.calls[0]?.[0] as string[];
        expect(command).toHaveLength(3);
        expect(command.join(" ")).not.toContain(credentials.access_key);
        expect(command.join(" ")).not.toContain(credentials.secret_key);
        expect(JSON.parse(writtenCredentials)).toEqual(credentials);
      } finally {
        spawnSpy.mockRestore();
      }
    });
  });
});
