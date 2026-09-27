import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { config } from "../../src/config";
import { StorageService } from "../../src/services/storage.service";
import { tenantRuntimeService } from "../../src/services/tenant-runtime.service";

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

describe("tenant Storage health readback", () => {
  const runtime = tenantRuntimeService as unknown as {
    checkStorageHealth(): Promise<string>;
  };

  test("uses the configured filesystem root without an S3 request", async () => {
    config.storageType = "local";
    config.storageMountPoint = "/var/lib/supabase/storage";
    const statfsSpy = spyOn(fs, "statfs").mockResolvedValue({
      bsize: 1024, blocks: 1_000, bavail: 250,
    } as Awaited<ReturnType<typeof fs.statfs>>);
    const fetchSpy = mock(async () => { throw new Error("S3 must not be probed"); });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      expect(await runtime.checkStorageHealth()).toBe("ACTIVE_HEALTHY");
      expect(statfsSpy).toHaveBeenCalledWith(config.storageMountPoint);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      statfsSpy.mockRestore();
    }
  });

  test.each([403, 503])("does not classify HTTP %s as healthy", async (status) => {
    config.storageType = "s3";
    globalThis.fetch = mock(async () => new Response(null, { status })) as typeof fetch;
    expect(await runtime.checkStorageHealth()).toBe("INACTIVE");
  });

  test("reports a missing configured filesystem root as unhealthy", async () => {
    config.storageType = "juicefs";
    config.storageMountPoint = "/missing/storage";
    const statfsSpy = spyOn(fs, "statfs").mockRejectedValue(new Error("ENOENT"));
    try {
      expect(await runtime.checkStorageHealth()).toBe("INACTIVE");
      expect(statfsSpy).toHaveBeenCalledWith("/missing/storage");
    } finally {
      statfsSpy.mockRestore();
    }
  });
});
