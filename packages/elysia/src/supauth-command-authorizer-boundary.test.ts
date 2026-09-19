import { describe, expect, it } from "bun:test";
import {
  createCommandAuthorizationAdapter,
  createCommandExecutor,
  type CommandAuthorizationContext,
  type CommandGovernance,
  type CommandInvocation,
} from "./index";

const catalog = { version: "catalog-v1", digest: "a".repeat(64) };
const validContext: CommandAuthorizationContext = {
  applicationId: "app-1",
  permissions: ["case:update"],
  permissionCatalogVersion: catalog.version,
  permissionCatalogDigest: catalog.digest,
};
const invocation: CommandInvocation = {
  command: {
    className: "UpdateCase", name: "case.update", permission: "case:update",
    audit: "case.updated", transaction: "required", idempotency: "required",
  },
  input: { body: {}, params: {}, query: {} },
  request: new Request("https://example.test/cases"),
  requestContext: { identity: { authenticated: true, subject: "user-1", accessToken: "token" } },
  services: {},
};

// Deliberately cross the runtime boundary with untyped upstream data.
function authorizer(value: unknown, onResolve: () => void = () => {}) {
  return createCommandAuthorizationAdapter({
    applicationId: "app-1", issuer: "https://auth.example.test",
    domain: () => ({ type: "organization", id: "org-1" }),
    catalog,
    resolve: async () => {
      onResolve();
      return value as CommandAuthorizationContext;
    },
  });
}

describe("command authorization runtime boundary", () => {
  const malformed: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["array context", []],
    ["missing permissions", { ...validContext, permissions: undefined }],
    ["null permissions", { ...validContext, permissions: null }],
    ["string exact grant", { ...validContext, permissions: "case:update" }],
    ["string substring grant", { ...validContext, permissions: "case:update-other" }],
    ["custom includes method", { ...validContext, permissions: { includes: () => true } }],
    ["mixed permission types", { ...validContext, permissions: ["case:update", 1] }],
    ["non-string catalog version", { ...validContext, permissionCatalogVersion: 1 }],
    ["non-string catalog digest", { ...validContext, permissionCatalogDigest: [] }],
  ];
  for (const [name, value] of malformed) {
    it(`rejects ${name} with a normalized unavailable response`, async () => {
      await expect(authorizer(value)(invocation)).rejects.toMatchObject({
        status: 503, code: "AUTHORIZATION_CONTEXT_INVALID",
      });
    });
  }

  const mismatches: [string, CommandAuthorizationContext][] = [
    ["application", { ...validContext, applicationId: "app-2" }],
    ["version", { ...validContext, permissionCatalogVersion: "catalog-v2" }],
    ["digest", { ...validContext, permissionCatalogDigest: "b".repeat(64) }],
    ["missing catalog", { applicationId: "app-1", permissions: ["case:update"] }],
  ];
  for (const [name, value] of mismatches) {
    it(`rejects a ${name} binding mismatch even when the permission is granted`, async () => {
      await expect(authorizer(value)(invocation)).rejects.toMatchObject({
        status: 503, code: "AUTHORIZATION_CONTEXT_INVALID",
      });
    });
  }

  it("requires an exact permission entry, not a substring or wildcard", async () => {
    for (const permissions of [[], ["case:update-other"], ["case:*"], ["*"]]) {
      await expect(authorizer({ ...validContext, permissions })(invocation)).rejects.toMatchObject({
        status: 403, code: "PERMISSION_DENIED",
      });
    }
    await expect(authorizer(validContext)(invocation)).resolves.toBeUndefined();
  });

  it("does not call the resolver for untrusted identity or malformed command metadata", async () => {
    let resolves = 0;
    const authorize = authorizer(validContext, () => { resolves++; });
    for (const identity of [
      undefined,
      { authenticated: false, subject: "user-1", accessToken: "token" },
      { authenticated: true, subject: "", accessToken: "token" },
      { authenticated: true, subject: "user-1" },
    ]) {
      await expect(authorize({ ...invocation, requestContext: { identity } })).rejects.toMatchObject({
        status: 401, code: "AUTHENTICATION_REQUIRED",
      });
    }
    await expect(authorize({
      ...invocation, command: { ...invocation.command, permission: "case.update" },
    })).rejects.toMatchObject({ status: 500, code: "COMMAND_PERMISSION_INVALID" });
    expect(resolves).toBe(0);
  });

  for (const rpc of [false, true]) {
    it(`blocks business execution for invalid grants on the ${rpc ? "RPC" : "local"} pipeline`, async () => {
      const events: string[] = [];
      const governance: CommandGovernance = {
        authorize: authorizer({ ...validContext, permissions: "case:update-other" }),
        idempotency: async (_invocation, next) => { events.push("receipt"); return next(); },
        transaction: async (_invocation, next) => { events.push("transaction"); return next(); },
        audit: {
          succeeded: () => { events.push("business-audit"); },
          // Failed authorization may be recorded separately; it is not a business commit.
          failed: () => {},
        },
        rpc: {
          update_case: {
            capabilities: { boundary: "database", audit: true, transaction: true, idempotency: true },
            execute: async (_invocation, next) => { events.push("rpc"); return next(); },
          },
        },
      };
      await expect(createCommandExecutor(governance)({
        ...invocation,
        command: { ...invocation.command, ...(rpc ? { rpc: "update_case" } : {}) },
      }, () => { events.push("handler"); })).rejects.toMatchObject({
        status: 503, code: "AUTHORIZATION_CONTEXT_INVALID",
      });
      expect(events).toEqual([]);
    });
  }
});
