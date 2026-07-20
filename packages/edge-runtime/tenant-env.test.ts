import { describe, expect, mock, test } from "bun:test";
import {
  invalidateTenantEnvCache,
  isMaskedSecretValue,
  buildFallbackTenantEnv,
  loadTenantEnv,
  mergeTenantRuntimeEnv,
  normalizeTenantEnv,
  stripMaskedSecretValues,
  withBackgroundInternalToken,
} from "./tenant-env";
import { readEdgeRuntimeProjectSecrets } from "./jwt-verifier";

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

  test("shared mode drops stale verifier secrets before function injection", () => {
    const env = normalizeTenantEnv("proj_1", {
      SUPACLOUD_AUTH_RUNTIME_MODE: "shared",
      SUPACLOUD_AUTH_ISSUER: "https://auth-owner.example.com/auth/v1",
      JWT_JWKS: '{"keys":[{"kid":"owner-key"}]}',
      JWT_SECRET: "stale-dependent-secret",
      JWT_KEYS: "stale-private-keys",
      SUPACLOUD_THIRD_PARTY_JWT_POLICY: "stale-dependent-policy",
    });

    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.JWT_KEYS).toBeUndefined();
    expect(env.SUPACLOUD_THIRD_PARTY_JWT_POLICY).toBeUndefined();
    expect(env.JWT_JWKS).toContain("owner-key");
    expect(env.SUPACLOUD_AUTH_RUNTIME_MODE).toBe("shared");
    expect(env.SUPACLOUD_AUTH_ISSUER).toBe("https://auth-owner.example.com/auth/v1");
  });

  test("unknown runtime mode strips verifier material from function env", () => {
    const env = normalizeTenantEnv("proj_1", {
      SUPACLOUD_AUTH_RUNTIME_MODE: "unexpected",
      SUPABASE_ANON_KEY: "anon-key",
      JWT_SECRET: "untrusted-secret",
      JWT_JWKS: '{"keys":[{"kid":"untrusted-key"}]}',
    });

    expect(env.SUPABASE_ANON_KEY).toBe("anon-key");
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.JWT_JWKS).toBeUndefined();
    expect(readEdgeRuntimeProjectSecrets(env)).toBeNull();
  });

  test("treats a successful runtime API response as authoritative for auth mode", () => {
    const env = mergeTenantRuntimeEnv("proj_1", {
      SUPACLOUD_AUTH_RUNTIME_MODE: "local",
      SUPACLOUD_AUTH_AUTHORITY_REF: "proj_1",
      JWT_SECRET: "stale-file-secret",
      JWT_JWKS: '{"keys":[{"kid":"stale-file-key"}]}',
    }, {
      SUPACLOUD_AUTH_ISSUER: "https://auth-owner.example.com/auth/v1",
      JWT_JWKS: '{"keys":[{"kid":"owner-key"}]}',
    });

    expect(env.SUPACLOUD_AUTH_RUNTIME_MODE).toBeUndefined();
    expect(env.SUPACLOUD_AUTH_AUTHORITY_REF).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.JWT_JWKS).toBeUndefined();
    expect(readEdgeRuntimeProjectSecrets(env)).toBeNull();
  });

  test("uses only API verifier material when the API provides an explicit mode", () => {
    const env = mergeTenantRuntimeEnv("proj_1", {
      SUPACLOUD_AUTH_RUNTIME_MODE: "local",
      JWT_SECRET: "stale-file-secret",
    }, {
      SUPACLOUD_AUTH_RUNTIME_MODE: "owner",
      JWT_SECRET: "current-api-secret",
    });

    expect(env.SUPACLOUD_AUTH_RUNTIME_MODE).toBe("owner");
    expect(env.JWT_SECRET).toBe("current-api-secret");
  });

  test("does not reuse cached verifier material when the runtime API is unavailable", () => {
    const env = buildFallbackTenantEnv("proj_1", {
      SUPACLOUD_AUTH_RUNTIME_MODE: "shared",
      SUPACLOUD_AUTH_ISSUER: "https://auth-owner.example.com/auth/v1",
      JWT_JWKS: '{"keys":[{"kid":"stale-file"}]}',
    }, {
      SUPACLOUD_AUTH_RUNTIME_MODE: "local",
      JWT_SECRET: "stale-cached-secret",
      JWT_JWKS: '{"keys":[{"kid":"stale-cache"}]}',
      SUPABASE_ANON_KEY: "cached-anon-key",
    });

    expect(env.SUPACLOUD_AUTH_RUNTIME_MODE).toBe("shared");
    expect(env.SUPACLOUD_AUTH_ISSUER).toBe("https://auth-owner.example.com/auth/v1");
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.JWT_JWKS).toBeUndefined();
    expect(env.SUPABASE_ANON_KEY).toBe("cached-anon-key");
  });

  test("keeps a trusted local file verifier when no stale cache is present", () => {
    const env = buildFallbackTenantEnv("proj_1", {
      SUPACLOUD_AUTH_RUNTIME_MODE: "local",
      JWT_SECRET: "local-file-secret",
      JWT_JWKS: '{"keys":[{"kid":"local-key"}]}',
    });

    expect(env.JWT_SECRET).toBe("local-file-secret");
    expect(env.JWT_JWKS).toContain("local-key");
  });

  test("does not expose the shared PostgREST legacy JWK through file fallback", () => {
    const env = buildFallbackTenantEnv("proj_1", {
      SUPACLOUD_AUTH_RUNTIME_MODE: "shared",
      SUPACLOUD_AUTH_ISSUER: "https://auth-owner.example.com/auth/v1",
      JWT_JWKS: '{"keys":[{"kty":"oct","kid":"legacy-hs256","k":"dependent"},{"kty":"EC","kid":"owner-key"}]}',
    });

    expect(env.JWT_JWKS).toBeUndefined();
    expect(env.SUPACLOUD_AUTH_RUNTIME_MODE).toBe("shared");
  });

  test("prefers tenant-local PostgREST port for internal REST fallback", () => {
    expect(normalizeTenantEnv("proj_1", {
      SUPABASE_URL: "https://api.example.com",
      SUPACLOUD_INTERNAL_POSTGREST_PORT: "3272",
    })).toEqual(expect.objectContaining({
      SUPACLOUD_INTERNAL_REST_URL: "http://127.0.0.1:3272",
      SUPACLOUD_INTERNAL_POSTGREST_PORT: "3272",
    }));
  });

  test("adds background internal token only for background dispatch env", () => {
    const base = normalizeTenantEnv("proj_1", {
      SUPABASE_URL: "https://api.example.com",
    });

    expect(base.SUPACLOUD_BACKGROUND_INTERNAL_TOKEN).toBeUndefined();
    expect(withBackgroundInternalToken(base, "")).toBe(base);
    expect(withBackgroundInternalToken(base, "runtime-token")).toEqual(
      expect.objectContaining({
        SUPABASE_URL: "https://api.example.com",
        SUPACLOUD_BACKGROUND_INTERNAL_TOKEN: "runtime-token",
      }),
    );
    expect(base.SUPACLOUD_BACKGROUND_INTERNAL_TOKEN).toBeUndefined();
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

  test("refuses the legacy public secrets endpoint when runtime env route is missing", async () => {
    const originalFetch = globalThis.fetch;
    const ref = `proj_legacy_${Date.now()}`;
    const urls: string[] = [];

    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);

      if (url.includes("/internal/runtime-env")) {
        return Promise.resolve(Response.json({ message: "Route not found" }, { status: 404 }));
      }

      throw new Error("public secrets endpoint must not be called");
    }) as unknown as typeof fetch;

    try {
      const env = await loadTenantEnv(ref);
      const cached = await loadTenantEnv(ref);

      expect(env.RESULT_S3_ENDPOINT).toBeUndefined();
      expect(env.SUPABASE_ANON_KEY).toBeUndefined();
      expect(env.JWT_SECRET).toBeUndefined();
      expect(env.SUPACLOUD_AUTH_RUNTIME_MODE).toBeUndefined();
      expect(env.MASKED_SECRET).toBeUndefined();
      expect(cached.RESULT_S3_ENDPOINT).toBeUndefined();
      expect(urls).toEqual([
        expect.stringContaining("/internal/runtime-env"),
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

  test("coalesces concurrent runtime env loads for the same project", async () => {
    const originalFetch = globalThis.fetch;
    const ref = `proj_inflight_${Date.now()}`;
    let calls = 0;
    let resolveResponse!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });

    globalThis.fetch = mock(async () => {
      calls++;
      await gate;
      return Response.json({ RESULT_S3_ENDPOINT: "http://coalesced-s3.local" });
    }) as unknown as typeof fetch;

    try {
      const first = loadTenantEnv(ref);
      const second = loadTenantEnv(ref);
      resolveResponse();
      const [firstEnv, secondEnv] = await Promise.all([first, second]);

      expect(firstEnv.RESULT_S3_ENDPOINT).toBe("http://coalesced-s3.local");
      expect(secondEnv.RESULT_S3_ENDPOINT).toBe("http://coalesced-s3.local");
      expect(calls).toBe(1);
    } finally {
      invalidateTenantEnvCache(ref);
      globalThis.fetch = originalFetch;
    }
  });
});
