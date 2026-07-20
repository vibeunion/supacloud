import { createHmac } from "node:crypto";
import { describe, expect, mock, test } from "bun:test";
import { goTrueAuthHookStatusFromRuntime } from "../../src/services/gotrue-auth-hook-runtime.service";

const firstKey = Buffer.from("standard-webhooks-first-key");
const secondKey = Buffer.from("standard-webhooks-second-key");
const projectConfig = {
  api_domain: "api.project.example",
  auth_domain: "auth.project.example",
};

function secret(key: Buffer): string {
  return `v1,whsec_${key.toString("base64")}`;
}

function beforeUserCreatedEnvironment() {
  return {
    GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED: "true",
    GOTRUE_HOOK_BEFORE_USER_CREATED_URI:
      "https://auth.project.example/functions/v1/supauth/api/v1/auth-hooks/before-user-created",
    GOTRUE_HOOK_BEFORE_USER_CREATED_SECRETS: `${secret(firstKey)}|${secret(secondKey)}`,
  };
}

describe("live GoTrue HTTP Auth Hook verification", () => {
  test("signs the before-user-created probe with every active GoTrue rotation key", async () => {
    const fetcher = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      const webhookId = headers.get("webhook-id") || "";
      const timestamp = headers.get("webhook-timestamp") || "";
      const signatures = [firstKey, secondKey].map((key) => (
        `v1,${createHmac("sha256", key).update(`${webhookId}.${timestamp}.${body}`).digest("base64")}`
      ));
      expect(headers.get("webhook-signature")).toBe(signatures.join(", "));
      return new Response(JSON.stringify({
        supaoauth_hook_probe: {
          verified: true,
          protocol: "standard-webhooks-v1",
          hook_name: "before-user-created",
          project_ref: "proj_1",
        },
      }), { status: 200 });
    }) as typeof fetch;

    expect(await goTrueAuthHookStatusFromRuntime({
      projectRef: "proj_1",
      hookName: "before-user-created",
      projectConfig,
      environment: beforeUserCreatedEnvironment(),
    }, fetcher)).toEqual({
      hook_name: "before-user-created",
      registered: true,
      verified: true,
      protocol: "standard-webhooks-v1",
      version: "gotrue-standard-webhooks-v1",
      reason_code: null,
    });
  });

  test("distinguishes registered configuration from a verified endpoint", async () => {
    const invalidResponse = mock(async () => new Response("{}", { status: 200 })) as typeof fetch;
    expect(await goTrueAuthHookStatusFromRuntime({
      projectRef: "proj_1",
      hookName: "before-user-created",
      projectConfig,
      environment: beforeUserCreatedEnvironment(),
    }, invalidResponse)).toMatchObject({
      registered: true,
      verified: false,
      reason_code: "gotrue_before_user_created_hook_probe_response_invalid",
    });
  });
});
