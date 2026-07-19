import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { frontendRoutes } from "../../src/routes/frontend";
import { frontendService } from "../../src/services/frontend.service";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("Frontend deployment upload routes", () => {
  let app: Elysia;
  let testZipBytes: Uint8Array;
  let tempZipPath: string;

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
  });

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
});
