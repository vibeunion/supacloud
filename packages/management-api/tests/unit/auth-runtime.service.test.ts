import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../src/config";
import {
  getAuthRuntimeDescriptor,
  getAuthRuntimeManagedError,
  getAuthRuntimeOwnerProtectionError,
  isSharedAuthRuntime,
  sanitizeSharedProjectConfig,
} from "../../src/services/auth-runtime.service";

const originalOwnerRef = config.authRuntimeOwnerRef;

afterEach(() => {
  config.authRuntimeOwnerRef = originalOwnerRef;
});

describe("SupAuth runtime ownership", () => {
  test("keeps every project local when no owner is configured", () => {
    config.authRuntimeOwnerRef = "";

    expect(isSharedAuthRuntime("tenant-a")).toBe(false);
    expect(getAuthRuntimeDescriptor("tenant-a")).toEqual({
      project_ref: "tenant-a",
      mode: "local",
      authority_project_ref: "tenant-a",
      owner_project_ref: null,
      local_gotrue_enabled: true,
      public_auth_route: "local_gotrue",
      user_management: "local",
      configuration_management: "local",
      local_membership_source: "project_database",
      realtime_auth_supported: true,
      owner_management_path: null,
    });
  });

  test("keeps the SupAuth owner local and makes dependent projects shared", () => {
    config.authRuntimeOwnerRef = "auth-owner";

    expect(isSharedAuthRuntime("auth-owner")).toBe(false);
    const owner = getAuthRuntimeDescriptor("auth-owner");
    expect(owner.mode).toBe("owner");
    expect(owner.owner_project_ref).toBe("auth-owner");
    expect(owner.local_gotrue_enabled).toBe(true);
    expect(owner.user_management).toBe("local");

    const dependent = getAuthRuntimeDescriptor("tenant-a");
    expect(dependent.mode).toBe("shared");
    expect(dependent.authority_project_ref).toBe("auth-owner");
    expect(dependent.local_gotrue_enabled).toBe(false);
    expect(dependent.public_auth_route).toBe("owner_proxy");
    expect(dependent.user_management).toBe("owner_only");
    expect(dependent.configuration_management).toBe("owner_only");
    expect(dependent.realtime_auth_supported).toBe(false);
    expect(dependent.owner_management_path).toBe("/project/auth-owner/auth");
  });

  test("returns a structured conflict for dependent project management", () => {
    config.authRuntimeOwnerRef = "auth-owner";

    expect(getAuthRuntimeManagedError("auth-owner", "users")).toBeNull();
    expect(getAuthRuntimeManagedError("tenant-a", "users")).toEqual({
      code: "AUTH_RUNTIME_MANAGED_BY_OWNER",
      message: "This project's users are managed by the SupAuth owner project. Local GoTrue is disabled for tenant-a.",
      project_ref: "tenant-a",
      authority_project_ref: "auth-owner",
      owner_project_ref: "auth-owner",
      owner_management_path: "/project/auth-owner/auth",
      public_auth_route: "owner_proxy",
      local_membership_source: "project_database",
      realtime_auth_supported: false,
    });
  });

  test("removes auth configuration from shared dependent project responses", () => {
    config.authRuntimeOwnerRef = "auth-owner";

    expect(sanitizeSharedProjectConfig("tenant-a", {
      api_url: "https://api.example.com",
      auth: { smtp: { pass: "private" }, oauth_server: { jwt_keys: ["private"] } },
    })).toEqual({ api_url: "https://api.example.com" });
    expect(sanitizeSharedProjectConfig("auth-owner", {
      auth: { oauth_server: { issuer: "https://auth-owner.example.com" } },
    })).toEqual({
      auth: { oauth_server: { issuer: "https://auth-owner.example.com" } },
    });
  });

  test("protects the configured owner from pause and deletion", () => {
    config.authRuntimeOwnerRef = "auth-owner";
    expect(getAuthRuntimeOwnerProtectionError("tenant-a", "pause")).toBeNull();
    expect(getAuthRuntimeOwnerProtectionError("auth-owner", "pause")).toMatchObject({
      code: "AUTH_RUNTIME_OWNER_REQUIRED",
      required_operator_action: "disable_supauth_or_migrate_dependents",
    });
    expect(getAuthRuntimeOwnerProtectionError("auth-owner", "delete")?.message).toContain("Cannot delete");
  });
});
