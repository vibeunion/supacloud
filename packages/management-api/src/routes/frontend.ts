import { Elysia, t, status } from "elysia";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { frontendService } from "../services/frontend.service";
import type { FrontendFramework } from "../types/frontend";
import { FRAMEWORK_DEFAULTS } from "../types/frontend";

const FRONTEND_UPLOAD_MAX_BYTES = Number(process.env.FRONTEND_UPLOAD_MAX_BYTES || 100 * 1024 * 1024);
const FRONTEND_UPLOAD_MAX_FILES = Number(process.env.FRONTEND_UPLOAD_MAX_FILES || 10_000);
const FRONTEND_UPLOAD_MAX_UNCOMPRESSED_BYTES = Number(process.env.FRONTEND_UPLOAD_MAX_UNCOMPRESSED_BYTES || 300 * 1024 * 1024);
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function isSafeZipEntryName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  return !!normalized && !normalized.startsWith("/") && !normalized.includes("../") && normalized !== ".." && !normalized.split("/").includes("..");
}

async function validateZipArchive(zipPath: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const namesResult = await Bun.$`unzip -Z -1 ${zipPath}`.quiet().nothrow();
  if (namesResult.exitCode !== 0) {
    return { ok: false, message: "Invalid zip archive" };
  }

  const entries = namesResult.stdout.toString().split(/\r?\n/).filter(Boolean);
  if (entries.length > FRONTEND_UPLOAD_MAX_FILES) {
    return { ok: false, message: `Zip file count exceeds ${FRONTEND_UPLOAD_MAX_FILES}` };
  }

  for (const entry of entries) {
    if (!isSafeZipEntryName(entry)) {
      return { ok: false, message: "Zip archive contains unsafe paths" };
    }
  }

  const listResult = await Bun.$`unzip -Z -l ${zipPath}`.quiet().nothrow();
  if (listResult.exitCode !== 0) {
    return { ok: false, message: "Invalid zip archive" };
  }

  let totalSize = 0;
  for (const line of listResult.stdout.toString().split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Archive:") || trimmed.startsWith("---") || trimmed.includes(" files,")) continue;
    if (trimmed[0] === "l") {
      return { ok: false, message: "Zip archive must not contain symlinks" };
    }
    const match = trimmed.match(/^(\S+)\s+\S+\s+(\d+)\s+/);
    if (match) {
      totalSize += Number(match[2]);
      if (totalSize > FRONTEND_UPLOAD_MAX_UNCOMPRESSED_BYTES) {
        return { ok: false, message: `Uncompressed zip size exceeds ${FRONTEND_UPLOAD_MAX_UNCOMPRESSED_BYTES}` };
      }
    }
  }

  return { ok: true };
}

async function readUploadedZip(request: Request, body: unknown): Promise<Uint8Array> {
  // 1. 如果 body 本身就是 File / Blob，或具有 arrayBuffer 方法
  if (body && typeof body === "object" && typeof (body as any).arrayBuffer === "function") {
    try {
      return new Uint8Array(await (body as any).arrayBuffer());
    } catch {
      // ignore
    }
  }

  // 2. 如果 body 是一个对象，检测其属性（例如 file 字段，或其他任意包含 arrayBuffer 的字段）
  if (body && typeof body === "object") {
    const directFile = (body as Record<string, unknown>).file;
    if (directFile && typeof directFile === "object" && typeof (directFile as any).arrayBuffer === "function") {
      try {
        return new Uint8Array(await (directFile as any).arrayBuffer());
      } catch {
        // ignore
      }
    }

    // 遍历所有键，兼容不同客户端的自定义字段名
    for (const val of Object.values(body)) {
      if (val && typeof val === "object" && typeof (val as any).arrayBuffer === "function") {
        try {
          return new Uint8Array(await (val as any).arrayBuffer());
        } catch {
          // ignore
        }
      }
    }
  }

  // 3. 若流未被 Elysia 消费，直接从 request 读取，添加异常保护，移除 clone
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await request.formData();
      const file = form.get("file");
      if (file && typeof file === "object" && typeof (file as any).arrayBuffer === "function") {
        return new Uint8Array(await (file as any).arrayBuffer());
      }
    } catch {
      // ignore
    }
  }

  // 4. 最后回退：尝试直接读取 request 二进制，添加异常保护
  try {
    return new Uint8Array(await request.arrayBuffer());
  } catch {
    // ignore
  }

  return new Uint8Array(0);
}

