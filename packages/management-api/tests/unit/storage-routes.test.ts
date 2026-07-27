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
  test("Studio bucket creation requires auth and creates the requested bucket", async () => {
    const createBucketSpy = spyOn(StorageService, "createBucket").mockResolvedValue({ success: true });

    try {
      const createRequest = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "studio-assets", public: false, file_size_limit: 1024 }),
      };
      const unauthenticated = await request("/v1/storage/test-ref/buckets", createRequest);
      expect(unauthenticated.status).toBe(401);

      const authorized = await request("/v1/storage/test-ref/buckets", {
        ...createRequest,
        headers: { ...createRequest.headers, Authorization: "Bearer dev-master-token" },
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toEqual({ id: "studio-assets", name: "studio-assets", public: false });
      expect(createBucketSpy).toHaveBeenCalledWith("test-ref", "studio-assets");
    } finally {
      createBucketSpy.mockRestore();
    }
  });

  test("Studio bucket creation preserves storage failures", async () => {
    const createBucketSpy = spyOn(StorageService, "createBucket").mockResolvedValue({
      success: false,
      error: "storage unavailable",
    });

    try {
      const response = await request("/v1/storage/test-ref/buckets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer dev-master-token" },
        body: JSON.stringify({ name: "studio-assets" }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ message: "storage unavailable", code: "500" });
    } finally {
      createBucketSpy.mockRestore();
    }
  });

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

  test("management file endpoint proxies authenticated downloads", async () => {
    const downloadSpy = spyOn(StorageService, "getDownloadResponse").mockResolvedValue(
      new Response("preview", { headers: { "content-type": "text/plain" } }),
    );

    try {
      const unauthenticated = await request("/v1/storage/test-ref/buckets/manuals/files/content?path=readme.txt");
      expect(unauthenticated.status).toBe(401);

      const authorized = await request("/v1/storage/test-ref/buckets/manuals/files/content?path=folder%2Freadme.txt", {
        headers: { Authorization: "Bearer dev-master-token" },
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.text()).toBe("preview");
      expect(downloadSpy).toHaveBeenCalledWith("test-ref", "manuals", "folder/readme.txt");

      const invalidPath = await request("/v1/storage/test-ref/buckets/manuals/files/content?path=..%2Fsecret.txt", {
        headers: { Authorization: "Bearer dev-master-token" },
      });
      expect(invalidPath.status).toBe(400);
    } finally {
      downloadSpy.mockRestore();
    }
  });

  test("management public URL is available only for public buckets", async () => {
    const bucketSpy = spyOn(StorageRLS, "getLogicalBucket").mockImplementation(
      async (_ref, bucketId) => ({ id: bucketId, name: bucketId, public: bucketId === "assets" }),
    );

    try {
      const publicResponse = await request("/v1/storage/test-ref/buckets/assets/files/public-url?path=folder%2Flogo%20image.svg", {
        headers: { Authorization: "Bearer dev-master-token", "x-forwarded-proto": "https" },
      });
      expect(publicResponse.status).toBe(200);
      expect(await publicResponse.json()).toEqual({
        public_url: "https://test-ref.api.example.com/storage/v1/object/public/assets/folder/logo%20image.svg",
      });

      const privateResponse = await request("/v1/storage/test-ref/buckets/private/files/public-url?path=secret.txt", {
        headers: { Authorization: "Bearer dev-master-token" },
      });
      expect(privateResponse.status).toBe(409);
    } finally {
      bucketSpy.mockRestore();
    }
  });

  test("management delete endpoint preserves nested object paths", async () => {
    const deleteSpy = spyOn(StorageService, "deleteFile").mockResolvedValue(true);

    try {
      const unauthenticated = await request("/v1/storage/test-ref/buckets/manuals/files/content?path=old.txt", {
        method: "DELETE",
      });
      expect(unauthenticated.status).toBe(401);

      const response = await request("/v1/storage/test-ref/buckets/manuals/files/content?path=folder%2Fold%20file.txt", {
        method: "DELETE",
        headers: { Authorization: "Bearer dev-master-token" },
      });
      expect(response.status).toBe(200);
      expect(deleteSpy).toHaveBeenCalledWith("test-ref", "manuals", "folder/old file.txt");
    } finally {
      deleteSpy.mockRestore();
    }
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
