import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installEdgeFetchTlsPolicy,
  resolveEdgeFetchTlsPolicy,
  type EdgeFetchTlsPolicy,
} from "./fetch-tls-policy";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function captureFetchInit(policy: EdgeFetchTlsPolicy, url = "https://example.test") {
  let capturedInit: RequestInit | undefined;
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return new Response("ok");
  }) as typeof globalThis.fetch;

  const restore = installEdgeFetchTlsPolicy(policy, fakeFetch);
  try {
    await fetch(url, { headers: { "x-test": "1" } });
  } finally {
    restore();
  }

  return capturedInit as RequestInit & { tls?: Record<string, unknown> };
}

describe("Edge fetch TLS policy", () => {
  test("defaults to no fetch override", async () => {
    const policy = await resolveEdgeFetchTlsPolicy({});
    expect(policy).toEqual({ source: "none" });

    const before = globalThis.fetch;
    const restore = installEdgeFetchTlsPolicy(policy);
    expect(globalThis.fetch).toBe(before);
    restore();
    expect(globalThis.fetch).toBe(before);
  });

  test("loads inline CA for HTTPS fetches", async () => {
    const policy = await resolveEdgeFetchTlsPolicy({
      SUPACLOUD_EDGE_TLS_CA: "-----BEGIN CERTIFICATE-----\ninline\n-----END CERTIFICATE-----",
    });

    const init = await captureFetchInit(policy);
    expect(init.tls?.ca).toContain("inline");
    expect(init.tls?.rejectUnauthorized).toBeUndefined();
  });

  test("loads CA bundle from file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supacloud-edge-ca-"));
    const caPath = join(dir, "ca.pem");
    await Bun.write(caPath, "-----BEGIN CERTIFICATE-----\nfile\n-----END CERTIFICATE-----");

    try {
      const policy = await resolveEdgeFetchTlsPolicy({
        SUPACLOUD_EDGE_TLS_CA_FILE: "/tenant/ca-file-is-ignored.pem",
      }, {
        SUPACLOUD_EDGE_TLS_CA_FILE: caPath,
      }, (path) => Bun.file(path).text());
      const init = await captureFetchInit(policy);
      expect(init.tls?.ca).toContain("file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses host env as the fallback policy source", async () => {
    const policy = await resolveEdgeFetchTlsPolicy({}, {
      SUPACLOUD_EDGE_TLS_CA: "-----BEGIN CERTIFICATE-----\nhost\n-----END CERTIFICATE-----",
    });

    const init = await captureFetchInit(policy);
    expect(init.tls?.ca).toContain("host");
  });

  test("explicit insecure skip verify overrides HTTPS verification", async () => {
    const policy = await resolveEdgeFetchTlsPolicy({
      SUPACLOUD_EDGE_TLS_CA: "ignored when insecure is enabled",
      SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY: "true",
    });

    const init = await captureFetchInit(policy);
    expect(init.tls?.rejectUnauthorized).toBe(false);
    expect(init.tls?.ca).toBeUndefined();
  });

  test("does not attach TLS options to plain HTTP fetches", async () => {
    const policy = await resolveEdgeFetchTlsPolicy({
      SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY: "true",
    });

    const init = await captureFetchInit(policy, "http://example.test");
    expect(init.tls).toBeUndefined();
  });
});
