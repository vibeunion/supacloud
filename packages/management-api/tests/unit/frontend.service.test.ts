import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
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
const withoutDeploymentLock = async <T>(
  _projectRef: string,
  _deploymentId: string,
  operation: () => Promise<T>,
): Promise<T> => operation();
const noImmutableRelease = async () => ({
  activeBuildDir: async () => null,
  hasActiveRelease: async () => false,
  hasUnresolvedActivation: async () => false,
});

function barrier(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  return { wait: new Promise<void>((resolve) => { release = resolve; }), release };
}

beforeEach(() => {
  globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] })))) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm("/tmp/supacloud-caddy-test", { recursive: true, force: true });
});

describe("FrontendService DNS records", () => {
  test("uses the normalized base domain for temporary frontend hosts", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-domain-test-"));
    const originalBaseDomain = config.baseDomain;

    try {
      for (const configuredBaseDomain of ["xai.xigu.team", "api.xai.xigu.team"]) {
        config.baseDomain = configuredBaseDomain;
        const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
        const deployment = await service.createDeployment("proj123", {
          name: "site",
          framework: "static",
        });

        expect(deployment.domain).toBe(`${deployment.id}.proj123.xai.xigu.team`);
        expect(deployment.deployment_url).toBe(`https://${deployment.id}.proj123.xai.xigu.team`);
      }
    } finally {
      config.baseDomain = originalBaseDomain;
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("returns managed temporary domain record and expected custom domain records", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-test-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

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

  test("uses the configured domain when a legacy deployment has no stored host", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-dns-fallback-test-"));
    const originalBaseDomain = config.baseDomain;

    try {
      config.baseDomain = "api.xai.xigu.team";
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await service.createDeployment("proj123", {
        name: "site",
        framework: "static",
      });
      await writeFile(
        join(baseDir, "proj123", deployment.id, "deployment.json"),
        JSON.stringify({ ...deployment, domain: "" }),
      );

      const records = await service.listDnsRecords("proj123", deployment.id);

      expect(records?.[0]?.hostname).toBe(`${deployment.id}.proj123.xai.xigu.team`);
    } finally {
      config.baseDomain = originalBaseDomain;
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("returns null when deployment does not exist", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-test-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

    try {
      await expect(service.listDnsRecords("proj123", "missing123")).resolves.toBeNull();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("FrontendService SvelteKit defaults", () => {
  test("keeps shell-compatible build commands working by default", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-shell-build-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-shell-source-"));
    const previousPolicy = process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS;
    delete process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS;

    try {
      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      (service as any).applyGatewayRoute = async () => undefined;
      const deployment = await service.createDeployment("proj123", {
        name: "shell-site",
        framework: "static",
        install_command: "",
        build_command: "mkdir -p dist && printf '<h1>ok</h1>' > dist/index.html",
        output_dir: "dist",
      });

      const result = await service.deployFromSource("proj123", deployment.id, sourceDir);

      expect(result.success).toBe(true);
      expect(await readFile(join(baseDir, "proj123", deployment.id, "build", "index.html"), "utf8"))
        .toBe("<h1>ok</h1>");
    } finally {
      if (previousPolicy === undefined) delete process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS;
      else process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS = previousPolicy;
      await rm(baseDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("supports an explicit restricted build-command policy", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-shell-policy-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-shell-policy-source-"));
    const previousPolicy = process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS;
    process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS = "true";

    try {
      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await service.createDeployment("proj123", {
        name: "restricted-site",
        framework: "static",
        install_command: "",
        build_command: "printf ok > index.html && printf blocked > blocked.html",
        output_dir: ".",
      });

      const result = await service.deployFromSource("proj123", deployment.id, sourceDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain("unsupported shell syntax");
    } finally {
      if (previousPolicy === undefined) delete process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS;
      else process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS = previousPolicy;
      await rm(baseDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("uses an adapter-node output and a root readiness probe", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-defaults-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

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
      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

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
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

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

    const service = new FrontendService(
      "/tmp/supacloud-frontend-test",
      withoutDeploymentLock,
      noImmutableRelease,
    );
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

    await mkdir(join("/tmp/supacloud-frontend-test", "proj123", deployment.id), { recursive: true });
    await writeFile(
      join("/tmp/supacloud-frontend-test", "proj123", deployment.id, "deployment.json"),
      JSON.stringify(deployment),
    );
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

      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
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

  test("re-reads deployment hosts inside the route lock", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-stale-hosts-"));
    const gatewayCalls: Array<{ method: string; body: any }> = [];
    globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method || "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      gatewayCalls.push({ method, body });
      return Promise.resolve(new Response(JSON.stringify({ data: [] })));
    }) as unknown as typeof fetch;

    try {
      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const stale = await service.createDeployment("proj123", { name: "site", framework: "static" });
      await writeFile(
        join(baseDir, "proj123", stale.id, "deployment.json"),
        JSON.stringify({ ...stale, domain: "current.example.com", custom_domains: ["www.current.example.com"] }),
      );

      await service.configureGatewayRoute(stale, join(baseDir, "build"), false);

      const routes = gatewayCalls.filter((call) => call.method === "POST").at(-1)
        ?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
      const route = routes.find((candidate: any) => candidate["@id"] === `route-frontend-proj123-${stale.id}`);
      expect(route?.match?.[0]?.host).toEqual(["current.example.com", "www.current.example.com"]);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("FrontendService deployment serialization", () => {
  test("keeps the complete legacy SSR deployment inside the deployment lock", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-ssr-lock-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-ssr-source-"));
    const firstEntered = barrier();
    const releaseFirst = barrier();
    const operationContext = new AsyncLocalStorage<boolean>();
    let tail = Promise.resolve();
    let secondEntered = false;
    const serializedLock = async <T>(
      _projectRef: string,
      _deploymentId: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (operationContext.getStore()) return operation();
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await operationContext.run(true, operation);
      } finally {
        release();
      }
    };

    try {
      const setup = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await setup.createDeployment("proj123", {
        name: "ssr-site",
        framework: "nextjs",
        install_command: "",
        build_command: "",
      });
      // createDeployment applies framework defaults for empty commands; this
      // test exercises the full deployment flow, so store explicit empty commands.
      await writeFile(
        join(baseDir, "proj123", deployment.id, "deployment.json"),
        JSON.stringify({ ...deployment, install_command: "", build_command: "" }, null, 2),
      );
      await mkdir(join(sourceDir, ".next"));
      await writeFile(join(sourceDir, ".next", "index.js"), "console.log('ready')\n");
      const service = new FrontendService(baseDir, serializedLock, noImmutableRelease);
      // Barrier in the build phase: only the outer deployFromSource lock keeps
      // the second operation out here; publish-time locks are re-entrant.
      const prepareOriginal = (service as any).prepareLegacySsrBuild.bind(service);
      (service as any).prepareLegacySsrBuild = async (...args: any[]) => {
        firstEntered.release();
        await releaseFirst.wait;
        return prepareOriginal(...args);
      };
      (service as any).startProcess = async () => 30001;
      (service as any).waitForReadiness = async () => true;
      (service as any).applyGatewayRoute = async () => undefined;
      (service as any).stopProcess = async () => undefined;
      (service as any).removeGatewayRoute = async () => undefined;
      const first = service.deployFromSource("proj123", deployment.id, sourceDir);
      await firstEntered.wait;
      let secondStarted = false;
      const second = Promise.resolve().then(async () => {
        secondStarted = true;
        return service.deleteDeployment("proj123", deployment.id);
      }).then((outcome) => {
        secondEntered = true;
        return outcome;
      });
      while (!secondStarted) await Promise.resolve();
      expect(secondEntered).toBe(false);
      releaseFirst.release();
      expect((await first).success).toBe(true);
      expect(await second).toBe("deleted");
      expect(secondEntered).toBe(true);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("keeps the complete legacy static deployment inside the deployment lock", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-static-lock-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-static-source-"));
    const firstEntered = barrier();
    const releaseFirst = barrier();
    const operationContext = new AsyncLocalStorage<boolean>();
    let tail = Promise.resolve();
    let secondEntered = false;
    const serializedLock = async <T>(
      _projectRef: string,
      _deploymentId: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (operationContext.getStore()) return operation();
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await operationContext.run(true, operation);
      } finally {
        release();
      }
    };

    try {
      const setup = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await setup.createDeployment("proj123", {
        name: "static-site",
        framework: "static",
        install_command: "",
        build_command: "",
      });
      await writeFile(join(sourceDir, "index.html"), "<!doctype html>");
      const service = new FrontendService(baseDir, serializedLock, noImmutableRelease);
      // Barrier in the build phase: only the outer deployFromSource lock keeps
      // the second operation out here; publish-time locks are re-entrant.
      const prepareOriginal = (service as any).prepareLegacyBuild.bind(service);
      (service as any).prepareLegacyBuild = async (...args: any[]) => {
        firstEntered.release();
        await releaseFirst.wait;
        return prepareOriginal(...args);
      };
      (service as any).applyGatewayRoute = async () => undefined;
      (service as any).stopProcess = async () => undefined;
      (service as any).removeGatewayRoute = async () => undefined;
      const first = service.deployFromSource("proj123", deployment.id, sourceDir);
      await firstEntered.wait;
      let secondStarted = false;
      const second = Promise.resolve().then(async () => {
        secondStarted = true;
        return service.deleteDeployment("proj123", deployment.id);
      }).then((outcome) => {
        secondEntered = true;
        return outcome;
      });
      while (!secondStarted) await Promise.resolve();
      expect(secondEntered).toBe(false);
      releaseFirst.release();
      expect((await first).success).toBe(true);
      expect(await second).toBe("deleted");
      expect(secondEntered).toBe(true);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("holds the deployment lock for every metadata read-modify-write", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-rmw-lock-"));
    const lockCalls: string[] = [];
    const trackedLock = async <T>(projectRef: string, deploymentId: string, operation: () => Promise<T>) => {
      lockCalls.push(`${projectRef}/${deploymentId}`);
      return operation();
    };
    const service = new FrontendService(baseDir, trackedLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
      await service.updateDeployment("proj123", deployment.id, { name: "renamed" });
      await service.setEnvVars("proj123", deployment.id, { FEATURE_FLAG: "enabled" });
      const deployToken = await service.createDeployToken("proj123", deployment.id, "ci");
      expect(deployToken).not.toBeNull();
      expect(await service.verifyDeployToken("proj123", deployment.id, deployToken!.token)).toBe(true);
      await service.setGitConfig("proj123", deployment.id, "https://git.example.com/org/repo.git", "main");
      expect(await service.deleteDeployToken("proj123", deployment.id, deployToken!.id)).toBe(true);

      expect(lockCalls).toEqual(Array(6).fill(`proj123/${deployment.id}`));
      expect(await service.getDeployment("proj123", deployment.id)).toMatchObject({
        name: "renamed",
        env_vars: { FEATURE_FLAG: "enabled" },
        git_url: "https://git.example.com/org/repo.git",
        git_branch: "main",
        deploy_tokens: [],
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("preserves private Git credentials when the UI saves a redacted repository URL", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-git-redaction-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
      await service.setGitConfig(
        "proj123",
        deployment.id,
        "https://build-user:build-secret@git.example.com/org/repo.git",
        "main",
      );
      await service.setGitConfig(
        "proj123",
        deployment.id,
        "https://git.example.com/org/repo.git",
        "main",
      );

      expect((await service.getDeployment("proj123", deployment.id))?.git_url)
        .toBe("https://build-user:build-secret@git.example.com/org/repo.git");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("does not overwrite an environment secret when the masked value is submitted back", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-env-mask-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", {
        name: "site",
        framework: "static",
        env_vars: { VITE_API_TOKEN: "real-secret-value" },
      });
      await service.setEnvVars("proj123", deployment.id, {
        VITE_API_TOKEN: "********",
        FEATURE_FLAG: "enabled",
      });

      expect((await service.getDeployment("proj123", deployment.id))?.env_vars).toEqual({
        VITE_API_TOKEN: "real-secret-value",
        FEATURE_FLAG: "enabled",
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("preserves concurrent env and git metadata updates", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-rmw-race-"));
    let tail = Promise.resolve();
    const serializedLock = async <T>(
      _projectRef: string,
      _deploymentId: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    };
    const service = new FrontendService(baseDir, serializedLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
      await Promise.all([
        service.setEnvVars("proj123", deployment.id, { FEATURE_FLAG: "enabled" }),
        service.setGitConfig("proj123", deployment.id, "https://git.example.com/org/repo.git", "stable"),
      ]);

      expect(await service.getDeployment("proj123", deployment.id)).toMatchObject({
        env_vars: { FEATURE_FLAG: "enabled" },
        git_url: "https://git.example.com/org/repo.git",
        git_branch: "stable",
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("rejects immutable domain mutations before changing metadata or gateway state", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-domain-block-"));
    const gatewayRequest = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] }))));
    globalThis.fetch = gatewayRequest as unknown as typeof fetch;
    const activeRelease = async () => ({
      activeBuildDir: async () => join(baseDir, "immutable"),
      hasActiveRelease: async () => true,
      hasUnresolvedActivation: async () => false,
    });

    try {
      const setup = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await setup.createDeployment("proj123", { name: "site", framework: "static" });
      const service = new FrontendService(baseDir, withoutDeploymentLock, activeRelease);

      await expect(service.addCustomDomain("proj123", deployment.id, "blocked.example.com"))
        .rejects.toMatchObject({ code: "FRONTEND_RELEASE_ACTIVE", statusCode: 409 });
      expect((await service.getDeployment("proj123", deployment.id))?.custom_domains).toEqual([]);
      expect(gatewayRequest).not.toHaveBeenCalled();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("does not commit custom-domain metadata when gateway publication fails", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-domain-gateway-failure-"));
    globalThis.fetch = mock(() => Promise.resolve(
      new Response("gateway rejected", { status: 500 }),
    )) as unknown as typeof fetch;

    try {
      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });

      await expect(service.addCustomDomain("proj123", deployment.id, "uncommitted.example.com"))
        .rejects.toThrow();
      expect((await service.getDeployment("proj123", deployment.id))?.custom_domains).toEqual([]);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("checks immutable authority again before publishing a prepared static build", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-static-cas-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-static-source-"));
    let activeChecks = 0;
    const changingReleaseState = async () => ({
      activeBuildDir: async () => null,
      hasActiveRelease: async () => ++activeChecks > 1,
      hasUnresolvedActivation: async () => false,
    });
    const gatewayRequest = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] }))));
    globalThis.fetch = gatewayRequest as unknown as typeof fetch;

    try {
      const service = new FrontendService(baseDir, withoutDeploymentLock, changingReleaseState);
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
      await writeFile(join(sourceDir, "index.html"), "prepared but not published");

      const result = await service.deployFromSource("proj123", deployment.id, sourceDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain("active or unresolved");
      await expect(access(join(baseDir, "proj123", deployment.id, "build", "index.html"))).rejects.toThrow();
      expect(gatewayRequest).not.toHaveBeenCalled();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});

describe("FrontendService optimizer", () => {
  test("generates br and gzip sidecars for static text assets", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-optimizer-test-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
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
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

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
