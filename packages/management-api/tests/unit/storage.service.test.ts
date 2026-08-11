import { describe, test, expect, spyOn, mock } from "bun:test";
import * as databaseModule from "../../src/db";
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
      mockStorageDriver.deleteBucket.mockResolvedValueOnce({ success: true });
      const result = await storageService.deleteBucket("testref");
      expect(result.success).toBe(true);
    });

    test("should pass correct params to driver", async () => {
      mockStorageDriver.deleteBucket.mockResolvedValueOnce({ success: true });
      await storageService.deleteBucket("myproj", "bucket");
      expect(mockStorageDriver.deleteBucket).toHaveBeenCalledWith("myproj", "bucket");
    });

    test("maps a non-empty directory result to a conflict without declaring deletion", async () => {
      mockStorageDriver.deleteBucket.mockResolvedValueOnce({ success: false, reason: "not_empty" });

      await expect(storageService.deleteBucket("myproj", "bucket")).resolves.toEqual({
        success: false,
        error: "Bucket is not empty",
      });
    });

    test("maps an indeterminate driver result without declaring deletion", async () => {
      mockStorageDriver.deleteBucket.mockResolvedValueOnce({ success: false, reason: "unknown" });

      await expect(storageService.deleteBucket("myproj", "bucket")).resolves.toEqual({
        success: false,
        error: "Bucket deletion outcome is unknown",
      });
    });
  });

  describe("isBucketEmpty", () => {
    test("should preserve strict driver failures", async () => {
      mockStorageDriver.isBucketEmpty.mockRejectedValueOnce(new Error("storage unavailable"));
      await expect(StorageService.isBucketEmpty("myproj", "bucket")).rejects.toThrow("storage unavailable");
    });
  });

  describe("updateBucket", () => {
    test("binds single and multiple MIME types as PostgreSQL TEXT arrays and clears with NULL", async () => {
      const sqlParameters: unknown[][] = [];
      const textArrayCalls: Array<{ values: string[]; type: string }> = [];
      const projectDatabaseTag = async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
        sqlParameters.push(parameters);
        return strings.join("?").includes("SELECT * FROM storage.buckets")
          ? [{
              id: "reports",
              name: "reports",
              public: false,
              file_size_limit: null,
              allowed_mime_types: ["application/pdf"],
            }]
          : [];
      };
      const projectDatabase = Object.assign(projectDatabaseTag, {
        array(values: string[], type: string) {
          textArrayCalls.push({ values, type });
          return values;
        },
      }) as never;
      const resolveDbName = spyOn(databaseModule, "resolveDbName").mockResolvedValue("supa_testref");
      const getProjectDb = spyOn(databaseModule, "getProjectDb").mockReturnValue(projectDatabase);

      try {
        const singleResponse = await StorageService.updateBucket("testref", "reports", {
          allowed_mime_types: ["application/pdf"],
        });
        const multipleResponse = await StorageService.updateBucket("testref", "reports", {
          allowed_mime_types: ["application/pdf", "image/png"],
        });
        const clearedResponse = await StorageService.updateBucket("testref", "reports", {
          allowed_mime_types: [],
        });

        expect(singleResponse.success).toBe(true);
        expect(multipleResponse.success).toBe(true);
        expect(clearedResponse.success).toBe(true);
        expect(sqlParameters[0]).toEqual([["application/pdf"], "reports"]);
        expect(sqlParameters[2]).toEqual([["application/pdf", "image/png"], "reports"]);
        expect(sqlParameters[4]).toEqual([null, "reports"]);
        expect(textArrayCalls).toEqual([
          { values: ["application/pdf"], type: "TEXT" },
          { values: ["application/pdf", "image/png"], type: "TEXT" },
        ]);
        expect(sqlParameters.flat().join(" ")).not.toContain('["application/pdf"]');
      } finally {
        resolveDbName.mockRestore();
        getProjectDb.mockRestore();
      }
    });

    test.each([
      ["project ref", "bad.ref", "reports", { public: true }],
      ["dot-only bucket", "testref", "...", { public: true }],
      ["negative file limit", "testref", "reports", { file_size_limit: -1 }],
      ["fractional file limit", "testref", "reports", { file_size_limit: 1.5 }],
      ["overflowing file limit", "testref", "reports", { file_size_limit: Number.MAX_SAFE_INTEGER + 1 }],
      ["empty MIME", "testref", "reports", { allowed_mime_types: [""] }],
      ["overlong MIME", "testref", "reports", { allowed_mime_types: [`text/${"a".repeat(251)}`] }],
      ["too many MIME types", "testref", "reports", {
        allowed_mime_types: Array.from({ length: 101 }, (_, index) => `application/x-${index}`),
      }],
    ])("rejects invalid %s before opening a project database", async (_label, ref, bucket, updates) => {
      const getProjectDb = spyOn(databaseModule, "getProjectDb");
      try {
        const response = await StorageService.updateBucket(ref, bucket, updates);

        expect(response.success).toBe(false);
        expect(response.error).toStartWith("Invalid ");
        expect(getProjectDb).not.toHaveBeenCalled();
      } finally {
        getProjectDb.mockRestore();
      }
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
