// @supacloud-test-isolate
import { afterEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

const project = { ref: "proj_1", config: { gotrue_port: 4321 } };
const getProject = mock(async () => project);
const resolveProjectServiceRoleKey = mock(async () => "service-role");

mock.module("../../src/services", () => ({ projectService: { getProject } }));
mock.module("../../src/utils/service-role", () => ({ resolveProjectServiceRoleKey }));

const { authSsoRoutes } = await import("../../src/routes/auth-sso");
const app = new Elysia().use(authSsoRoutes);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.clearAllMocks();
});

function request(path: string, init: RequestInit = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: { Authorization: "Bearer dev-master-token", ...(init.headers || {}) },
  }));
}

describe("SAML provider management", () => {
  test("preserves the GoTrue list envelope and nullable disabled state", async () => {
    const provider = {
      id: "11111111-1111-4111-8111-111111111111",
      disabled: null,
      saml: { entity_id: "https://idp.example.test/entity" },
    };
    globalThis.fetch = mock(async () => Response.json({ items: [provider] })) as typeof fetch;

    const response = await request("/v1/projects/proj_1/auth/sso/providers");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [provider] });
    expect(resolveProjectServiceRoleKey).toHaveBeenCalledWith("proj_1");
  });

  test("forwards canonical create and update fields without stripping false or empty values", async () => {
    const upstreamRequests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      upstreamRequests.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "saml-provider" });
    }) as typeof fetch;

    const expectedCreateBody = {
      type: "saml",
      resource_id: "urn:example:sp",
      domains: ["example.com"],
      metadata_xml: "<EntityDescriptor />",
      attribute_mapping: { email: "mail" },
      name_id_format: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      disabled: false,
    };
    const created = await request("/v1/projects/proj_1/auth/sso/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...expectedCreateBody, ignored: "strip-me" }),
    });
    expect(created.status).toBe(200);
    expect(upstreamRequests[0]).toEqual({
      url: "http://127.0.0.1:4321/admin/sso/providers",
      body: expectedCreateBody,
    });

    const updateBody = { type: "saml", disabled: true, name_id_format: "" };
    const updated = await request("/v1/projects/proj_1/auth/sso/providers/saml-provider", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(updateBody),
    });
    expect(updated.status).toBe(200);
    expect(upstreamRequests[1]).toEqual({
      url: "http://127.0.0.1:4321/admin/sso/providers/saml-provider",
      body: updateBody,
    });
  });

  test("rejects create requests without the required SAML type", async () => {
    const upstreamFetch = mock(async () => Response.json({ id: "unexpected" }));
    globalThis.fetch = upstreamFetch as typeof fetch;

    const missingType = await request("/v1/projects/proj_1/auth/sso/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata_url: "https://idp.example.com/metadata" }),
    });
    const invalidType = await request("/v1/projects/proj_1/auth/sso/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "oidc", metadata_url: "https://idp.example.com/metadata" }),
    });

    expect(missingType.status).toBe(422);
    expect(invalidType.status).toBe(422);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
