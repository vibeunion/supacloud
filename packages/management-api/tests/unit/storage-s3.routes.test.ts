import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

// --- Mocks ---------------------------------------------------------------

const mockListBuckets = mock(() => Promise.resolve([]));
const mockCreateBucket = mock(() => Promise.resolve({ success: true }));
const mockListFiles = mock(() => Promise.resolve([]));
const mockUploadFile = mock(() => Promise.resolve(true));
const mockDeleteFile = mock(() => Promise.resolve(true));
const mockDeleteBucket = mock(() => Promise.resolve({ success: true }));
const mockGetDownloadResponse = mock(() => Promise.resolve(null));

const mockFindByRef = mock(() => Promise.resolve(null));
const mockUpdateConfig = mock(() => Promise.resolve(null));

const { StorageService } = await import("../../src/services/storage.service");
const { projectRepository } = await import("../../src/repositories/project.repository");
const authModule = await import("../../src/middleware/auth");

// Mock getAuthContext so /credentials tests don't need a real database.
const mockGetAuthContext = mock(() => Promise.resolve({ role: "master" as const }));
const getAuthContextSpy = spyOn(authModule, "getAuthContext").mockImplementation(mockGetAuthContext as never);

const storageSpies = [
  spyOn(StorageService, "listBuckets").mockImplementation(mockListBuckets as never),
  spyOn(StorageService, "createBucket").mockImplementation(mockCreateBucket as never),
  spyOn(StorageService, "listFiles").mockImplementation(mockListFiles as never),
  spyOn(StorageService, "uploadFile").mockImplementation(mockUploadFile as never),
  spyOn(StorageService, "deleteFile").mockImplementation(mockDeleteFile as never),
  spyOn(StorageService, "deleteBucket").mockImplementation(mockDeleteBucket as never),
  spyOn(StorageService, "getDownloadResponse").mockImplementation(mockGetDownloadResponse as never),
];

const findByRefSpy = spyOn(projectRepository, "findByRef").mockImplementation(mockFindByRef as never);
const updateConfigSpy = spyOn(projectRepository, "updateConfig").mockImplementation(mockUpdateConfig as never);

const { storageS3Routes } = await import("../../src/routes/storage-s3");
const { storageRoutes } = await import("../../src/routes/storage");
const app = new Elysia().use(storageS3Routes);
const combinedStorageApp = new Elysia().use(storageS3Routes).use(storageRoutes);

// Helper: build an authenticated request.
function authedRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        authorization: "Bearer test-service-key",
        ...(init.headers || {}),
      },
    }),
  );
}

// Helper: build an unauthenticated request.
function anonRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, init));
}

// Top-level lifecycle hooks so they apply to ALL describe blocks.
afterAll(() => {
  storageSpies.forEach((s) => s.mockRestore());
  findByRefSpy.mockRestore();
  updateConfigSpy.mockRestore();
  getAuthContextSpy.mockRestore();
});

beforeEach(() => {
  mockListBuckets.mockReset();
  mockCreateBucket.mockReset();
  mockListFiles.mockReset();
  mockUploadFile.mockReset();
  mockDeleteFile.mockReset();
  mockDeleteBucket.mockReset();
  mockGetDownloadResponse.mockReset();
  mockFindByRef.mockReset();
  mockUpdateConfig.mockReset();
  mockGetAuthContext.mockReset();
  mockGetAuthContext.mockResolvedValue({ role: "master" as const });
  // Default: project exists with S3 credentials and a service_role_key.
  // The S3 bearer auth now checks project.service_role_key directly.
  mockFindByRef.mockResolvedValue({
    ref: "testproj",
    service_role_key: "test-service-key",
    config: { s3_credentials: { access_key: "supac_testproj_abc123", secret_key: "secretkey123" } },
  } as never);
});

