import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config, resolveSupacloudBinaryPath } from "../../src/config";
import { FrontendService } from "../../src/services/frontend.service";

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
