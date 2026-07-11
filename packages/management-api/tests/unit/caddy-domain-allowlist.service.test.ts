import { describe, expect, test } from "bun:test";
import { createCaddyDomainAllowlistService } from "../../src/services/caddy-domain-allowlist.service";

describe("CaddyDomainAllowlistService", () => {
  test("allows exact canonical/custom domains but rejects an unregistered base-domain subdomain", async () => {
    const service = createCaddyDomainAllowlistService({
      baseDomain: "example.com",
      blockedDomains: [],
      loadProjects: async () => [{
        ref: "proj123",
        config: {
          custom_domain: "customer.example.net",
          additional_api_domains: ["api.alt.example.org"],
        },
      }],
      isPersistedRouteDomain: async () => false,
      isFrontendDomain: async () => false,
    });

    await expect(service.authorize("proj123.api.example.com")).resolves.toMatchObject({ allowed: true });
    await expect(service.authorize("api.customer.example.net")).resolves.toMatchObject({ allowed: true });
    await expect(service.authorize("api.alt.example.org")).resolves.toMatchObject({ allowed: true });
    await expect(service.authorize("unregistered.example.com")).resolves.toMatchObject({
      allowed: false,
      status: 403,
      reason: "not_registered",
    });
  });

  test("rate limits repeated unknown-domain authorization attempts", async () => {
    let timestamp = 1_000;
    let projectLoads = 0;
    const service = createCaddyDomainAllowlistService({
      baseDomain: "example.com",
      blockedDomains: [],
      loadProjects: async () => {
        projectLoads += 1;
        return [];
      },
      isPersistedRouteDomain: async () => false,
      isFrontendDomain: async () => false,
      unknownDomainLimit: 2,
      unknownDomainWindowMs: 60_000,
      now: () => timestamp,
    });

    await expect(service.authorize("unknown.example.net")).resolves.toMatchObject({ status: 403 });
    await expect(service.authorize("unknown.example.net")).resolves.toMatchObject({ status: 403 });
    await expect(service.authorize("unknown.example.net")).resolves.toMatchObject({
      status: 429,
      reason: "quota_exceeded",
      retryAfterSeconds: 60,
    });
    expect(projectLoads).toBe(3);

    timestamp += 60_001;
    await expect(service.authorize("unknown.example.net")).resolves.toMatchObject({ status: 403 });
  });

  test("applies a global quota so rotating unknown domains cannot bypass the guard", async () => {
    const service = createCaddyDomainAllowlistService({
      baseDomain: "example.com",
      blockedDomains: [],
      loadProjects: async () => [],
      isPersistedRouteDomain: async () => false,
      isFrontendDomain: async () => false,
      unknownDomainLimit: 50,
      unknownGlobalLimit: 2,
      unknownDomainWindowMs: 60_000,
      now: () => 10_000,
    });

    await expect(service.authorize("unknown-a.example.net")).resolves.toMatchObject({ status: 403 });
    await expect(service.authorize("unknown-b.example.net")).resolves.toMatchObject({ status: 403 });
    await expect(service.authorize("unknown-c.example.net")).resolves.toMatchObject({
      status: 429,
      reason: "quota_exceeded",
    });
  });

  test("never lets an exhausted unknown-domain quota block an exact registered domain", async () => {
    let projects = [] as Array<{ ref: string; config: unknown }>;
    const service = createCaddyDomainAllowlistService({
      baseDomain: "example.com",
      blockedDomains: [],
      loadProjects: async () => projects,
      isPersistedRouteDomain: async () => false,
      isFrontendDomain: async () => false,
      unknownDomainLimit: 1,
      unknownGlobalLimit: 1,
      unknownDomainWindowMs: 60_000,
      now: () => 10_000,
    });

    await expect(service.authorize("unknown.example.net")).resolves.toMatchObject({ status: 403 });
    projects = [{ ref: "newproj", config: { custom_domain: "customer.example.net" } }];

    await expect(service.authorize("api.customer.example.net")).resolves.toMatchObject({
      allowed: true,
      reason: "project",
    });
  });

  test("normalizes an api-prefixed platform base domain before matching project hosts", async () => {
    const service = createCaddyDomainAllowlistService({
      baseDomain: "api.example.com",
      blockedDomains: [],
      loadProjects: async () => [{ ref: "proj123", config: {} }],
      isPersistedRouteDomain: async () => false,
      isFrontendDomain: async () => false,
    });

    await expect(service.authorize("proj123.api.example.com")).resolves.toMatchObject({
      allowed: true,
      reason: "project",
    });
    await expect(service.authorize("proj123.api.api.example.com")).resolves.toMatchObject({
      allowed: false,
      reason: "not_registered",
    });
  });
});