export const frontendRoutes = new Elysia({ prefix: "/v1/projects/:ref/frontend" })
  .get(
    "/deployments",
    async ({ params }) => {
      const deployments = await frontendService.listDeployments(params.ref);
      return { deployments };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "List frontend deployments" },
    }
  )

  .get(
    "/deployments/:id",
    async ({ params, set }) => {
      const deployment = await frontendService.getDeployment(params.ref, params.id);
      if (!deployment) {
                return status(404, { message: "Deployment not found", code: "404" });
      }
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "Get a frontend deployment" },
    }
  )

  .post(
    "/deployments",
    async ({ params, body, set }) => {
      const deployment = await frontendService.createDeployment(params.ref, {
        name: body.name,
        framework: body.framework as FrontendFramework,
        domain: body.domain,
        custom_domains: body.custom_domains,
        build_command: body.build_command,
        output_dir: body.output_dir,
        install_command: body.install_command,
        node_version: body.node_version,
        health_check_path: body.health_check_path,
        env_vars: body.env_vars,
      });

      set.status = 201;
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        name: t.String({ minLength: 1 }),
        framework: t.String(),
        domain: t.Optional(t.String()),
        custom_domains: t.Optional(t.Array(t.String())),
        build_command: t.Optional(t.String()),
        output_dir: t.Optional(t.String()),
        install_command: t.Optional(t.String()),
        node_version: t.Optional(t.String()),
        health_check_path: t.Optional(t.String()),
        env_vars: t.Optional(t.Record(t.String(), t.String())),
      }),
      detail: { tags: ["frontend"], summary: "Create a frontend deployment" },
    }
  )

  .patch(
    "/deployments/:id",
    async ({ params, body, set }) => {
      const deployment = await frontendService.updateDeployment(params.ref, params.id, {
        name: body.name,
        domain: body.domain,
        custom_domains: body.custom_domains,
        build_command: body.build_command,
        output_dir: body.output_dir,
        install_command: body.install_command,
        node_version: body.node_version,
        health_check_path: body.health_check_path,
        env_vars: body.env_vars,
      });

      if (!deployment) {
                return status(404, { message: "Deployment not found", code: "404" });
      }

      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        name: t.Optional(t.String()),
        domain: t.Optional(t.String()),
        custom_domains: t.Optional(t.Array(t.String())),
        build_command: t.Optional(t.String()),
        output_dir: t.Optional(t.String()),
        install_command: t.Optional(t.String()),
        node_version: t.Optional(t.String()),
        health_check_path: t.Optional(t.String()),
        env_vars: t.Optional(t.Record(t.String(), t.String())),
      }),
      detail: { tags: ["frontend"], summary: "Update a frontend deployment" },
    }
  )

  .delete(
    "/deployments/:id",
    async ({ params, set }) => {
      const success = await frontendService.deleteDeployment(params.ref, params.id);
      if (!success) {
                return status(404, { message: "Deployment not found", code: "404" });
      }
      return { message: "Deployment deleted successfully" };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "Delete a frontend deployment" },
    }
  )

  .post(
    "/deployments/:id/deploy/git",
    async ({ params, body, set }) => {
      const deployment = await frontendService.getDeployment(params.ref, params.id);
      if (!deployment) {
                return status(404, { message: "Deployment not found", code: "404" });
      }

      const result = await frontendService.deployFromGit(
        params.ref,
        params.id,
        body.git_url,
        body.branch
      );

      return result;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        git_url: t.String(),
        branch: t.Optional(t.String({ default: "main" })),
      }),
      detail: { tags: ["frontend"], summary: "Deploy from git repository" },
    }
  )

  .post(
    "/deployments/:id/deploy/upload",
    async ({ params, body, request, set }) => {
      const deployment = await frontendService.getDeployment(params.ref, params.id);
      if (!deployment) {
                return status(404, { message: "Deployment not found", code: "404" });
      }

      if (!SAFE_ID_PATTERN.test(params.ref) || !SAFE_ID_PATTERN.test(params.id)) {
        set.status = 400;
        return {
          success: false,
          deployment_id: params.id,
          url: "",
          build_log: "",
          message: "Invalid project reference or deployment id",
        };
      }

      const tempDir = await mkdtemp(path.join(tmpdir(), "supacloud-frontend-upload-"));
      const extractDir = path.join(tempDir, "extract");
      const tempZip = path.join(tempDir, "upload.zip");

      try {
        const contentLength = Number(request.headers.get("content-length") || 0);
        if (contentLength > FRONTEND_UPLOAD_MAX_BYTES) {
          set.status = 413;
          return {
            success: false,
            deployment_id: params.id,
            url: "",
            build_log: "",
            message: `Upload payload exceeds ${FRONTEND_UPLOAD_MAX_BYTES} bytes`,
          };
        }

        const zipBytes = await readUploadedZip(request, body);
        if (!zipBytes.byteLength) {
          set.status = 400;
          return {
            success: false,
            deployment_id: params.id,
            url: "",
            build_log: "",
            message: "Empty upload payload",
          };
        }
        if (zipBytes.byteLength > FRONTEND_UPLOAD_MAX_BYTES) {
          set.status = 413;
          return {
            success: false,
            deployment_id: params.id,
            url: "",
            build_log: "",
            message: `Upload payload exceeds ${FRONTEND_UPLOAD_MAX_BYTES} bytes`,
          };
        }

        await Bun.write(tempZip, zipBytes);
        const validation = await validateZipArchive(tempZip);
        if (!validation.ok) {
          set.status = 400;
          return {
            success: false,
            deployment_id: params.id,
            url: "",
            build_log: "",
            message: validation.message,
          };
        }

        const extractResult = await Bun.$`unzip -q ${tempZip} -d ${extractDir}`.quiet();
        if (extractResult.exitCode !== 0) {
          return {
            success: false,
            deployment_id: params.id,
            url: "",
            build_log: extractResult.stderr.toString(),
            message: "Failed to extract zip file",
          };
        }

        return await frontendService.deployFromSource(params.ref, params.id, extractDir);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Any(),
      detail: { tags: ["frontend"], summary: "Deploy from uploaded zip" },
    }
  )

  .post(
    "/deployments/:id/redeploy",
    async ({ params, set }) => {
      const deployment = await frontendService.getDeployment(params.ref, params.id);
      if (!deployment) {
                return status(404, { message: "Deployment not found", code: "404" });
      }

      const deploymentDir = `/var/supacloud/frontends/${params.ref}/${params.id}`;
      const sourceDir = `${deploymentDir}/source`;

      const result = await frontendService.deployFromSource(params.ref, params.id, sourceDir);
      return result;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "Redeploy a frontend deployment" },
    }
  )

  .get(
    "/deployments/:id/logs",
    async ({ params, set }) => {
      const buildLog = await frontendService.getBuildLog(params.ref, params.id);
      return { logs: buildLog };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "Get deployment build logs" },
    }
  )

  .put(
    "/deployments/:id/env",
    async ({ params, body, set }) => {
      const deployment = await frontendService.setEnvVars(params.ref, params.id, body.env_vars);
      if (!deployment) {
                return status(404, { message: "Deployment not found", code: "404" });
      }
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        env_vars: t.Record(t.String(), t.String()),
      }),
      detail: { tags: ["frontend"], summary: "Set deployment environment variables" },
    }
  )

  .post(
    "/deployments/:id/domains",
    async ({ params, body, set }) => {
      const deployment = await frontendService.addCustomDomain(params.ref, params.id, body.domain);
      if (!deployment) {
                return status(404, { message: "Deployment not found", code: "404" });
      }
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        domain: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "Add a custom domain" },
    }
  )

  .delete(
    "/deployments/:id/domains/:domain",
    async ({ params, set }) => {
      const deployment = await frontendService.removeCustomDomain(
        params.ref,
        params.id,
        params.domain
      );
      if (!deployment) {
                return status(404, { message: "Deployment not found", code: "404" });
      }
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
        domain: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "Remove a custom domain" },
    }
  )

  .get(
    "/frameworks",
    async () => {
      return {
        frameworks: Object.entries(FRAMEWORK_DEFAULTS).map(([id, config]) => ({
          id,
          name: id.charAt(0).toUpperCase() + id.slice(1).replace("js", "JS").replace("kit", "Kit"),
          defaults: config,
        })),
      };
    },
    { detail: { tags: ["frontend"], summary: "List supported frontend frameworks" } }
  )

  .post(
    "/deployments/:id/tokens",
    async ({ params, body, set }) => {
      const result = await frontendService.createDeployToken(params.ref, params.id, body.name);
      if (!result) {
                return status(404, { message: "Deployment not found", code: "404" });
      }
      return result;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        name: t.String({ minLength: 1 }),
      }),
      detail: { tags: ["frontend"], summary: "Create a deploy token" },
    }
  )

  .get(
    "/deployments/:id/tokens",
    async ({ params, set }) => {
      const tokens = await frontendService.listDeployTokens(params.ref, params.id);
      return { tokens };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "List deploy tokens" },
    }
  )

  .delete(
    "/deployments/:id/tokens/:tokenId",
    async ({ params, set }) => {
      const success = await frontendService.deleteDeployToken(params.ref, params.id, params.tokenId);
      if (!success) {
                return status(404, { message: "Token not found", code: "404" });
      }
      return { message: "Token deleted successfully" };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
        tokenId: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "Delete a deploy token" },
    }
  )

  .put(
    "/deployments/:id/git",
    async ({ params, body, set }) => {
      const deployment = await frontendService.setGitConfig(
        params.ref,
        params.id,
        body.git_url,
        body.branch || "main"
      );
      if (!deployment) {
                return status(404, { message: "Deployment not found", code: "404" });
      }
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        git_url: t.String(),
        branch: t.Optional(t.String({ default: "main" })),
      }),
      detail: { tags: ["frontend"], summary: "Set git configuration" },
    }
  )

  .get(
    "/deployments/:id/records",
    async ({ params, set }) => {
      const records = await frontendService.listDnsRecords(params.ref, params.id);
      if (!records) {
        return status(404, { message: "Deployment not found", code: "404" });
      }
      return { records };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "List DNS records" },
    }
  )

  .get(
    "/deployments/:id/deployment-records",
    async ({ params, set }) => {
      const records = await frontendService.listDeploymentRecords(params.ref, params.id);
      return { records };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "List deployment records" },
    }
  )

  .get(
    "/deployments/:id/deployment-records/:recordId",
    async ({ params, set }) => {
      const record = await frontendService.getDeploymentRecord(params.ref, params.id, params.recordId);
      if (!record) {
                return status(404, { message: "Record not found", code: "404" });
      }
      return record;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
        recordId: t.String(),
      }),
      detail: { tags: ["frontend"], summary: "Get a deployment record" },
    }
  );
