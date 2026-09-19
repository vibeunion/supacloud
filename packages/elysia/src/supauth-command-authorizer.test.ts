import { describe, expect, it } from "bun:test";
import { ApplicationError, createCommandAuthorizationAdapter, type CommandInvocation } from "./index";

const invocation = (permission: string, subject = "user-1"): CommandInvocation => ({
  command: { className: "UpdateCase", name: "case.update", permission },
  input: { body: {}, params: {}, query: {} },
  request: new Request("https://example.test"),
  requestContext: {
    identity: { authenticated: true, subject, accessToken: "token" },
  },
  services: {},
});

describe("command authorization adapter", () => {
  it("maps trusted identity and allows a catalog-bound grant", async () => {
    const requests: unknown[] = [];
    const authorize = createCommandAuthorizationAdapter({
      applicationId: "xigu-fa", issuer: "https://auth.example.test",
      domain: () => ({ type: "organization", id: "org-1" }),
      catalog: { version: "2026-09-18", digest: "a".repeat(64) },
      resolve: async request => {
        requests.push(request);
        return {
          applicationId: "xigu-fa", permissions: ["case:update"],
          permissionCatalogVersion: "2026-09-18", permissionCatalogDigest: "a".repeat(64),
        };
      },
    });
    await expect(authorize(invocation("case:update"))).resolves.toBeUndefined();
    expect(requests).toEqual([{
      principal: { kind: "user", issuer: "https://auth.example.test", subject: "user-1" },
      applicationId: "xigu-fa", domain: { type: "organization", id: "org-1" },
    }]);
  });

  it("fails closed for missing identity, unavailable resolver, and denied permission", async () => {
    const options = {
      applicationId: "xigu-fa", issuer: "issuer", domain: () => ({ type: "organization", id: "org-1" }),
      resolve: async () => ({ applicationId: "xigu-fa", permissions: [] }),
    };
    await expect(createCommandAuthorizationAdapter(options)(invocation("case:update")))
      .rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
    await expect(createCommandAuthorizationAdapter(options)({ ...invocation("case:update"), requestContext: {} }))
      .rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
    await expect(createCommandAuthorizationAdapter({ ...options, resolve: async () => { throw new Error("down"); } })(invocation("case:update")))
      .rejects.toMatchObject({ status: 503, code: "AUTHORIZATION_UNAVAILABLE" });
    expect(new ApplicationError("x").status).toBe(500);
  });
});
