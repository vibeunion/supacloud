import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import { storageCompatInternals, storageCompatRoutes } from "../../src/routes/storage-compat";
import { StorageRLS, mockBuckets, mockObjects } from "../../src/services/storage-rls";
import * as dbModule from "../../src/db";
import { StorageService } from "../../src/services/storage.service";
import { SignedStore, TusStore } from "../../src/services/storage-store";
import { storageVectorInternals } from "../../src/services/storage-vector.service";
import { createClient } from "@supabase/supabase-js";

const BASE = "http://localhost";

const testApp = new Elysia({ prefix: "/storage/v1" }).use(storageCompatRoutes);

function request(path: string, init?: RequestInit) {
  return testApp.handle(new Request(`${BASE}${path}`, init));
}

beforeEach(() => {
  mockBuckets.clear();
  mockObjects.clear();
  storageVectorInternals.resetMockStore();
  config.storageSigningSecret = "test-storage-signing-secret";

  spyOn(SignedStore, "set").mockResolvedValue(undefined);
  spyOn(SignedStore, "get").mockResolvedValue({ ref: "test_mock", bucket: "avatars", objectName: "signed.txt", upsert: false, expiresAt: 4000000000 });
  spyOn(SignedStore, "consume").mockResolvedValue({ ref: "test_mock", bucket: "avatars", objectName: "signed.txt", upsert: false, expiresAt: 4000000000 });
  spyOn(SignedStore, "delete").mockResolvedValue(undefined);
  spyOn(TusStore, "get").mockResolvedValue(null);
  spyOn(TusStore, "delete").mockResolvedValue(undefined);

  mockBuckets.set("avatars", {
    id: "avatars",
    name: "avatars",
    public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    file_size_limit: null,
    allowed_mime_types: null,
  });
});

afterEach(() => {
  mockBuckets.clear();
  mockObjects.clear();
});

