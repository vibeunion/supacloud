// @supacloud-test-isolate
import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { projectStorageRoutes, storageRoutes } from "../../src/routes/storage";
import { StorageService } from "../../src/services/storage.service";
import { mockBuckets, StorageRLS } from "../../src/services/storage-rls";
import { storageVectorInternals } from "../../src/services/storage-vector.service";

const BASE = "http://localhost";
const app = new Elysia().use(storageRoutes).use(projectStorageRoutes);

function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`${BASE}${path}`, init));
}

describe("storage management routes", () => {
  test("Web Console can manage vector buckets through project-scoped routes", async () => {
    storageVectorInternals.resetMockStore();
    const headers = { "Content-Type": "application/json", Authorization: "Bearer dev-master-token" };

    const create = await request("/v1/projects/test_mock/storage/vector/CreateVectorBucket", {
      method: "POST",
      headers,
      body: JSON.stringify({ vectorBucketName: "embeddings" }),
    });
    expect(create.status).toBe(200);

    const list = await request("/v1/projects/test_mock/storage/vector/ListVectorBuckets", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      vectorBuckets: [{ vectorBucketName: "embeddings" }],
    });
  });

  test("Studio bucket creation requires auth and creates the requested bucket", async () => {
    const createBucketSpy = spyOn(StorageService, "createBucket").mockResolvedValue({ success: true });
    const registerBucketSpy = spyOn(StorageRLS, "createLogicalBucketAsAdmin").mockResolvedValue(true);

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
      expect(registerBucketSpy).toHaveBeenCalledWith("test-ref", {
        id: "studio-assets",
        name: "studio-assets",
        public: false,
        fileSizeLimit: 1024,
        allowedMimeTypes: undefined,
      });
    } finally {
      createBucketSpy.mockRestore();
      registerBucketSpy.mockRestore();
    }
  });

  test("Studio bucket creation persists public metadata without project JWT verification", async () => {
    const createBucketSpy = spyOn(StorageService, "createBucket").mockResolvedValue({ success: true });
    const registerBucketSpy = spyOn(StorageRLS, "createLogicalBucketAsAdmin").mockResolvedValue(true);
    const verifyTokenSpy = spyOn(StorageRLS, "verifyToken");

    try {
      const response = await request("/v1/projects/test-ref/storage/buckets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer dev-master-token" },
        body: JSON.stringify({
          name: "public-assets",
          public: true,
          file_size_limit: 1024,
          allowed_mime_types: ["image/png"],
        }),
      });
      expect(response.status).toBe(200);
      expect(registerBucketSpy).toHaveBeenCalledWith("test-ref", {
        id: "public-assets",
        name: "public-assets",
        public: true,
        fileSizeLimit: 1024,
        allowedMimeTypes: ["image/png"],
      });
      expect(verifyTokenSpy).not.toHaveBeenCalled();
    } finally {
      createBucketSpy.mockRestore();
      registerBucketSpy.mockRestore();
      verifyTokenSpy.mockRestore();
    }
  });

  test("Studio-created public buckets immediately expose public file URLs", async () => {
    mockBuckets.clear();
    const createBucketSpy = spyOn(StorageService, "createBucket").mockResolvedValue({ success: true });

    try {
      const createResponse = await request("/v1/storage/test_mock/buckets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer dev-master-token" },
        body: JSON.stringify({ name: "public-assets", public: true }),
      });
      expect(createResponse.status).toBe(200);

      const publicUrlResponse = await request(
        "/v1/storage/test_mock/buckets/public-assets/files/public-url?path=folder%2Flogo.svg",
        { headers: { Authorization: "Bearer dev-master-token", "x-forwarded-proto": "https" } },
      );
      expect(publicUrlResponse.status).toBe(200);
      expect(await publicUrlResponse.json()).toEqual({
        public_url: "https://test_mock.api.example.com/storage/v1/object/public/public-assets/folder/logo.svg",
      });
    } finally {
      createBucketSpy.mockRestore();
      mockBuckets.clear();
    }
  });

  test("Studio bucket creation does not overwrite an existing logical bucket", async () => {
    const createLogicalSpy = spyOn(StorageRLS, "createLogicalBucketAsAdmin").mockResolvedValue(false);
    const createPhysicalSpy = spyOn(StorageService, "createBucket").mockResolvedValue({ success: true });

    try {
      const response = await request("/v1/projects/test-ref/storage/buckets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer dev-master-token" },
        body: JSON.stringify({ name: "existing", public: false }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: "Bucket already exists", code: "409" });
      expect(createLogicalSpy).toHaveBeenCalled();
      expect(createPhysicalSpy).not.toHaveBeenCalled();
    } finally {
      createLogicalSpy.mockRestore();
      createPhysicalSpy.mockRestore();
    }
  });

  test("Studio bucket listing overlays logical metadata and keeps logical-only buckets", async () => {
    const listPhysicalSpy = spyOn(StorageService, "listBuckets").mockResolvedValue([
      { id: "public-assets", name: "public-assets", public: false, size: "-" },
      { id: "physical-only", name: "physical-only", public: false, size: "-" },
    ]);
    const listLogicalSpy = spyOn(StorageRLS, "listLogicalBucketsAsAdmin").mockResolvedValue([
      { id: "public-assets", name: "public-assets", public: true, file_size_limit: 1024 },
      { id: "logical-only", name: "logical-only", public: false },
    ]);

    try {
      const response = await request("/v1/projects/test-ref/storage/buckets", {
        headers: { Authorization: "Bearer dev-master-token" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        {
          id: "public-assets",
          name: "public-assets",
          public: true,
          size: "-",
          file_size_limit: 1024,
          allowed_mime_types: null,
        },
        {
          id: "physical-only",
          name: "physical-only",
          public: false,
          size: "-",
          file_size_limit: null,
          allowed_mime_types: null,
        },
        {
          id: "logical-only",
          name: "logical-only",
          public: false,
          file_size_limit: null,
          allowed_mime_types: null,
        },
      ]);
    } finally {
      listPhysicalSpy.mockRestore();
      listLogicalSpy.mockRestore();
    }
  });

  test.each([
    ["invalid project ref", "/v1/projects/bad.ref/storage/buckets", { name: "reports" }],
    ["dot-only bucket", "/v1/projects/test-ref/storage/buckets", { name: "..." }],
    ["negative file limit", "/v1/projects/test-ref/storage/buckets", { name: "reports", file_size_limit: -1 }],
    ["fractional file limit", "/v1/projects/test-ref/storage/buckets", { name: "reports", file_size_limit: 1.5 }],
    ["overflowing file limit", "/v1/projects/test-ref/storage/buckets", {
      name: "reports",
      file_size_limit: Number.MAX_SAFE_INTEGER + 1,
    }],
    ["empty MIME", "/v1/projects/test-ref/storage/buckets", { name: "reports", allowed_mime_types: [""] }],
    ["overlong MIME", "/v1/projects/test-ref/storage/buckets", {
      name: "reports",
      allowed_mime_types: [`text/${"a".repeat(251)}`],
    }],
    ["too many MIME types", "/v1/projects/test-ref/storage/buckets", {
      name: "reports",
      allowed_mime_types: Array.from({ length: 101 }, (_, index) => `application/x-${index}`),
    }],
  ])("rejects %s before bucket creation", async (_label, path, body) => {
    const createPhysicalSpy = spyOn(StorageService, "createBucket").mockResolvedValue({ success: true });
    const createLogicalSpy = spyOn(StorageRLS, "createLogicalBucketAsAdmin").mockResolvedValue(true);

    try {
      const response = await request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer dev-master-token" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(422);
      expect(createPhysicalSpy).not.toHaveBeenCalled();
      expect(createLogicalSpy).not.toHaveBeenCalled();
    } finally {
      createPhysicalSpy.mockRestore();
      createLogicalSpy.mockRestore();
    }
  });

  test("rejects an empty bucket update before Management dispatch", async () => {
    const updateBucketSpy = spyOn(StorageService, "updateBucket");
    try {
      const response = await request("/v1/projects/test-ref/storage/buckets/reports", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer dev-master-token" },
        body: "{}",
      });

      expect(response.status).toBe(422);
      expect(updateBucketSpy).not.toHaveBeenCalled();
    } finally {
      updateBucketSpy.mockRestore();
    }
  });

  test("accepts exact Storage contract upper boundaries", async () => {
    const createPhysicalSpy = spyOn(StorageService, "createBucket").mockResolvedValue({ success: true });
    const createLogicalSpy = spyOn(StorageRLS, "createLogicalBucketAsAdmin").mockResolvedValue(true);
    const allowedMimeTypes = Array.from({ length: 100 }, (_, index) => `application/x-${index}`);
    allowedMimeTypes[0] = `x/${"a".repeat(253)}`;
    const ref = "r".repeat(64);
    const bucket = "b".repeat(100);

    try {
      const response = await request(`/v1/projects/${ref}/storage/buckets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer dev-master-token" },
        body: JSON.stringify({
          name: bucket,
          file_size_limit: Number.MAX_SAFE_INTEGER,
          allowed_mime_types: allowedMimeTypes,
        }),
      });

      expect(response.status).toBe(200);
      expect(createPhysicalSpy).toHaveBeenCalledWith(ref, bucket);
      expect(createLogicalSpy).toHaveBeenCalledWith(ref, expect.objectContaining({
        id: bucket,
        fileSizeLimit: Number.MAX_SAFE_INTEGER,
        allowedMimeTypes,
      }));
    } finally {
      createPhysicalSpy.mockRestore();
      createLogicalSpy.mockRestore();
    }
  });

  test("legacy default bucket listing falls back to physical storage", async () => {
    const physicalBuckets = [{ id: "platform", name: "platform", public: false, size: "-" }];
    const listPhysicalSpy = spyOn(StorageService, "listBuckets").mockResolvedValue(physicalBuckets);
    const listLogicalSpy = spyOn(StorageRLS, "listLogicalBucketsAsAdmin");

    try {
      const response = await request("/v1/storage/default/buckets", {
        headers: { Authorization: "Bearer dev-master-token" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(physicalBuckets);
      expect(listLogicalSpy).not.toHaveBeenCalled();
    } finally {
      listPhysicalSpy.mockRestore();
      listLogicalSpy.mockRestore();
    }
  });

  test("Studio bucket deletion removes physical storage before logical metadata", async () => {
    const callOrder: string[] = [];
    const isBucketEmptySpy = spyOn(StorageService, "isBucketEmpty").mockImplementation(async () => {
      callOrder.push("physical-preflight");
      return true;
    });
    const assertDeletableSpy = spyOn(StorageRLS, "assertLogicalBucketDeletableAsAdmin").mockImplementation(async () => {
      callOrder.push("logical-preflight");
    });
    const deletePhysicalSpy = spyOn(StorageService, "deleteBucket").mockImplementation(async () => {
      callOrder.push("physical");
      return { success: true };
    });
    const deleteLogicalSpy = spyOn(StorageRLS, "deleteLogicalBucketAsAdmin").mockImplementation(async () => {
      callOrder.push("logical");
    });

    try {
      const response = await request("/v1/projects/test-ref/storage/buckets/public-assets", {
        method: "DELETE",
        headers: { Authorization: "Bearer dev-master-token" },
      });
      expect(response.status).toBe(200);
      expect(callOrder).toEqual(["physical-preflight", "logical-preflight", "physical", "logical"]);
      expect(deleteLogicalSpy).toHaveBeenCalledWith("test-ref", "public-assets");
    } finally {
      isBucketEmptySpy.mockRestore();
      deletePhysicalSpy.mockRestore();
      deleteLogicalSpy.mockRestore();
      assertDeletableSpy.mockRestore();
    }
  });

  test("Studio bucket deletion leaves physical data untouched when logical objects exist", async () => {
    const isBucketEmptySpy = spyOn(StorageService, "isBucketEmpty").mockResolvedValue(true);
    const assertDeletableSpy = spyOn(StorageRLS, "assertLogicalBucketDeletableAsAdmin").mockRejectedValue(
      new Error("Bucket is not empty"),
    );
    const deletePhysicalSpy = spyOn(StorageService, "deleteBucket").mockResolvedValue({ success: true });
    const deleteLogicalSpy = spyOn(StorageRLS, "deleteLogicalBucketAsAdmin").mockResolvedValue();

    try {
      const response = await request("/v1/projects/test-ref/storage/buckets/public-assets", {
        method: "DELETE",
        headers: { Authorization: "Bearer dev-master-token" },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: "Bucket is not empty", code: "409" });
      expect(deletePhysicalSpy).not.toHaveBeenCalled();
      expect(deleteLogicalSpy).not.toHaveBeenCalled();
    } finally {
      isBucketEmptySpy.mockRestore();
      assertDeletableSpy.mockRestore();
      deletePhysicalSpy.mockRestore();
      deleteLogicalSpy.mockRestore();
    }
  });

  test("Studio bucket deletion leaves physical data untouched when Studio files exist", async () => {
    const isBucketEmptySpy = spyOn(StorageService, "isBucketEmpty").mockResolvedValue(false);
    const assertDeletableSpy = spyOn(StorageRLS, "assertLogicalBucketDeletableAsAdmin").mockResolvedValue();
    const deletePhysicalSpy = spyOn(StorageService, "deleteBucket").mockResolvedValue({ success: true });
    const deleteLogicalSpy = spyOn(StorageRLS, "deleteLogicalBucketAsAdmin").mockResolvedValue();

    try {
      const response = await request("/v1/projects/test-ref/storage/buckets/public-assets", {
        method: "DELETE",
        headers: { Authorization: "Bearer dev-master-token" },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: "Bucket is not empty", code: "409" });
      expect(assertDeletableSpy).not.toHaveBeenCalled();
      expect(deletePhysicalSpy).not.toHaveBeenCalled();
      expect(deleteLogicalSpy).not.toHaveBeenCalled();
    } finally {
      isBucketEmptySpy.mockRestore();
      assertDeletableSpy.mockRestore();
      deletePhysicalSpy.mockRestore();
      deleteLogicalSpy.mockRestore();
    }
  });

  test("Studio bucket deletion fails closed when physical inspection fails", async () => {
    const isBucketEmptySpy = spyOn(StorageService, "isBucketEmpty").mockRejectedValue(
      new Error("storage unavailable"),
    );
    const assertDeletableSpy = spyOn(StorageRLS, "assertLogicalBucketDeletableAsAdmin").mockResolvedValue();
    const deletePhysicalSpy = spyOn(StorageService, "deleteBucket").mockResolvedValue({ success: true });
    const deleteLogicalSpy = spyOn(StorageRLS, "deleteLogicalBucketAsAdmin").mockResolvedValue();

    try {
      const response = await request("/v1/projects/test-ref/storage/buckets/public-assets", {
        method: "DELETE",
        headers: { Authorization: "Bearer dev-master-token" },
      });
      expect(response.status).toBe(500);
      expect(assertDeletableSpy).not.toHaveBeenCalled();
      expect(deletePhysicalSpy).not.toHaveBeenCalled();
      expect(deleteLogicalSpy).not.toHaveBeenCalled();
    } finally {
      isBucketEmptySpy.mockRestore();
      assertDeletableSpy.mockRestore();
      deletePhysicalSpy.mockRestore();
      deleteLogicalSpy.mockRestore();
    }
  });

  test("Studio bucket creation preserves storage failures", async () => {
    const registerBucketSpy = spyOn(StorageRLS, "createLogicalBucketAsAdmin").mockResolvedValue(true);
    const createBucketSpy = spyOn(StorageService, "createBucket").mockResolvedValue({
      success: false,
      error: "storage unavailable",
    });
    const rollbackSpy = spyOn(StorageRLS, "deleteLogicalBucketAsAdmin").mockResolvedValue();

    try {
      const response = await request("/v1/storage/test-ref/buckets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer dev-master-token" },
        body: JSON.stringify({ name: "studio-assets" }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ message: "storage unavailable", code: "500" });
      expect(rollbackSpy).toHaveBeenCalledWith("test-ref", "studio-assets");
    } finally {
      registerBucketSpy.mockRestore();
      createBucketSpy.mockRestore();
      rollbackSpy.mockRestore();
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
