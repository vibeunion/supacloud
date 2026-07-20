import { createHmac } from "node:crypto";
import { describe, expect, mock, test } from "bun:test";
import { organizationJitCapabilityFromRuntime } from "../../src/services/organization-jit-capability.service";

const projectConfig = {
  api_domain: "api.project.example",
  auth_domain: "auth.project.example",
};
const signingKey = Buffer.from("standard-webhooks-test-key");
const encodedSecret = signingKey.toString("base64");

function runtimeEnvironment(overrides: Record<string, string> = {}) {
  return {
    GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED: "true",
    GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI:
      "https://api.project.example/functions/v1/supauth/api/v1/auth-hooks/custom-access-token",
    GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS: `v1,whsec_${encodedSecret}`,
    ...overrides,
  };
}

function verifiedProbe(): typeof fetch {
  return mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body);
    const webhookId = headers.get("webhook-id") || "";
    const timestamp = headers.get("webhook-timestamp") || "";
    const signature = createHmac("sha256", signingKey)
      .update(`${webhookId}.${timestamp}.${body}`)
      .digest("base64");
    expect(headers.get("webhook-signature")).toBe(`v1,${signature}`);
    return new Response(JSON.stringify({
      supaoauth_hook_probe: {
        verified: true,
        protocol: "standard-webhooks-v1",
        hook_name: "custom-access-token",
        project_ref: "proj_1",
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("organization JIT runtime capability evidence", () => {
  test("is available only after a signed probe reaches the exact stock GoTrue hook target", async () => {
    expect(await organizationJitCapabilityFromRuntime({
      projectRef: "proj_1",
      projectConfig,
      environment: runtimeEnvironment(),
    }, verifiedProbe())).toEqual({
      available: true,
      version: "gotrue-standard-webhooks-v1",
      reason_code: null,
    });
  });

  test("rejects configuration intent without a live enabled process environment", async () => {
    expect(await organizationJitCapabilityFromRuntime({
      projectRef: "proj_1",
      projectConfig,
      environment: runtimeEnvironment({ GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED: "false" }),
    })).toMatchObject({
      available: false,
      reason_code: "gotrue_custom_access_token_hook_not_enabled",
    });
  });

  test("rejects a hook target belonging to another project", async () => {
    expect(await organizationJitCapabilityFromRuntime({
      projectRef: "proj_1",
      projectConfig,
      environment: runtimeEnvironment({
        GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI:
          "https://api.other.example/v1/auth-hooks/custom-access-token",
      }),
    })).toMatchObject({
      available: false,
      reason_code: "gotrue_custom_access_token_hook_target_mismatch",
    });
  });

  test("rejects missing and non-GoTrue secret formats", async () => {
    expect(await organizationJitCapabilityFromRuntime({
      projectRef: "proj_1",
      projectConfig,
      environment: runtimeEnvironment({ GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS: "" }),
    })).toMatchObject({
      available: false,
      reason_code: "gotrue_custom_access_token_hook_secret_missing",
    });
    expect(await organizationJitCapabilityFromRuntime({
      projectRef: "proj_1",
      projectConfig,
      environment: runtimeEnvironment({ GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS: "plain-text" }),
    })).toMatchObject({
      available: false,
      reason_code: "gotrue_custom_access_token_hook_secret_invalid",
    });
  });

  test("keeps capability unavailable when the live signed probe is rejected", async () => {
    const rejectedProbe = mock(async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
    expect(await organizationJitCapabilityFromRuntime({
      projectRef: "proj_1",
      projectConfig,
      environment: runtimeEnvironment(),
    }, rejectedProbe)).toEqual({
      available: false,
      version: null,
      reason_code: "gotrue_custom_access_token_hook_probe_rejected",
    });
  });
});
