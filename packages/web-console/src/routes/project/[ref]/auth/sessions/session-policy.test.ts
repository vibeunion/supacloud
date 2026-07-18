import { describe, expect, test } from "bun:test";
import {
  buildSessionPolicyPatch,
  cloneSessionDraft,
  dependentStatusLabel,
  emptySessionDraft,
  normalizeSessionConfig,
  parseAuthManagedBoundary,
  parsePersistedApplyWarning,
  parseSessionConfigResponse,
  resolveSessionSaveDirective,
  SessionPolicyInputError,
  SessionPolicyResponseError,
} from "./session-policy";

describe("session policy truth", () => {
  test("normalizes canonical effective policy values", () => {
    expect(parseSessionConfigResponse({
      jwt_expiry: 3600,
      refresh_token_rotation_enabled: true,
      security_refresh_token_reuse_interval: 10,
      sessions_inactivity_timeout: null,
      sessions_single_per_user: false,
      sessions_timebox: 86_400,
    })).toEqual({
      jwtExpiry: "3600",
      rotationEnabled: "true",
      reuseInterval: "10",
      inactivityMode: "disabled",
      inactivityTimeout: "",
      singlePerUser: "false",
      timeboxMode: "enabled",
      timebox: "86400",
    });
  });

  test("reads legacy aliases only when canonical fields are absent", () => {
    expect(parseSessionConfigResponse({
      data: {
        jwt_exp: 7200,
        security_refresh_token_rotation_enabled: false,
        security_refresh_token_rotation_reuse_interval: 17,
        sessions_inactivity_timeout: "30m",
      },
    })).toMatchObject({
      jwtExpiry: "7200",
      rotationEnabled: "false",
      reuseInterval: "17",
      inactivityMode: "enabled",
      inactivityTimeout: "1800",
    });

    expect(normalizeSessionConfig({
      jwt_expiry: 5400,
      jwt_exp: 7200,
      refresh_token_rotation_enabled: true,
      security_refresh_token_rotation_enabled: false,
    })).toMatchObject({ jwtExpiry: "5400", rotationEnabled: "true" });
  });

  test("rejects malformed canonical success payloads", () => {
    expect(() => parseSessionConfigResponse({})).toThrow(SessionPolicyResponseError);
    expect(() => parseSessionConfigResponse({ data: { message: "unexpected success envelope" } }))
      .toThrow(SessionPolicyResponseError);
    expect(() => parseSessionConfigResponse({
      jwt_expiry: { seconds: 3600 },
      refresh_token_rotation_enabled: true,
    })).toThrow(SessionPolicyResponseError);
    expect(() => parseSessionConfigResponse({
      jwt_expiry: null,
      refresh_token_rotation_enabled: true,
    })).toThrow(SessionPolicyResponseError);
    expect(() => parseSessionConfigResponse({ jwt_expiry: 3600 }))
      .toThrow(/refresh_token_rotation_enabled/);
  });

  test("builds a minimal canonical PATCH", () => {
    const baseline = normalizeSessionConfig({
      jwt_expiry: 3600,
      refresh_token_rotation_enabled: true,
      security_refresh_token_reuse_interval: 10,
      sessions_inactivity_timeout: null,
      sessions_single_per_user: false,
      sessions_timebox: null,
    });
    const draft = cloneSessionDraft(baseline);
    draft.rotationEnabled = "false";
    draft.timeboxMode = "enabled";
    draft.timebox = "86400";

    expect(buildSessionPolicyPatch(draft, baseline)).toEqual({
      refresh_token_rotation_enabled: false,
      sessions_timebox: 86_400,
    });
  });

  test("rejects invalid user duration without weakening the PATCH", () => {
    const baseline = emptySessionDraft();
    const draft = cloneSessionDraft(baseline);
    draft.inactivityMode = "enabled";
    draft.inactivityTimeout = "0";
    expect(() => buildSessionPolicyPatch(draft, baseline)).toThrow(SessionPolicyInputError);
  });

  test("preserves structured persisted apply failures", () => {
    expect(parsePersistedApplyWarning({
      code: "SUPAUTH_DEPENDENT_REFRESH_FAILED",
      message: "saved, but dependents failed",
      persisted: true,
      runtime_applied: true,
      dependents_applied: false,
      dependent_status: "failed",
      failed_dependents: ["tenant-a", "tenant-b"],
      authority_project_ref: "auth-owner",
    })).toEqual({
      code: "SUPAUTH_DEPENDENT_REFRESH_FAILED",
      message: "saved, but dependents failed",
      runtimeApplied: true,
      dependentsApplied: false,
      dependentStatus: "failed",
      failedDependents: ["tenant-a", "tenant-b"],
      authorityProjectRef: "auth-owner",
    });
    expect(parsePersistedApplyWarning({ persisted: false })).toBeNull();
  });

  test("distinguishes unknown, failed, and applied dependent states", () => {
    const unknownWarning = parsePersistedApplyWarning({
      persisted: true,
      runtime_applied: true,
      dependents_applied: false,
      dependent_status: "unknown",
      failed_dependents: [],
    });
    const appliedWarning = parsePersistedApplyWarning({
      persisted: true,
      runtime_applied: true,
      dependents_applied: true,
      dependent_status: "applied",
    });

    expect(unknownWarning?.dependentStatus).toBe("unknown");
    expect(appliedWarning?.dependentStatus).toBe("applied");
    expect(dependentStatusLabel("unknown")).toBe("状态未知");
    expect(dependentStatusLabel("failed")).toBe("存在失败");
    expect(dependentStatusLabel("applied")).toBe("已刷新");
  });

  test("requires canonical read-back after a persisted 503", () => {
    expect(resolveSessionSaveDirective({
      ok: false,
      status: 503,
      payload: {
        code: "AUTH_RUNTIME_APPLY_FAILED",
        message: "saved, but runtime apply failed",
        persisted: true,
        runtime_applied: false,
      },
    })).toEqual({
      kind: "partial",
      requiresReadBack: true,
      warning: {
        code: "AUTH_RUNTIME_APPLY_FAILED",
        message: "saved, but runtime apply failed",
        runtimeApplied: false,
        dependentsApplied: null,
        dependentStatus: null,
        failedDependents: [],
        authorityProjectRef: null,
      },
    });
  });

  test("parses the backend owner-managed boundary", () => {
    expect(parseAuthManagedBoundary({
      code: "AUTH_RUNTIME_MANAGED_BY_OWNER",
      message: "managed by owner",
      authority_project_ref: "auth-owner",
      owner_management_path: "/project/auth-owner/auth",
    })).toEqual({
      message: "managed by owner",
      authorityProjectRef: "auth-owner",
      ownerManagementPath: "/project/auth-owner/auth",
    });
  });
});