describe("storageS3Routes", () => {

  // --- Auth ---------------------------------------------------------------

  test("rejects requests without credentials (403)", async () => {
    const res = await anonRequest("/v1/storage/testproj/s3/");
    expect(res.status).toBe(403);
    const xml = await res.text();
    expect(xml).toContain("AccessDenied");
  });

  test("rejects requests when service_role_key does not match (403)", async () => {
    mockFindByRef.mockResolvedValue({
      ref: "testproj",
      service_role_key: "different-key",
      config: {},
    } as never);
    const res = await authedRequest("/v1/storage/testproj/s3/");
    expect(res.status).toBe(403);
  });

  // --- ListBuckets --------------------------------------------------------

  test("GET / returns ListBuckets XML", async () => {
    mockListBuckets.mockResolvedValue([
      { name: "bucket-a" },
      { name: "bucket-b" },
    ]);
    const res = await authedRequest("/v1/storage/testproj/s3/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml");
    const xml = await res.text();
    expect(xml).toContain("ListAllMyBucketsResult");
    expect(xml).toContain("bucket-a");
    expect(xml).toContain("bucket-b");
  });

  // --- CreateBucket -------------------------------------------------------

  test("PUT /:bucket creates a bucket (200)", async () => {
    mockCreateBucket.mockResolvedValue({ success: true });
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket", {
      method: "PUT",
    });
    expect(res.status).toBe(200);
    expect(mockCreateBucket).toHaveBeenCalledWith("testproj", "mybucket");
  });

  test("PUT /:bucket returns 409 on conflict", async () => {
    mockCreateBucket.mockResolvedValue({ success: false, error: "exists" });
    const res = await authedRequest("/v1/storage/testproj/s3/dup", {
      method: "PUT",
    });
    expect(res.status).toBe(409);
    const xml = await res.text();
    expect(xml).toContain("BucketAlreadyExists");
  });

  // --- ListObjects --------------------------------------------------------

  test("GET /:bucket returns ListObjects XML", async () => {
    mockListFiles.mockResolvedValue([
      { name: "file1.txt", size: 100 },
      { name: "file2.txt", size: 200 },
    ]);
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml");
    const xml = await res.text();
    expect(xml).toContain("ListBucketResult");
    expect(xml).toContain("file1.txt");
    expect(xml).toContain("file2.txt");
  });

  test("GET /:bucket returns NoSuchBucket (404) on error", async () => {
    mockListFiles.mockRejectedValue(new Error("no bucket"));
    const res = await authedRequest("/v1/storage/testproj/s3/missing");
    expect(res.status).toBe(404);
    const xml = await res.text();
    expect(xml).toContain("NoSuchBucket");
  });

  // --- DeleteBucket -------------------------------------------------------

  test("DELETE /:bucket deletes and returns 204 when empty", async () => {
    mockListFiles.mockResolvedValue([]);
    mockDeleteBucket.mockResolvedValue({ success: true });
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(mockDeleteBucket).toHaveBeenCalledWith("testproj", "mybucket");
  });

  test("DELETE /:bucket returns InternalError when delete fails", async () => {
    mockListFiles.mockResolvedValue([]);
    mockDeleteBucket.mockResolvedValue({ success: false, error: "driver error" });
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket", {
      method: "DELETE",
    });
    expect(res.status).toBe(500);
    const xml = await res.text();
    expect(xml).toContain("InternalError");
  });

  test("DELETE /:bucket returns BucketNotEmpty (409)", async () => {
    mockListFiles.mockResolvedValue([{ name: "file1.txt", size: 100 }]);
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket", {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    const xml = await res.text();
    expect(xml).toContain("BucketNotEmpty");
  });

  // --- PutObject ----------------------------------------------------------

  test("PUT /:bucket/* stores object (200 + ETag)", async () => {
    mockUploadFile.mockResolvedValue(true);
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket/path/to/file.txt", {
      method: "PUT",
      body: "hello world",
      headers: { "content-type": "text/plain" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
    expect(mockUploadFile).toHaveBeenCalledWith(
      "testproj",
      "mybucket",
      "path/to/file.txt",
      expect.anything(),
      "text/plain",
    );
  });

  test("S3 routes take precedence when generic storage routes are registered too", async () => {
    mockUploadFile.mockResolvedValue(true);
    const res = await combinedStorageApp.handle(
      new Request("http://localhost/v1/storage/testproj/s3/mybucket/path/to/file.txt", {
        method: "PUT",
        body: "hello world",
        headers: {
          authorization: "Bearer test-service-key",
          "content-type": "text/plain",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(mockUploadFile).toHaveBeenCalledWith(
      "testproj",
      "mybucket",
      "path/to/file.txt",
      expect.anything(),
      "text/plain",
    );
  });

  test("PUT /:bucket/* returns InternalError (500) on failure", async () => {
    mockUploadFile.mockResolvedValue(false);
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket/file.txt", {
      method: "PUT",
      body: "hello",
    });
    expect(res.status).toBe(500);
    const xml = await res.text();
    expect(xml).toContain("InternalError");
  });

  // --- GetObject ----------------------------------------------------------

  test("GET /:bucket/* returns object (200)", async () => {
    mockGetDownloadResponse.mockResolvedValue(
      new Response("file content", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket/file.txt");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("file content");
  });

  test("GET /:bucket/* returns NoSuchKey (404) when not found", async () => {
    mockGetDownloadResponse.mockResolvedValue(null);
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket/missing.txt");
    expect(res.status).toBe(404);
    const xml = await res.text();
    expect(xml).toContain("NoSuchKey");
  });

  // --- HeadObject ---------------------------------------------------------

  test("HEAD /:bucket/* returns 200 with metadata when object exists", async () => {
    mockGetDownloadResponse.mockResolvedValue(
      new Response("content", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "7" },
      }),
    );
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket/file.txt", {
      method: "HEAD",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  test("HEAD /:bucket/* returns 404 when object does not exist", async () => {
    mockGetDownloadResponse.mockResolvedValue(null);
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket/missing.txt", {
      method: "HEAD",
    });
    expect(res.status).toBe(404);
  });

  // --- DeleteObject -------------------------------------------------------

  test("DELETE /:bucket/* deletes object (204)", async () => {
    mockDeleteFile.mockResolvedValue(true);
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket/file.txt", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(mockDeleteFile).toHaveBeenCalledWith("testproj", "mybucket", "file.txt");
  });

  test("DELETE /:bucket/* returns InternalError (500) on failure", async () => {
    mockDeleteFile.mockResolvedValue(false);
    const res = await authedRequest("/v1/storage/testproj/s3/mybucket/file.txt", {
      method: "DELETE",
    });
    expect(res.status).toBe(500);
  });
});

// --- SigV4 auth tests ----------------------------------------------------

describe("storageS3Routes SigV4 auth", () => {
  test("GET /credentials provisions and returns S3 credentials", async () => {
    // Simulate project without pre-existing s3_credentials (auto-provision)
    mockFindByRef.mockResolvedValue({ ref: "testproj", service_role_key: "test-service-key", config: {} } as never);

    const res = await authedRequest("/v1/storage/testproj/s3/credentials");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project_ref).toBe("testproj");
    expect(body.access_key).toMatch(/^supac_testproj_/);
    expect(body.secret_key).toBeTruthy();
    expect(body.secret_key.length).toBeGreaterThanOrEqual(32);
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
  });

  test("GET /credentials returns existing credentials without re-provisioning", async () => {
    mockFindByRef.mockResolvedValue({
      ref: "testproj",
      service_role_key: "test-service-key",
      config: { s3_credentials: { access_key: "existing_key", secret_key: "existing_secret" } },
    } as never);

    const res = await authedRequest("/v1/storage/testproj/s3/credentials");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_key).toBe("existing_key");
    expect(body.secret_key).toBe("existing_secret");
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  test("GET /credentials allows master auth before S3 service key auth", async () => {
    mockGetAuthContext.mockResolvedValue({ role: "master" as const });
    mockFindByRef.mockResolvedValue({
      ref: "testproj",
      service_role_key: "different-service-key",
      config: { s3_credentials: { access_key: "existing_key", secret_key: "existing_secret" } },
    } as never);

    const res = await app.handle(
      new Request("http://localhost/v1/storage/testproj/s3/credentials", {
        headers: { authorization: "Bearer platform-master-token" },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_key).toBe("existing_key");
  });

  test("GET /credentials rejects project token scoped to a different ref", async () => {
    mockGetAuthContext.mockResolvedValue({ role: "project", ref: "otherproj" });
    const res = await authedRequest("/v1/storage/testproj/s3/credentials");
    expect(res.status).toBe(403);
  });
});
