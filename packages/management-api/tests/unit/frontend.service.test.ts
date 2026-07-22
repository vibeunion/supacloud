import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../../src/config";
import { FrontendService } from "../../src/services/frontend.service";
import {
  prepareSvelteKitRuntime,
  renderSvelteKitSystemdUnit,
} from "../../src/services/frontend-runtime";
import { FRAMEWORK_DEFAULTS, type FrontendDeployment } from "../../src/types/frontend";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] })))) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm("/tmp/supacloud-caddy-test", { recursive: true, force: true });
});

describe("FrontendService DNS records", () => {
  test("returns managed temporary domain record and expected custom domain records", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-test-"));
    const service = new FrontendService(baseDir);

    try {
      const deployment = await service.createDeployment("proj123", {
        name: "site",
        framework: "static",
        custom_domains: ["www.example.com"],
      });

      const records = await service.listDnsRecords("proj123", deployment.id);

      expect(records).not.toBeNull();
      expect(records?.length).toBe(2);
      expect(records?.[0]).toMatchObject({
        deployment_id: deployment.id,
        project_ref: "proj123",
        hostname: deployment.domain,
        type: "A",
        name: deployment.domain,
        value: config.dockerHostIp,
        status: "managed",
        source: "temporary_domain",
      });
      expect(records?.[1]).toMatchObject({
        deployment_id: deployment.id,
        project_ref: "proj123",
        hostname: "www.example.com",
        type: "CNAME",
        name: "www.example.com",
        value: deployment.domain,
        status: "expected",
        source: "custom_domain",
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("returns null when deployment does not exist", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-test-"));
    const service = new FrontendService(baseDir);

    try {
      await expect(service.listDnsRecords("proj123", "missing123")).resolves.toBeNull();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("FrontendService SvelteKit defaults", () => {
  test("uses an adapter-node output and a root readiness probe", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-defaults-"));
    const service = new FrontendService(baseDir);

    try {
      const deployment = await service.createDeployment("proj123", {
        name: "sveltekit-app",
        framework: "sveltekit",
      });

      expect(deployment.output_dir).toBe("build");
      expect(deployment.health_check_path).toBe("/");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("keeps existing build settings when only readiness is updated", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-update-"));
    const service = new FrontendService(baseDir);

    try {
      const deployment = await service.createDeployment("proj123", {
        name: "sveltekit-app",
        framework: "sveltekit",
      });
      const updated = await service.updateDeployment("proj123", deployment.id, {
        name: undefined,
        build_command: undefined,
        output_dir: undefined,
        health_check_path: "/ready",
      });

      expect(updated).toMatchObject({
        name: "sveltekit-app",
        build_command: "npm run build",
        output_dir: "build",
        health_check_path: "/ready",
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("provides a distinct adapter-static SvelteKit profile", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-static-"));
    const service = new FrontendService(baseDir);

    try {
      const deployment = await service.createDeployment("proj123", {
        name: "sveltekit-static-app",
        framework: "sveltekit-static",
      });

      expect(deployment.framework).toBe("sveltekit-static");
      expect(deployment.output_dir).toBe("build");
      expect(deployment.build_command).toBe("npm run build");
      expect(FRAMEWORK_DEFAULTS["sveltekit-static"].is_ssr).toBe(false);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("stages adapter-node runtime dependencies and renders a Node service", async () => {
    const deploymentDir = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-runtime-"));
    const sourceDir = join(deploymentDir, "source");
    const buildDir = join(deploymentDir, "build");

    try {
      await mkdir(join(sourceDir, "node_modules"), { recursive: true });
      await mkdir(buildDir, { recursive: true });
      await writeFile(join(sourceDir, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(join(sourceDir, "node_modules", "runtime-marker"), "present");
      await writeFile(join(buildDir, "index.js"), "console.log('ready')\n");

      await prepareSvelteKitRuntime(sourceDir, buildDir);

      expect(JSON.parse(await readFile(join(buildDir, "package.json"), "utf8"))).toEqual({
        type: "module",
      });
      expect((await lstat(join(buildDir, "node_modules"))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(buildDir, "node_modules"))).toBe("../source/node_modules");

      const unit = renderSvelteKitSystemdUnit({
        serviceName: "supacloud-frontend-proj123-app123",
        runtimeUser: "supacloud-proj123",
        description: "SvelteKit app",
        buildDir,
        envFile: join(deploymentDir, ".env"),
        port: 30123,
      });
      expect(unit).toContain(`WorkingDirectory=${buildDir}`);
      expect(unit).toContain("User=supacloud-proj123");
      expect(unit).toContain("Group=supacloud-proj123");
      expect(unit).toContain('Environment="PROTOCOL_HEADER=x-forwarded-proto"');
      expect(unit).toContain('Environment="HOST_HEADER=x-forwarded-host"');
      expect(unit).toContain('Environment="PORT_HEADER=x-forwarded-port"');
      expect(unit).toContain(`ExecStart=/usr/bin/env node ${buildDir}/index.js`);
      expect(unit).not.toContain("bun run");
    } finally {
      await rm(deploymentDir, { recursive: true, force: true });
    }
  });

  test("rejects adapter-static output when the SSR profile is selected", async () => {
    const deploymentDir = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-adapter-mismatch-"));
    const sourceDir = join(deploymentDir, "source");
    const buildDir = join(deploymentDir, "build");

    try {
      await mkdir(join(sourceDir, "node_modules"), { recursive: true });
      await mkdir(buildDir, { recursive: true });
      await writeFile(join(sourceDir, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(join(buildDir, "index.html"), "<!doctype html>");

      await expect(prepareSvelteKitRuntime(sourceDir, buildDir)).rejects.toThrow(
        "use framework=sveltekit-static for adapter-static output",
      );
    } finally {
      await rm(deploymentDir, { recursive: true, force: true });
    }
  });
});

describe("FrontendService gateway routing", () => {
  test("registers frontend root route through the gateway provider", async () => {
    const calls: Array<{ url: string; method: string; body: any }> = [];

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const method = init?.method || "GET";
      let body: any = null;
      if (typeof init?.body === "string" && init.body.length > 0) {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = null;
        }
      }
      calls.push({ url, method, body });
      return Promise.resolve(new Response(JSON.stringify({ data: [] })));
    }) as unknown as typeof fetch;

    const service = new FrontendService("/tmp/supacloud-frontend-test");
    const deployment: FrontendDeployment = {
      id: "0000002a",
      project_ref: "proj123",
      name: "site",
      framework: "static",
      domain: "site.example.com",
      custom_domains: ["www.example.com"],
      build_command: "",
      output_dir: ".",
      install_command: "",
      node_version: "20",
      env_vars: {},
      status: "pending",
      created_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:00:00.000Z",
      deployment_url: "https://site.example.com",
    };

    await service.configureGatewayRoute(deployment, "/tmp/build", false);

    const loadCall = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
    const routes = loadCall?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
    const route = routes.find((item: any) => item["@id"] === "route-frontend-proj123-0000002a");

    expect(route).toBeDefined();
    expect(route?.match?.[0]?.path).toEqual(["/*"]);
    expect(route?.match?.[0]?.host).toEqual(["site.example.com", "www.example.com"]);
    const subroute = route?.handle?.find((handler: any) => handler.handler === "subroute");
    const fileServer = subroute?.routes?.at(-1)?.handle?.at(-1);
    expect(fileServer?.handler).toBe("file_server");
    expect(fileServer?.root).toBe("/tmp/build");
    expect(fileServer?.precompressed_order).toEqual(["br", "zstd", "gzip"]);
  });

  test("reconciles successful static deployments back into Caddy routes", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-reconcile-test-"));
    const calls: Array<{ url: string; method: string; body: any }> = [];

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const method = init?.method || "GET";
      let body: any = null;
      if (typeof init?.body === "string" && init.body.length > 0) {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = null;
        }
      }
      calls.push({ url, method, body });
      return Promise.resolve(new Response(JSON.stringify({ data: [] })));
    }) as unknown as typeof fetch;

    try {
      const deploymentDir = join(baseDir, "proj123", "0000002c");
      const buildDir = join(deploymentDir, "build");
      await mkdir(buildDir, { recursive: true });
      await writeFile(join(buildDir, "index.html"), "<!doctype html><title>site</title>");
      await writeFile(join(deploymentDir, "deployment.json"), JSON.stringify({
        id: "0000002c",
        project_ref: "proj123",
        name: "site",
        framework: "static",
        domain: "site.example.com",
        custom_domains: ["www.example.com"],
        build_command: "",
        output_dir: ".",
        install_command: "",
        node_version: "20",
        env_vars: {},
        status: "success",
        created_at: "2026-05-27T00:00:00.000Z",
        updated_at: "2026-05-27T00:00:00.000Z",
        deployment_url: "https://site.example.com",
      }));

      const service = new FrontendService(baseDir);
      const result = await service.reconcileGatewayRoutes();

      expect(result).toEqual({ total: 1, configured: 1, skipped: 0, errors: [] });

      const loadCall = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
      const routes = loadCall?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
      const route = routes.find((item: any) => item["@id"] === "route-frontend-proj123-0000002c");
      const subroute = route?.handle?.find((handler: any) => handler.handler === "subroute");
      const fileServer = subroute?.routes?.at(-1)?.handle?.at(-1);

      expect(route?.match?.[0]?.host).toEqual(["site.example.com", "www.example.com"]);
      expect(route?.match?.[0]?.path).toEqual(["/*"]);
      expect(fileServer?.handler).toBe("file_server");
      expect(fileServer?.root).toBe(buildDir);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("FrontendService optimizer", () => {
  test("generates br and gzip sidecars for static text assets", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-optimizer-test-"));
    const service = new FrontendService(baseDir);
    const assetPath = join(baseDir, "app.js");

    try {
      await writeFile(assetPath, "console.log('supacloud');\n".repeat(128));
      await (service as any).precompressStaticAssets(baseDir);

      await access(`${assetPath}.br`);
      await access(`${assetPath}.gz`);
      if ((await Bun.spawn(["which", "zstd"]).exited) === 0) {
        await access(`${assetPath}.zst`);
      }
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("generates image variant sidecars when optimizer tools are available", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-image-optimizer-test-"));
    const binDir = join(baseDir, "bin");
    const imagePath = join(baseDir, "hero.jpg");
    const originalPath = process.env.PATH || "";
    const service = new FrontendService(baseDir);

    try {
      await mkdir(binDir);
      await writeFile(join(binDir, "cwebp"), "#!/bin/sh\ncp \"$4\" \"$6\"\n");
      await writeFile(join(binDir, "avifenc"), "#!/bin/sh\ncp \"$8\" \"$9\"\n");
      await chmod(join(binDir, "cwebp"), 0o755);
      await chmod(join(binDir, "avifenc"), 0o755);
      process.env.PATH = `${binDir}:${originalPath}`;

      await writeFile(imagePath, Buffer.alloc(2048, 1));
      await (service as any).precompressStaticAssets(baseDir);

      await access(`${imagePath}.webp`);
      await access(`${imagePath}.avif`);
    } finally {
      process.env.PATH = originalPath;
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
