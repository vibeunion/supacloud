import { describe, expect, test } from "bun:test";
import { DB_CLIENT, JOB_CONTEXT, REQUEST_CONTEXT } from "./context";
import { InjectionToken } from "./token";
import { isScopeViolation, SCOPE_LIFETIME_RANK } from "./scope";

describe("InjectionToken", () => {
  test("creates a named token without options", () => {
    const token = new InjectionToken<string>("app.name");
    expect(token.name).toBe("app.name");
    expect(token.factory).toBeUndefined();
    expect(token.scope).toBeUndefined();
    expect(token.toString()).toBe("InjectionToken app.name");
  });

  test("supports factory and scope options", () => {
    const factory = () => "hello";
    const token = new InjectionToken<string>("app.greeting", {
      factory,
      scope: "application",
    });
    expect(token.factory).toBe(factory);
    expect(token.scope).toBe("application");
  });

  test("carries its generic type", () => {
    interface Config {
      url: string;
    }
    const token = new InjectionToken<Config>("app.config");
    const config: Config = { url: "https://example.com" };
    const withFactory = new InjectionToken<Config>("app.config2", {
      factory: () => config,
    });
    expect(withFactory.factory?.().url).toBe("https://example.com");
  });
});

describe("built-in tokens", () => {
  test("DB_CLIENT defaults to application scope", () => {
    expect(DB_CLIENT.name).toBe("supacloud.db-client");
    expect(DB_CLIENT.scope).toBe("application");
  });

  test("context tokens carry request and job scope", () => {
    expect(REQUEST_CONTEXT.scope).toBe("request");
    expect(JOB_CONTEXT.scope).toBe("job");
  });
});

describe("scope rules", () => {
  test("application is the longest-lived scope", () => {
    expect(SCOPE_LIFETIME_RANK.application).toBeLessThan(SCOPE_LIFETIME_RANK.request);
    expect(SCOPE_LIFETIME_RANK.application).toBeLessThan(SCOPE_LIFETIME_RANK.job);
  });

  test("application provider must not depend on request/job providers", () => {
    expect(isScopeViolation("application", "request")).toBe(true);
    expect(isScopeViolation("application", "job")).toBe(true);
  });

  test("request/job providers may depend on application providers", () => {
    expect(isScopeViolation("request", "application")).toBe(false);
    expect(isScopeViolation("job", "application")).toBe(false);
  });

  test("same-scope dependencies are allowed", () => {
    expect(isScopeViolation("request", "request")).toBe(false);
    expect(isScopeViolation("job", "job")).toBe(false);
  });
});
