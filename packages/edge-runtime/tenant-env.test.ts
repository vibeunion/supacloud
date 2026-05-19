import { describe, expect, mock, test } from "bun:test";
import {
  invalidateTenantEnvCache,
  isMaskedSecretValue,
  loadTenantEnv,
  normalizeTenantEnv,
  stripMaskedSecretValues,
} from "./tenant-env";

describe("tenant env masking guard", () => {
  test("recognizes masked secret placeholders", () => {
    expect(isMaskedSecretValue("********")).toBe(true);
    expect(isMaskedSecretValue("  ********  ")).toBe(true);
    expect(isMaskedSecretValue("real-value")).toBe(false);
  });

  test("drops masked placeholders before runtime injection", () => {
    expect(stripMaskedSecretValues({
      SUPABASE_URL: "********",
      SUPABASE_SERVICE_ROLE_KEY: "header.payload.signature",
    })).toEqual({
      SUPABASE_SERVICE_ROLE_KEY: "header.payload.signature",
    });
  });

  test("normalizes fallback tenant env with routing variables", () => {
    expect(normalizeTenantEnv("proj_1", {
      SUPABASE_URL: "https://api.example.com",
    })).toEqual(expect.objectContaining({
      SUPABASE_URL: "https://api.example.com",
      SUPACLOUD_PROJECT_REF: "proj_1",
      X_PROJECT_REF: "proj_1",
      SUPACLOUD_PROJECT_API_HOST: "api.example.com",
      SUPACLOUD_INTERNAL_SUPABASE_URL: "http://127.0.0.1",
      SUPACLOUD_INTERNAL_AUTH_URL: "http://127.0.0.1/auth/v1",
      SUPACLOUD_INTERNAL_REST_URL: "http://127.0.0.1/rest/v1",
    }));
  });

  test("invalidates cached runtime env for a project", async () => {
    const originalFetch = globalThis.fetch;
    const ref = `proj_cache_${Date.now()}`;
    let endpoint = "http://old-s3.local";
    let calls = 0;

    globalThis.fetch = mock(() => {
      calls++;
      return Promise.resolve(Response.json({ RESULT_S3_ENDPOINT: endpoint }));
    }) as unknown as typeof fetch;

    try {
      const first = await loadTenantEnv(ref);
      endpoint = "http://new-s3.local";
      const cached = await loadTenantEnv(ref);
      invalidateTenantEnvCache(ref);
      const fresh = await loadTenantEnv(ref);

      expect(first.RESULT_S3_ENDPOINT).toBe("http://old-s3.local");
      expect(cached.RESULT_S3_ENDPOINT).toBe("http://old-s3.local");
      expect(fresh.RESULT_S3_ENDPOINT).toBe("http://new-s3.local");
      expect(calls).toBe(2);
    } finally {
      invalidateTenantEnvCache(ref);
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to legacy secrets endpoint when runtime env route is missing", async () => {
    const originalFetch = globalThis.fetch;
    const ref = `proj_legacy_${Date.now()}`;
    const urls: string[] = [];

    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);

      if (url.includes("/internal/runtime-env")) {
        return Promise.resolve(Response.json({ message: "Route not found" }, { status: 404 }));
      }

      return Promise.resolve(Response.json([
        { name: "RESULT_S3_ENDPOINT", value: "http://legacy-s3.local" },
        { name: "MASKED_SECRET", value: "********" },
      ]));
    }) as unknown as typeof fetch;

    try {
      const env = await loadTenantEnv(ref);
      const cached = await loadTenantEnv(ref);

      expect(env.RESULT_S3_ENDPOINT).toBe("http://legacy-s3.local");
      expect(env.MASKED_SECRET).toBeUndefined();
      expect(cached.RESULT_S3_ENDPOINT).toBe("http://legacy-s3.local");
      expect(urls).toEqual([
        expect.stringContaining("/internal/runtime-env"),
        expect.stringContaining("/secrets?reveal=true"),
      ]);
    } finally {
      invalidateTenantEnvCache(ref);
      globalThis.fetch = originalFetch;
    }
  });

  test("caches fallback env when management API is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    const ref = `proj_api_down_${Date.now()}`;
    let calls = 0;

    globalThis.fetch = mock(() => {
      calls++;
      return Promise.reject(new Error("connection refused"));
    }) as unknown as typeof fetch;

    try {
      const first = await loadTenantEnv(ref);
      const second = await loadTenantEnv(ref);

      expect(first.SUPACLOUD_PROJECT_REF).toBe(ref);
      expect(second.SUPACLOUD_PROJECT_REF).toBe(ref);
      expect(calls).toBe(1);
    } finally {
      invalidateTenantEnvCache(ref);
      globalThis.fetch = originalFetch;
    }
  });
});
