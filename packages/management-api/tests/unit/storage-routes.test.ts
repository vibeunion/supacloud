import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { storageRoutes } from "../../src/routes/storage";
import { StorageService } from "../../src/services/storage.service";
import { StorageRLS } from "../../src/services/storage-rls";

const BASE = "http://localhost";
const app = new Elysia().use(storageRoutes);

function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`${BASE}${path}`, init));
}

describe("storage management routes", () => {
  test("management upload accepts zero-byte files and honors explicit path", async () => {
    const uploadSpy = spyOn(StorageService, "uploadFile").mockResolvedValue(true);
    const formData = new FormData();
    formData.append("file", new Blob([], { type: "text/plain" }), "empty.txt");
    formData.append("path", "nested/empty.txt");

    const unauthenticated = await request("/v1/storage/test-ref/buckets/manuals/upload", {
      method: "POST",
      body: formData,
    });
    expect(unauthenticated.status).toBe(401);

    const authorizedFormData = new FormData();
    authorizedFormData.append("file", new Blob([], { type: "text/plain" }), "empty.txt");
    authorizedFormData.append("path", "nested/empty.txt");

    const res = await request("/v1/storage/test-ref/buckets/manuals/upload", {
      method: "POST",
      body: authorizedFormData,
      headers: { Authorization: "Bearer dev-master-token" },
    });

    expect(res.status).toBe(200);
    expect(uploadSpy).toHaveBeenCalled();
    const [projectRef, bucket, objectPath, fileData, mimeType] = uploadSpy.mock.calls.at(-1)!;
    expect(projectRef).toBe("test-ref");
    expect(bucket).toBe("manuals");
    expect(objectPath).toBe("nested/empty.txt");
    expect(fileData).toBeTruthy();
    expect(String(mimeType)).toContain("text/plain");
    uploadSpy.mockRestore();
  });

  test("storage migration endpoints require admin auth", async () => {
    const migrateSpy = spyOn(StorageService, "startMigration").mockResolvedValue({ jobId: "job_1" });

    const unauthenticated = await request("/v1/storage/migrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        s3Url: "s3://bucket",
        credentials: { access_key: "ak", secret_key: "sk", endpoint: "https://s3.example.com" },
      }),
    });
    expect(unauthenticated.status).toBe(401);

    const authorized = await request("/v1/storage/migrate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer dev-master-token" },
      body: JSON.stringify({
        s3Url: "s3://bucket",
        credentials: { access_key: "ak", secret_key: "sk", endpoint: "https://s3.example.com" },
      }),
    });
    expect(authorized.status).toBe(200);
    expect(migrateSpy).toHaveBeenCalledTimes(1);
    migrateSpy.mockRestore();
  });

  test("enhanced image transform requires auth for private buckets", async () => {
    const bucketSpy = spyOn(StorageRLS, "getLogicalBucket").mockResolvedValue({
      id: "private",
      name: "private",
      public: false,
    });

    const res = await request("/v1/storage/proj_1/transform/thumbnail/private/secret.png");
    expect(res.status).toBe(401);
    bucketSpy.mockRestore();
  });
});