describe("storageCompatRoutes supabase-js compatibility", () => {
  test("iceberg surfaces expose an explicit unavailable capability", async () => {
    const icebergRes = await request("/storage/v1/iceberg/tables", {
      headers: { "x-project-ref": "test_mock", apikey: "test-token" },
    });
    expect(icebergRes.status).toBe(501);
    expect(await icebergRes.json()).toMatchObject({
      feature: "storage_iceberg",
      capability: false,
      available: false,
      status: "unsupported",
      reason: "storage_iceberg_not_enabled",
    });
  });

  test("implements the Supabase Storage Vector API surface", async () => {
    const headers = {
      "x-project-ref": "test_mock",
      apikey: "test-token",
      authorization: "Bearer test-token",
      "content-type": "application/json",
    };
    const post = (operation: string, body: Record<string, unknown>) => request(`/storage/v1/vector/${operation}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    expect((await post("CreateVectorBucket", { vectorBucketName: "embeddings" })).status).toBe(200);
    expect(await (await post("ListVectorBuckets", {})).json()).toMatchObject({
      vectorBuckets: [{ vectorBucketName: "embeddings" }],
    });
    expect((await post("CreateIndex", {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      dataType: "float32",
      dimension: 3,
      distanceMetric: "cosine",
    })).status).toBe(200);
    expect((await post("PutVectors", {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      vectors: [
        { key: "a", data: { float32: [1, 0, 0] }, metadata: { kind: "docs" } },
        { key: "b", data: { float32: [0, 1, 0] }, metadata: { kind: "images" } },
      ],
    })).status).toBe(200);

    expect(await (await post("QueryVectors", {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      queryVector: { float32: [1, 0, 0] },
      topK: 1,
      returnDistance: true,
      returnMetadata: true,
    })).json()).toEqual({ vectors: [{ key: "a", distance: 0, metadata: { kind: "docs" } }] });
    expect(await (await post("GetVectors", {
      vectorBucketName: "embeddings",
      indexName: "documents-openai",
      keys: ["a"],
      returnData: true,
      returnMetadata: true,
    })).json()).toEqual({ vectors: [{ key: "a", data: { float32: [1, 0, 0] }, metadata: { kind: "docs" } }] });
  });

  test("works through the current official supabase-js vector client", async () => {
    const client = createClient(BASE, "test-token", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => testApp.handle(new Request(input, init)),
      },
    });

    expect((await client.storage.vectors.createBucket("embeddings")).error).toBeNull();
    const bucket = client.storage.vectors.from("embeddings");
    expect((await bucket.createIndex({
      indexName: "documents-openai",
      dataType: "float32",
      dimension: 3,
      distanceMetric: "cosine",
    })).error).toBeNull();

    const index = bucket.index("documents-openai");
    expect((await index.putVectors({
      vectors: [{ key: "doc-1", data: { float32: [1, 0, 0] }, metadata: { title: "One" } }],
    })).error).toBeNull();
    const query = await index.queryVectors({
      queryVector: { float32: [1, 0, 0] },
      topK: 1,
      returnDistance: true,
      returnMetadata: true,
    });
    expect(query.error).toBeNull();
    expect(query.data?.vectors).toEqual([{ key: "doc-1", distance: 0, metadata: { title: "One" } }]);
  });

  test("TUS capabilities advertise the default 500 MiB upload limit", async () => {
    const res = await request("/storage/v1/upload/resumable", {
      method: "OPTIONS",
      headers: {
        apikey: "test-token",
        "x-project-ref": "test_mock",
        origin: "https://app.example.com",
      },
    });

    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Tus-Version");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Tus-Extension");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Tus-Max-Size");
    expect(res.headers.get("Tus-Resumable")).toBe("1.0.0");
    expect(res.headers.get("Tus-Version")).toBe("1.0.0");
    expect(res.headers.get("Tus-Extension")).toBe("creation,termination");
    expect(res.headers.get("Tus-Max-Size")).toBe(String(500 * 1024 * 1024));
  });

  test("Storage CORS exposes ETag without dropping TUS headers", async () => {
    const res = await request("/storage/v1/object/public/avatars/public.txt", {
      method: "OPTIONS",
      headers: {
        apikey: "test-token",
        "x-project-ref": "test_mock",
        origin: "https://app.example.com",
      },
    });

    const exposedHeaderTokens = (res.headers.get("Access-Control-Expose-Headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase());
    expect(exposedHeaderTokens).toContain("etag");
    expect(exposedHeaderTokens).toContain("tus-resumable");
    expect(exposedHeaderTokens).toContain("tus-version");
    expect(exposedHeaderTokens).toContain("tus-extension");
    expect(exposedHeaderTokens).toContain("tus-max-size");
  });

  test("accepts project header on loopback health checks without apikey", async () => {
    const sqlSpy = spyOn(dbModule, "sql");
    sqlSpy.mockImplementation(async (...args: unknown[]) => {
      const text = String(args[0] ?? "");
      if (text.includes("FROM projects")) {
        return [{ ref: "proj_from_header", config: {} }];
      }
      return [];
    });

    const bucketSpy = spyOn(StorageRLS, "getLogicalBucket").mockResolvedValue({
      id: "avatars",
      name: "avatars",
      public: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const objectSpy = spyOn(StorageRLS, "getObjectInfo").mockResolvedValue({
      id: "obj_1",
      bucket_id: "avatars",
      name: "public.txt",
      metadata: { size: 3, mimetype: "text/plain" },
      cache_control: "3600",
      updated_at: new Date().toISOString(),
    });
    const downloadSpy = spyOn(StorageService, "getDownloadResponse").mockResolvedValue(
      new Response("ok\n", {
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": "3",
        },
      })
    );

    const res = await request("/storage/v1/object/public/avatars/public.txt", {
      headers: {
        host: "127.0.0.1:9090",
        "x-project-ref": "proj_from_header",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
    expect(downloadSpy).toHaveBeenCalledWith("proj_from_header", "avatars", "public.txt");
    sqlSpy.mockRestore();
    bucketSpy.mockRestore();
    objectSpy.mockRestore();
    downloadSpy.mockRestore();
  });

  test("allows public object reads from trusted custom-domain storage routes without apikey", async () => {
    const sqlSpy = spyOn(dbModule, "sql");
    let sawProjectLookup = false;
    sqlSpy.mockImplementation(async (...args: unknown[]) => {
      const text = String(args[0] ?? "");
      if (text.includes("FROM projects")) {
        sawProjectLookup = true;
        expect(text).not.toContain("config->>");
        return [{
          ref: "proj_from_header",
          config: '{"custom_domain":"api.example.com"}',
        }];
      }
      return [];
    });
    const bucketSpy = spyOn(StorageRLS, "getLogicalBucket").mockResolvedValue({
      id: "avatars",
      name: "avatars",
      public: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const objectSpy = spyOn(StorageRLS, "getObjectInfo").mockResolvedValue({
      id: "obj_1",
      bucket_id: "avatars",
      name: "public.txt",
      metadata: { size: 3, mimetype: "text/plain" },
      cache_control: "3600",
      updated_at: new Date().toISOString(),
    });
    const downloadSpy = spyOn(StorageService, "getDownloadResponse").mockResolvedValue(
      new Response("ok\n", {
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": "3",
        },
      })
    );

    const res = await request("/storage/v1/object/public/avatars/public.txt", {
      headers: {
        host: "api.example.com",
        "x-project-ref": "proj_from_header",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
    expect(downloadSpy).toHaveBeenCalledWith("proj_from_header", "avatars", "public.txt");
    expect(sawProjectLookup).toBe(true);
    sqlSpy.mockRestore();
    bucketSpy.mockRestore();
    objectSpy.mockRestore();
    downloadSpy.mockRestore();
  });

  test("allows API-key storage requests on configured api_domain under the base domain", async () => {
    const apiKeySpy = spyOn(storageCompatInternals, "resolveProjectRefFromApiKey").mockResolvedValue("proj_from_key");
    const sqlSpy = spyOn(dbModule, "sql");
    sqlSpy.mockImplementation(async (...args: unknown[]) => {
      const text = String(args[0] ?? "");
      if (text.includes("FROM projects")) {
        return [{
          ref: "proj_from_key",
          config: { api_domain: "api.example.com", custom_domain: "www.example.com" },
        }];
      }
      return [];
    });
    const bucketSpy = spyOn(StorageRLS, "getLogicalBucket").mockResolvedValue({
      id: "avatars",
      name: "avatars",
      public: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const objectSpy = spyOn(StorageRLS, "getObjectInfo").mockResolvedValue({
      id: "obj_1",
      bucket_id: "avatars",
      name: "public.txt",
      metadata: { size: 3, mimetype: "text/plain" },
      cache_control: "3600",
      updated_at: new Date().toISOString(),
    });
    const downloadSpy = spyOn(StorageService, "getDownloadResponse").mockResolvedValue(
      new Response("ok\n", {
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": "3",
        },
      })
    );

    const res = await request("/storage/v1/object/public/avatars/public.txt", {
      headers: {
        apikey: "anon-for-proj-from-key",
        host: "api.example.com",
        "x-project-ref": "proj_from_key",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
    expect(downloadSpy).toHaveBeenCalledWith("proj_from_key", "avatars", "public.txt");
    apiKeySpy.mockRestore();
    sqlSpy.mockRestore();
    bucketSpy.mockRestore();
    objectSpy.mockRestore();
    downloadSpy.mockRestore();
  });

  test("allows project-scoped storage requests while a new project is provisioning", async () => {
    const apiKey = "service-role-key-for-provisioning-project";
    const apiKeySpy = spyOn(storageCompatInternals, "resolveProjectRefFromApiKey").mockResolvedValue("provisioning_ref");

    const bucketSpy = spyOn(StorageRLS, "listLogicalBuckets").mockResolvedValue([]);

    const res = await request("/storage/v1/bucket", {
      headers: {
        apikey: apiKey,
        authorization: `Bearer ${apiKey}`,
        "x-project-ref": "provisioning_ref",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(apiKeySpy).toHaveBeenCalledWith(apiKey);
    expect(bucketSpy).toHaveBeenCalledWith("provisioning_ref", `Bearer ${apiKey}`, expect.any(Object));
    apiKeySpy.mockRestore();
    bucketSpy.mockRestore();
  });

  test("allows provisioning project refs from trusted loopback storage headers", async () => {
    const sqlSpy = spyOn(dbModule, "sql");
    let sawProvisioningStatuses = false;
    sqlSpy.mockImplementation(async (...args: unknown[]) => {
      const text = String(args[0] ?? "");
      if (text.includes("FROM projects")) {
        sawProvisioningStatuses = text.includes("lower(status) IN ('active', 'creating')");
        return [{ ref: "provisioning_header_ref", config: {} }];
      }
      return [];
    });

    const bucketSpy = spyOn(StorageRLS, "listLogicalBuckets").mockResolvedValue([]);

    const res = await request("/storage/v1/bucket", {
      headers: {
        host: "127.0.0.1:9090",
        "x-project-ref": "provisioning_header_ref",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(sawProvisioningStatuses).toBe(true);
    expect(bucketSpy).toHaveBeenCalledWith("provisioning_header_ref", undefined, expect.any(Object));
    sqlSpy.mockRestore();
    bucketSpy.mockRestore();
  });

  test("public downloads prefer stored object mimetype when backend returns octet-stream", async () => {
    mockObjects.set("avatars/folder/cat.png", {
      metadata: { size: 3, mimetype: "image/png" },
      updated: new Date().toISOString(),
    });

    const downloadSpy = spyOn(StorageService, "getDownloadResponse").mockResolvedValue(
      new Response("png", {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "3",
        },
      })
    );

    const res = await request("/storage/v1/object/public/avatars/folder/cat.png", {
      headers: { apikey: "test-token" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("png");
    downloadSpy.mockRestore();
  });

  test("rejects mismatched project header and apikey", async () => {
    const apiKeySpy = spyOn(storageCompatInternals, "resolveProjectRefFromApiKey").mockResolvedValue("proj_from_key");

    const res = await request("/storage/v1/bucket", {
      headers: {
        apikey: "anon-from-other-project",
        "x-project-ref": "proj_from_header",
      },
    });

    expect(res.status).toBe(400);
    apiKeySpy.mockRestore();
  });

  test("rejects mismatched host tenant and apikey", async () => {
    const apiKeySpy = spyOn(storageCompatInternals, "resolveProjectRefFromApiKey").mockResolvedValue("proj_from_key");

    const res = await request("/storage/v1/bucket", {
      headers: {
        apikey: "anon-from-other-project",
        host: "proj_from_host.api.example.com",
      },
    });

    expect(res.status).toBe(400);
    apiKeySpy.mockRestore();
  });

  test("createSignedUrl returns an SDK-relative path and signed download works", async () => {
    mockObjects.set("avatars/folder/cat.png", {
      metadata: { size: 3, mimetype: "image/png" },
      updated: new Date().toISOString(),
    });

    const downloadSpy = spyOn(StorageService, "getDownloadResponse").mockResolvedValue(
      new Response("png", {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "3",
        },
      })
    );

    const signRes = await request("/storage/v1/object/sign/avatars/folder/cat.png", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 60 }),
    });

    expect(signRes.status).toBe(200);
    const signed = await signRes.json();
    expect(signed.signedURL).toStartWith("/object/sign/avatars/folder/cat.png?");
    expect(signed.signedURL).not.toContain("/storage/v1/object/sign");

    const fileRes = await request(`/storage/v1${signed.signedURL}`, {
      headers: { apikey: "test-token" },
    });

    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("content-type")).toBe("image/png");
    expect(await fileRes.text()).toBe("png");
    downloadSpy.mockRestore();
  });

  test("image transforms use stored mimetype when backend returns octet-stream", async () => {
    mockObjects.set("avatars/folder/cat.png", {
      metadata: { size: 3, mimetype: "image/png" },
      updated: new Date().toISOString(),
    });

    const downloadSpy = spyOn(StorageService, "getDownloadResponse").mockResolvedValue(
      new Response("png", {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "3",
        },
      })
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("webp", {
        headers: {
          "Content-Type": "image/webp",
        },
      })
    );

    const res = await request("/storage/v1/render/image/public/avatars/folder/cat.png?width=64", {
      headers: { apikey: "test-token" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toEqual(expect.objectContaining({ "Content-Type": "image/png" }));
    expect(await res.text()).toBe("webp");
    fetchSpy.mockRestore();
    downloadSpy.mockRestore();
  });

  test("signed transform url keeps advanced imaginary options", async () => {
    mockObjects.set("avatars/folder/hero.png", {
      metadata: { size: 3, mimetype: "image/png" },
      updated: new Date().toISOString(),
    });

    const res = await request("/storage/v1/object/sign/avatars/folder/hero.png", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expiresIn: 60,
        transform: {
          width: 256,
          height: 256,
          smartcrop: true,
          watermark: "ACME",
          blur: 4,
          wm_opacity: 0.4,
        },
      }),
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.signedURL).toContain("/render/image/sign/avatars/folder/hero.png?");
    expect(payload.signedURL).toContain("smartcrop=true");
    expect(payload.signedURL).toContain("watermark=ACME");
    expect(payload.signedURL).toContain("blur=4");
    expect(payload.signedURL).toContain("wm_opacity=0.4");
  });

  test("signed upload flow matches createSignedUploadUrl + uploadToSignedUrl", async () => {
    const uploadSpy = spyOn(StorageService, "uploadFile").mockResolvedValue(true);

    const signRes = await request("/storage/v1/object/upload/sign/avatars/signed.txt", {
      method: "POST",
      headers: { apikey: "test-token" },
    });

    expect(signRes.status).toBe(200);
    const signed = await signRes.json();
    expect(signed.url).toStartWith("/object/upload/sign/avatars/signed.txt?token=");
    expect(signed.url).not.toContain("&t=");

    const uploadRes = await request(`/storage/v1${signed.url}`, {
      method: "PUT",
      headers: {
        apikey: "test-token",
        "content-type": "text/plain",
      },
      body: "hello world",
    });

    expect(uploadRes.status).toBe(200);
    expect(await uploadRes.json()).toEqual({ Key: "avatars/signed.txt" });
    expect(uploadSpy).toHaveBeenCalled();
    expect(SignedStore.consume).toHaveBeenCalled();
    uploadSpy.mockRestore();
  });

  test("signed upload token can only be consumed once", async () => {
    const signedUpload = { ref: "test_mock", bucket: "avatars", objectName: "signed.txt", upsert: false, expiresAt: 4000000000 };
    spyOn(SignedStore, "consume")
      .mockResolvedValueOnce(signedUpload)
      .mockResolvedValueOnce(null);
    const uploadSpy = spyOn(StorageService, "uploadFile").mockResolvedValue(true);

    const first = await request("/storage/v1/object/upload/sign/avatars/signed.txt?token=one-time", {
      method: "PUT",
      headers: {
        apikey: "test-token",
        "content-type": "text/plain",
      },
      body: "first",
    });
    const second = await request("/storage/v1/object/upload/sign/avatars/signed.txt?token=one-time", {
      method: "PUT",
      headers: {
        apikey: "test-token",
        "content-type": "text/plain",
      },
      body: "second",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    uploadSpy.mockRestore();
  });

  test("multipart zero-byte upload is accepted", async () => {
    const uploadSpy = spyOn(StorageService, "uploadFile").mockResolvedValue(true);
    const formData = new FormData();
    formData.append("file", new Blob([], { type: "text/plain" }), "empty.txt");

    const res = await request("/storage/v1/object/avatars/empty.txt", {
      method: "POST",
      headers: {
        apikey: "test-token",
      },
      body: formData,
    });

    expect(res.status).toBe(200);
    expect(uploadSpy).toHaveBeenCalled();
    uploadSpy.mockRestore();
  });

  test("raw object upload forwards a stream for non-multipart bodies", async () => {
    const uploadSpy = spyOn(StorageService, "uploadFile").mockResolvedValue(true);

    const res = await request("/storage/v1/object/avatars/raw.txt", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "text/plain",
        "content-length": "3",
      },
      body: "abc",
    });

    expect(res.status).toBe(200);
    expect(uploadSpy).toHaveBeenCalled();
    const streamArg = uploadSpy.mock.calls.at(-1)?.[3] as ReadableStream | undefined;
    expect(streamArg).toBeDefined();
    expect(typeof (streamArg as ReadableStream).getReader).toBe("function");
    uploadSpy.mockRestore();
  });

  test("duplicate upload without upsert is rejected", async () => {
    mockObjects.set("avatars/existing.txt", {
      metadata: { size: 5, mimetype: "text/plain" },
      updated: new Date().toISOString(),
    });

    const res = await request("/storage/v1/object/avatars/existing.txt", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "text/plain",
      },
      body: "hello",
    });

    expect(res.status).toBe(409);
  });

  test("raw object uploads stream body to storage instead of buffering", async () => {
    let streamedBody: unknown = null;
    const uploadSpy = spyOn(StorageService, "uploadFile").mockImplementation(async (_ref, _bucket, _key, data) => {
      streamedBody = data;
      return true;
    });

    const res = await request("/storage/v1/object/avatars/raw.bin", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "application/octet-stream",
        "content-length": "11",
      },
      body: "hello world",
      duplex: "half" as RequestDuplex,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ Id: "avatars/raw.bin", Key: "avatars/raw.bin" });
    expect(streamedBody).toBeDefined();
    expect(streamedBody instanceof ReadableStream).toBe(true);
    uploadSpy.mockRestore();
  });

  test("generic authenticated download path works for sdk download()", async () => {
    mockObjects.set("avatars/private.txt", {
      metadata: { size: 7, mimetype: "text/plain" },
      updated: new Date().toISOString(),
    });

    const downloadSpy = spyOn(StorageService, "getDownloadResponse").mockResolvedValue(
      new Response("private", {
        headers: {
          "Content-Type": "text/plain",
        },
      })
    );

    const res = await request("/storage/v1/object/avatars/private.txt", {
      headers: { apikey: "test-token" },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("private");
    downloadSpy.mockRestore();
  });

  test("list-v2 supports prefix filtering and search", async () => {
    mockObjects.set("avatars/folder/a.txt", {
      metadata: { size: 1, mimetype: "text/plain" },
      updated: "2024-01-01T00:00:00.000Z",
    });
    mockObjects.set("avatars/folder/b.txt", {
      metadata: { size: 2, mimetype: "text/plain" },
      updated: "2024-01-02T00:00:00.000Z",
    });
    mockObjects.set("avatars/other.txt", {
      metadata: { size: 3, mimetype: "text/plain" },
      updated: "2024-01-03T00:00:00.000Z",
    });

    const res = await request("/storage/v1/object/list-v2/avatars", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prefix: "folder/",
        search: "b",
        sortBy: { column: "name", order: "asc" },
      }),
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.nextCursor).toBeNull();
    expect(payload.objects).toHaveLength(1);
    expect(payload.objects[0].name).toBe("b.txt");
  });

  test("list responses preserve numeric metadata sizes and sanitize malformed sizes", async () => {
    mockObjects.set("avatars/good.txt", {
      metadata: { size: "5", mimetype: "text/plain" },
      updated: "2024-01-01T00:00:00.000Z",
    });
    mockObjects.set("avatars/bad.txt", {
      metadata: { size: "not-a-number", mimetype: "text/plain" },
      updated: "2024-01-02T00:00:00.000Z",
    });

    const objectInfo = await StorageRLS.getObjectInfo("test_mock", "avatars", "bad.txt", undefined);
    expect(objectInfo?.size).toBe(0);

    const res = await request("/storage/v1/object/list/avatars", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sortBy: { column: "name", order: "asc" } }),
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    const bad = payload.find((item: { name: string }) => item.name === "bad.txt");
    const good = payload.find((item: { name: string }) => item.name === "good.txt");

    expect(good?.metadata.size).toBe(5);
    expect(good?.metadata.contentLength).toBe(5);
    expect(bad?.metadata.size).toBe(0);
    expect(bad?.metadata.contentLength).toBe(0);
  });

  test("list endpoints normalize invalid pagination inputs", async () => {
    mockObjects.set("avatars/one.txt", {
      metadata: { size: 1, mimetype: "text/plain" },
      updated: "2024-01-01T00:00:00.000Z",
    });

    const listRes = await request("/storage/v1/object/list/avatars", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ limit: -5, offset: -10 }),
    });

    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toHaveLength(1);

    const listV2Res = await request("/storage/v1/object/list-v2/avatars", {
      method: "POST",
      headers: {
        apikey: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ limit: -5, offset: -10, cursor: Buffer.from("-9").toString("base64") }),
    });

    expect(listV2Res.status).toBe(200);
    const listV2Payload = await listV2Res.json();
    expect(listV2Payload.objects).toHaveLength(1);
    expect(listV2Payload.hasNext).toBe(false);
  });

  test("resumable upload appends streamed chunks without buffering the whole request", async () => {
    const uploadSpy = spyOn(StorageService, "uploadFile").mockResolvedValue(true);
    const setSpy = spyOn(TusStore, "set");
    const appendSpy = spyOn(TusStore, "appendChunk");
    const assembleSpy = spyOn(TusStore, "assembleToStream");

    let uploadState: any = null;
    let uploadId = "";
    setSpy.mockImplementation(async (id: string, upload: any) => {
      uploadId = id;
      uploadState = { ...upload };
    });
    (TusStore.get as any).mockImplementation(async (id: string) => id === uploadId && uploadState ? { ...uploadState } : null);
    appendSpy.mockImplementation(async (_id: string, expectedOffset: number, chunk: ReadableStream<Uint8Array>) => {
      expect(expectedOffset).toBe(0);
      expect(typeof chunk.getReader).toBe("function");
      const payload = await new Response(chunk).text();
      expect(payload).toBe("chunk");
      uploadState.offset = expectedOffset + payload.length;
      return uploadState.offset;
    });
    assembleSpy.mockResolvedValue({
      stream: new Response("chunk").body!,
      cleanup: async () => {},
    });

    const uploadMeta = [
      `bucketName ${Buffer.from("avatars").toString("base64")}`,
      `objectName ${Buffer.from("folder/resumable.bin").toString("base64")}`,
      `contentType ${Buffer.from("application/octet-stream").toString("base64")}`,
    ].join(",");

    const createRes = await request("/storage/v1/upload/resumable", {
      method: "POST",
      headers: {
        apikey: "test-token",
        authorization: "Bearer test-token",
        "upload-length": "5",
        "upload-metadata": uploadMeta,
      },
    });

    expect(createRes.status).toBe(201);
    const location = createRes.headers.get("Location");
    expect(location).toBeTruthy();

    const patchRes = await request(location!, {
      method: "PATCH",
      headers: {
        apikey: "test-token",
        authorization: "Bearer test-token",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
        "content-length": "5",
      },
      body: "chunk",
    });

    expect(patchRes.status).toBe(200);
    expect(appendSpy).toHaveBeenCalled();
    expect(uploadSpy).toHaveBeenCalled();
    setSpy.mockRestore();
    appendSpy.mockRestore();
    assembleSpy.mockRestore();
    uploadSpy.mockRestore();
  });
});
