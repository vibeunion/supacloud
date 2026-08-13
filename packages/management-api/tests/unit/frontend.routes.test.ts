import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { frontendService } from "../../src/services/frontend.service";
import {
  FrontendReleaseError,
  frontendReleaseService,
} from "../../src/services/frontend-release.service";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const requireProjectOrAdminAuth = mock(() => Promise.resolve(null));
const authModule = await import("../../src/middleware/auth");
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const { frontendRoutes } = await import("../../src/routes/frontend");

describe("Frontend deployment upload routes", () => {
  let app: Elysia;
  let testZipBytes: Uint8Array;
  let tempZipPath: string;

  afterAll(() => {
    requireProjectOrAdminAuthSpy.mockRestore();
  });

  beforeAll(async () => {
    app = new Elysia().use(frontendRoutes);

    // 动态生成一个合法但极小的 zip 二进制，用于完整的 unzip 验证测试
    const tempDir = path.join(tmpdir(), "supacloud-test-zip-");
    const testFile = path.join(tempDir, "index.html");
    tempZipPath = path.join(tempDir, "test.zip");

    await Bun.$`mkdir -p ${tempDir}`;
    await writeFile(testFile, "<h1>Hello</h1>");
    await Bun.$`cd ${tempDir} && zip -q test.zip index.html`;

    testZipBytes = new Uint8Array(await Bun.file(tempZipPath).arrayBuffer());

    // 清理临时目录
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(null);

    // Mock getDeployment 保证存在该部署
    spyOn(frontendService, "getDeployment").mockImplementation(async (ref, id) => {
      return {
        id,
        project_ref: ref,
        name: "test-site",
        framework: "static",
        domain: "test.example.com",
        custom_domains: [],
        status: "pending",
      } as any;
    });

    // Mock deployFromSource 避免启动真实的构建发布逻辑
    spyOn(frontendService, "deployFromSource").mockImplementation(async (ref, id, sourceDir) => {
      return {
        success: true,
        deployment_id: id,
        url: "https://test.example.com",
        build_log: "Success mock",
        message: "Deployed successfully",
      };
    });
    spyOn(frontendReleaseService, "assertMutationSupported").mockResolvedValue();
  });

  function mockImmutableUpload(releaseId: string) {
    const written: Uint8Array[] = [];
    const staged = Object.freeze({ size_bytes: testZipBytes.byteLength, sha256: releaseId });
    const upload = {
      write: mock(async (chunk: Uint8Array) => { written.push(chunk.slice()); }),
      finish: mock(async (expected: string) => {
        if (expected !== releaseId) {
          throw new FrontendReleaseError("FRONTEND_RELEASE_SHA_MISMATCH", 400, "digest mismatch");
        }
        return staged;
      }),
      abort: mock(async () => undefined),
    };
    const prepare = spyOn(frontendReleaseService, "prepareReleaseUpload").mockResolvedValue(upload);
    return { written, staged, upload, prepare };
  }

  test("supports direct raw binary uploads (application/zip)", async () => {
    const req = new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/deploy/upload",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(testZipBytes.byteLength),
        },
        body: testZipBytes,
      }
    );

    const res = await app.handle(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.deployment_id).toBe("dep123");
  });

  test("passes the SvelteKit readiness path through create and update APIs", async () => {
    const createDeployment = spyOn(frontendService, "createDeployment").mockImplementation(
      async (ref, input) => ({
        id: "dep-sveltekit",
        project_ref: ref,
        name: input.name,
        framework: input.framework,
        domain: "sveltekit.example.com",
        custom_domains: [],
        build_command: "npm run build",
        output_dir: "build",
        install_command: "npm install",
        node_version: "20",
        health_check_path: input.health_check_path,
        env_vars: {},
        status: "pending",
        created_at: "2026-07-19T00:00:00.000Z",
        updated_at: "2026-07-19T00:00:00.000Z",
        deployment_url: "https://sveltekit.example.com",
      }),
    );
    const updateDeployment = spyOn(frontendService, "updateDeployment").mockImplementation(
      async () => ({
        id: "dep-sveltekit",
        project_ref: "proj123",
        name: "sveltekit-app",
        framework: "sveltekit",
        domain: "sveltekit.example.com",
        custom_domains: [],
        build_command: "npm run build",
        output_dir: "build",
        install_command: "npm install",
        node_version: "20",
        health_check_path: "/ready",
        env_vars: {},
        status: "pending",
        created_at: "2026-07-19T00:00:00.000Z",
        updated_at: "2026-07-19T00:00:00.000Z",
        deployment_url: "https://sveltekit.example.com",
      }),
    );

    const createResponse = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "sveltekit-app",
          framework: "sveltekit",
          health_check_path: "/ready",
        }),
      },
    ));
    expect(createResponse.status).toBe(201);
    expect(createDeployment).toHaveBeenCalledWith(
      "proj123",
      expect.objectContaining({ health_check_path: "/ready" }),
    );

    const updateResponse = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep-sveltekit",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ health_check_path: "/ready" }),
      },
    ));
    expect(updateResponse.status).toBe(200);
    expect(updateDeployment).toHaveBeenCalledWith(
      "proj123",
      "dep-sveltekit",
      expect.objectContaining({ health_check_path: "/ready" }),
    );
  });

  test("supports multipart/form-data upload when parsed by Elysia (mocked body.file)", async () => {
    // 模拟 Elysia 已经内置解析为 body: { file: Blob } 的对象形式
    const mockFile = new Blob([testZipBytes], { type: "application/zip" });

    // 我们直接发起带有 Form 数据的请求，Elysia 默认应该解析它
    const form = new FormData();
    form.append("file", mockFile, "upload.zip");

    const req = new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/deploy/upload",
      {
        method: "POST",
        body: form,
      }
    );

    const res = await app.handle(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  test("gracefully handles invalid zip archive upload", async () => {
    const invalidBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const req = new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/deploy/upload",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
        },
        body: invalidBytes,
      }
    );

    const res = await app.handle(req);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.success).toBe(false);
    expect(data.message).toBe("Invalid zip archive");
  });

  test("denies the request when project authorization fails and skips the service", async () => {
    requireProjectOrAdminAuth.mockResolvedValue({
      status: 403,
      body: { error: "Missing capability: operations.manage" },
    });
    const createDeployment = spyOn(frontendService, "createDeployment");
    createDeployment.mockClear();

    const res = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "denied-site", framework: "static" }),
      },
    ));

    expect(res.status).toBe(403);
    expect(requireProjectOrAdminAuth).toHaveBeenCalledWith(expect.any(Request), "proj123");
    expect(createDeployment).not.toHaveBeenCalled();
  });

  test("routes immutable release inventory and upload through the release service", async () => {
    const releaseId = "a".repeat(64);
    const stream = mockImmutableUpload(releaseId);
    const listReleases = spyOn(frontendReleaseService, "listReleases").mockResolvedValue({
      project_ref: "proj123",
      deployment_id: "dep123",
      active_release_id: null,
      active_activation_id: null,
      releases: [],
      next_cursor: null,
    });
    const createRelease = spyOn(frontendReleaseService, "createRelease").mockResolvedValue({
      schema: "supacloud.frontend-release.v1",
      project_ref: "proj123",
      deployment_id: "dep123",
      release_id: releaseId,
      sha256: releaseId,
      tree_sha256: "b".repeat(64),
      size_bytes: testZipBytes.byteLength,
      file_count: 1,
      created_at: "2026-08-12T00:00:00.000Z",
      kind: "prebuilt_static",
    });
    const inventory = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
    ));
    expect(inventory.status).toBe(200);
    expect(listReleases).toHaveBeenCalledWith("proj123", "dep123", { limit: 50 });

    const upload = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(testZipBytes.byteLength),
          "x-supacloud-content-sha256": releaseId,
        },
        body: testZipBytes,
      },
    ));
    expect(upload.status).toBe(201);
    expect(createRelease).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(stream.written).equals(testZipBytes)).toBe(true);
    expect(stream.prepare).toHaveBeenCalledWith("proj123", "dep123", testZipBytes.byteLength);
    expect(createRelease.mock.calls[0]?.slice(0, 2)).toEqual(["proj123", "dep123"]);
    expect(createRelease.mock.calls[0]?.[2]).toBe(stream.staged);
    expect(stream.upload.finish).toHaveBeenCalledWith(releaseId);
    expect(stream.upload.abort).toHaveBeenCalledTimes(1);
  });

  test("gets one release and rejects non-raw or unbounded immutable uploads", async () => {
    const releaseId = "a".repeat(64);
    const release = {
      schema: "supacloud.frontend-release.v1" as const,
      project_ref: "proj123",
      deployment_id: "dep123",
      release_id: releaseId,
      sha256: releaseId,
      tree_sha256: "b".repeat(64),
      size_bytes: testZipBytes.byteLength,
      file_count: 1,
      created_at: "2026-08-12T00:00:00.000Z",
      kind: "prebuilt_static" as const,
    };
    const getRelease = spyOn(frontendReleaseService, "release").mockResolvedValue(release);
    const createRelease = spyOn(frontendReleaseService, "createRelease");
    createRelease.mockClear();

    const read = await app.handle(new Request(
      `http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases/${releaseId}`,
    ));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      project_ref: "proj123",
      deployment_id: "dep123",
      release,
    });
    expect(getRelease).toHaveBeenCalledWith("proj123", "dep123", releaseId);

    for (const headers of [
      { "Content-Type": "application/json", "Content-Length": "2" },
      { "Content-Type": "application/zip" },
    ]) {
      const response = await app.handle(new Request(
        "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
        { method: "POST", headers, body: new Uint8Array([1, 2]) },
      ));
      expect(response.status).toBe(headers["Content-Type"] === "application/json" ? 415 : 411);
    }
    expect(createRelease).not.toHaveBeenCalled();
  });

  test("rejects immutable upload before reading its body when storage mutations are unsupported", async () => {
    const preflight = spyOn(frontendReleaseService, "prepareReleaseUpload").mockRejectedValue(
      new (await import("../../src/services/frontend-release.service")).FrontendReleaseError(
        "FRONTEND_RELEASE_STORAGE_PLATFORM_UNSUPPORTED",
        503,
        "Immutable frontend release storage requires Linux directory binding",
      ),
    );
    const createRelease = spyOn(frontendReleaseService, "createRelease");
    createRelease.mockClear();
    let bodyReaderRequests = 0;
    const request = new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": "64",
          "x-supacloud-content-sha256": "a".repeat(64),
        },
        body: new Uint8Array(64),
      },
    );
    const requestBody = request.body!;
    const originalGetReader = requestBody.getReader.bind(requestBody);
    requestBody.getReader = ((...args: Parameters<typeof requestBody.getReader>) => {
      bodyReaderRequests += 1;
      return originalGetReader(...args);
    }) as typeof requestBody.getReader;

    const response = await app.handle(request);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "FRONTEND_RELEASE_STORAGE_PLATFORM_UNSUPPORTED",
      error: "Immutable frontend release storage requires Linux directory binding",
    });
    expect(preflight).toHaveBeenCalledWith("proj123", "dep123", 64);
    expect(createRelease).not.toHaveBeenCalled();
    expect(bodyReaderRequests).toBe(0);
  });

  test("bounds writes for a 100 MiB upload and always aborts the staging session", async () => {
    const byteLength = 100 * 1024 * 1024;
    const releaseId = "a".repeat(64);
    const sourceChunk = new Uint8Array(1024 * 1024);
    let sourceOffset = 0;
    let maximumWrite = 0;
    let totalWritten = 0;
    const startingRss = process.memoryUsage.rss();
    let peakRss = startingRss;
    const staged = Object.freeze({ size_bytes: byteLength, sha256: releaseId });
    const upload = {
      write: mock(async (chunk: Uint8Array) => {
        maximumWrite = Math.max(maximumWrite, chunk.byteLength);
        totalWritten += chunk.byteLength;
        peakRss = Math.max(peakRss, process.memoryUsage.rss());
      }),
      finish: mock(async () => staged),
      abort: mock(async () => undefined),
    };
    spyOn(frontendReleaseService, "prepareReleaseUpload").mockResolvedValue(upload);
    spyOn(frontendReleaseService, "createRelease").mockResolvedValue({
      schema: "supacloud.frontend-release.v1",
      project_ref: "proj123",
      deployment_id: "dep123",
      release_id: releaseId,
      sha256: releaseId,
      tree_sha256: releaseId,
      size_bytes: byteLength,
      file_count: 1,
      created_at: "2026-08-12T00:00:00.000Z",
      kind: "prebuilt_static",
    });
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
      {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "content-length": String(byteLength),
          "x-supacloud-content-sha256": releaseId,
        },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sourceOffset === byteLength) {
              controller.close();
              return;
            }
            controller.enqueue(sourceChunk);
            sourceOffset += sourceChunk.byteLength;
          },
        }),
      },
    ));

    expect(response.status).toBe(201);
    expect(totalWritten).toBe(byteLength);
    expect(maximumWrite).toBeLessThanOrEqual(64 * 1024);
    expect(peakRss - startingRss).toBeLessThan(64 * 1024 * 1024);
    expect(upload.abort).toHaveBeenCalledTimes(1);
  });

  for (const uploadCase of ["short", "long", "digest"] as const) {
    test(`aborts staged uploads after ${uploadCase} validation failure`, async () => {
      const createRelease = spyOn(frontendReleaseService, "createRelease");
      createRelease.mockClear();
      let written = 0;
      const upload = {
        write: mock(async (chunk: Uint8Array) => {
          written += chunk.byteLength;
          if (uploadCase === "long" && written > 2) {
            throw new FrontendReleaseError(
              "FRONTEND_RELEASE_CONTENT_LENGTH_MISMATCH",
              400,
              "length mismatch",
            );
          }
        }),
        finish: mock(async () => {
          throw new FrontendReleaseError(
            uploadCase === "digest" ? "FRONTEND_RELEASE_SHA_MISMATCH" : "FRONTEND_RELEASE_CONTENT_LENGTH_MISMATCH",
            400,
            "upload mismatch",
          );
        }),
        abort: mock(async () => undefined),
      };
      spyOn(frontendReleaseService, "prepareReleaseUpload").mockResolvedValue(upload);
      const body = uploadCase === "long" ? new Uint8Array([1, 2, 3]) : new Uint8Array([1]);
      const response = await app.handle(new Request(
        "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
        {
          method: "POST",
          headers: {
            "content-type": "application/zip",
            "content-length": "2",
            "x-supacloud-content-sha256": "a".repeat(64),
          },
          body,
        },
      ));
      expect(response.status).toBe(400);
      expect(upload.abort).toHaveBeenCalledTimes(1);
      expect(createRelease).not.toHaveBeenCalled();
    });
  }

  test("aborts staging when the request body stream fails", async () => {
    const upload = {
      write: mock(async () => undefined),
      finish: mock(async () => Object.freeze({ size_bytes: 2, sha256: "a".repeat(64) })),
      abort: mock(async () => undefined),
    };
    spyOn(frontendReleaseService, "prepareReleaseUpload").mockResolvedValue(upload);
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
      {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "content-length": "2",
          "x-supacloud-content-sha256": "a".repeat(64),
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.error(new Error("body interrupted"));
          },
        }),
      },
    ));
    expect(response.status).toBe(500);
    expect(upload.finish).not.toHaveBeenCalled();
    expect(upload.abort).toHaveBeenCalledTimes(1);
  });

  test("passes exact activation CAS fields and verified principal to the release service", async () => {
    const releaseId = "a".repeat(64);
    const mutationId = "00000000-0000-4000-8000-000000000001";
    const principal = { type: "project" as const, id: "project:proj123" };
    const principalSpy = spyOn(authModule, "getVerifiedRequestPrincipal").mockResolvedValue(principal);
    const activate = spyOn(frontendReleaseService, "activateRelease").mockResolvedValue({
      project_ref: "proj123",
      deployment_id: "dep123",
      active_release_id: releaseId,
      activation_id: mutationId,
      release: {
        schema: "supacloud.frontend-release.v1",
        project_ref: "proj123",
        deployment_id: "dep123",
        release_id: releaseId,
        sha256: releaseId,
        tree_sha256: "b".repeat(64),
        size_bytes: 1,
        file_count: 1,
        created_at: "2026-08-12T00:00:00.000Z",
        kind: "prebuilt_static",
      },
      mutation: { mutation_id: mutationId, status: "succeeded", replayed: false },
    });

    const response = await app.handle(new Request(
      `http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases/${releaseId}/activate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expected_active_release_id: "absent",
          expected_activation_id: "absent",
          mutation_id: mutationId,
        }),
      },
    ));
    expect(response.status).toBe(200);
    expect(activate).toHaveBeenCalledWith({
      projectRef: "proj123",
      deploymentId: "dep123",
      releaseId,
      expectedActiveReleaseId: "absent",
      expectedActivationId: "absent",
      mutationId,
      principal,
    });
    expect(JSON.stringify(await response.json())).not.toContain("authorization");
    principalSpy.mockRestore();
  });

  test("returns an explicit conflict instead of deleting an active immutable deployment", async () => {
    const deleteDeployment = spyOn(frontendService, "deleteDeployment").mockResolvedValue("active");
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123",
      { method: "DELETE" },
    ));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Immutable frontend release is active",
      code: "FRONTEND_RELEASE_ACTIVE",
    });
    expect(deleteDeployment).toHaveBeenCalledWith("proj123", "dep123");
  });
});
