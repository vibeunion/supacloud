import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config, resolveSupacloudBinaryPath } from "../../src/config";
import { FrontendService } from "../../src/services/frontend.service";
import type { FrontendDeployment } from "../../src/types/frontend";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] })))) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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

describe("FrontendService static binary resolution", () => {
  test("uses explicit SUPACLOUD_BINARY_PATH when provided", () => {
    expect(resolveSupacloudBinaryPath("/custom/supacloud", "/usr/local/bin/supacloud")).toBe("/custom/supacloud");
  });

  test("uses the current release binary when not running through bun", () => {
    expect(resolveSupacloudBinaryPath("", "/usr/local/bin/supacloud")).toBe("/usr/local/bin/supacloud");
  });

  test("keeps the legacy install path for source runs through bun", () => {
    expect(resolveSupacloudBinaryPath("", "/root/.bun/bin/bun")).toBe("/opt/supacloud/supacloud");
  });
});

describe("FrontendService Kong routing", () => {
  test("disables buffering on frontend root routes", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const method = init?.method || "GET";
      let body: Record<string, unknown> | null = null;
      if (typeof init?.body === "string" && init.body.length > 0) {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
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

    await service.configureKongRoute(deployment, "/tmp/build", false);

    const routeCall = calls.find(
      (call) => call.method === "PUT" && call.url.includes("/routes/route-frontend-proj123-0000002a")
    );

    expect(routeCall).toBeDefined();
    expect(routeCall?.body).toMatchObject({
      paths: ["/"],
      hosts: ["site.example.com", "www.example.com"],
      strip_path: false,
      preserve_host: true,
      request_buffering: false,
      response_buffering: false,
    });
  });
});
