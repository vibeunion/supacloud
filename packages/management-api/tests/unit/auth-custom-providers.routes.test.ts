import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { authCustomProviderRoutes } from "../../src/routes/auth-custom-providers";
import { projectService } from "../../src/services";

const app = new Elysia().use(authCustomProviderRoutes);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function project() {
  return {
    id: "project-id",
    ref: "proj_1",
    name: "Project",
    organization_id: "org_1",
    db_name: "postgres",
    db_user: "postgres",
    db_password: "secret",
    jwt_secret: "jwt-secret-with-at-least-32-characters",
    anon_key: "anon",
    service_role_key: "service-role",
    s3_bucket: null,
    s3_access_key: null,
    s3_secret_key: null,
    region: "local",
    status: "active",
    config: { postgrest_port: 3321, gotrue_port: 4321 },
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  } as never;
}

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: { Authorization: "Bearer dev-master-token", ...(init.headers || {}) },
  }));
}

describe("custom OAuth/OIDC provider management", () => {
  test("requires project authentication", async () => {
    const response = await app.handle(new Request("http://localhost/v1/projects/proj_1/auth/custom-providers"));
    expect(response.status).toBe(401);
  });

  test("preserves GoTrue list filtering, status and response body", async () => {
    spyOn(projectService, "getProject").mockResolvedValue(project());
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("http://127.0.0.1:4321/admin/custom-providers?type=oidc");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer service-role");
      expect(headers.get("apikey")).toBe("service-role");
      return Response.json({ providers: [{ identifier: "custom:workos", provider_type: "oidc" }] });
    }) as typeof fetch;

    const response = await request("/v1/projects/proj_1/auth/custom-providers?type=oidc");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: [{ identifier: "custom:workos", provider_type: "oidc" }] });
  });

  test("forwards create, update and delete without exposing or rewriting secrets", async () => {
    spyOn(projectService, "getProject").mockResolvedValue(project());
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      if (init?.method === "POST") return Response.json({ identifier: "custom:workos" }, { status: 201 });
      if (init?.method === "PUT") return Response.json({ identifier: "custom:workos", enabled: false });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const createBody = {
      provider_type: "oidc",
      identifier: "custom:workos",
      name: "WorkOS",
      client_id: "client-id",
      client_secret: "client-secret",
      scopes: ["openid", "email"],
      issuer: "https://issuer.example.com",
    };
    const created = await request("/v1/projects/proj_1/auth/custom-providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(created.status).toBe(201);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(createBody);

    const updated = await request("/v1/projects/proj_1/auth/custom-providers/custom%3Aworkos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(updated.status).toBe(200);
    expect(calls[1]?.url).toBe("http://127.0.0.1:4321/admin/custom-providers/custom%3Aworkos");

    const deleted = await request("/v1/projects/proj_1/auth/custom-providers/custom%3Aworkos", { method: "DELETE" });
    expect(deleted.status).toBe(204);
  });

  test("maps transport failures to a stable service-unavailable response", async () => {
    spyOn(projectService, "getProject").mockResolvedValue(project());
    globalThis.fetch = mock(async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const response = await request("/v1/projects/proj_1/auth/custom-providers");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      reason_code: "gotrue_custom_oauth_unavailable",
    });
  });
});
