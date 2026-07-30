import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { config } from "../../src/config";
import { StorageService } from "../../src/services/storage.service";

const originalStorageType = config.storageType;
const originalStorageMountPoint = config.storageMountPoint;
const originalS3Endpoint = config.s3Endpoint;
const originalFetch = globalThis.fetch;

afterEach(() => {
  config.storageType = originalStorageType;
  config.storageMountPoint = originalStorageMountPoint;
  config.s3Endpoint = originalS3Endpoint;
  globalThis.fetch = originalFetch;
});

describe("StorageService.getStatus", () => {
  test("uses the configured filesystem root and reports real capacity", async () => {
    config.storageType = "local";
    config.storageMountPoint = "/var/lib/supabase/storage";
    const statfsSpy = spyOn(fs, "statfs").mockResolvedValue({
      bsize: 1024,
      blocks: 1_000,
      bavail: 250,
    } as Awaited<ReturnType<typeof fs.statfs>>);

    try {
      await expect(StorageService.getStatus()).resolves.toEqual({
        status: "mounted",
        backend: "local",
        mountPoint: "/var/lib/supabase/storage",
        healthy: true,
        size: "1000 KB",
        used: "750 KB",
        avail: "250 KB",
        use_percent: "75%",
      });
      expect(statfsSpy).toHaveBeenCalledWith("/var/lib/supabase/storage");
    } finally {
      statfsSpy.mockRestore();
    }
  });

  test("does not invent capacity for object storage and returns its health reason", async () => {
    config.storageType = "s3";
    config.s3Endpoint = "http://object.example/";
    globalThis.fetch = mock(async () => new Response(null, { status: 503 })) as typeof fetch;

    await expect(StorageService.getStatus()).resolves.toEqual({
      status: "unmounted",
      backend: "s3",
      healthy: false,
      reason: "object_storage_http_error",
      reasonStatus: 503,
    });
  });
});
