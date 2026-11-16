import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { buildStandardWebhookHeaders } from "../../src/services/standard-webhooks.service";
import * as tencentSms from "../../src/services/tencent-sms.service";

const projectRef = "sms-project";
const hookPath = `/v1/projects/${projectRef}/auth/sms/tencent`;
const hookSecret = `v1,whsec_${Buffer.from("sms-hook-test-signing-key-000001").toString("base64")}`;
const otherSecret = `v1,whsec_${Buffer.from("sms-hook-test-signing-key-000002").toString("base64")}`;
const consumed = new Set<string>();
const consumeAuthHookWebhookId = mock(async (ref: string, id: string) => {
  const key = `${ref}:${id}`;
  if (consumed.has(key)) return false;
  consumed.add(key);
  return true;
});
const readRequiredValue = mock(async (ref: string, purpose: string, name: string) => {
  if (purpose === "auth-hook") return ref === projectRef ? hookSecret : otherSecret;
  return `fixture-${name}`;
});
const getProjectSettings = mock(async () => ({
  auth: { sms: {
    provider: "tencent_cloud",
    region: "ap-guangzhou",
    sms_sdk_app_id: "1400000000",
    sign_name: "SupaCloud",
    template_id: "1000001",
  } },
}));
const sendTencentSms = spyOn(tencentSms, "sendTencentSms")
  .mockResolvedValue({ requestId: "fixture-send" });

mock.module("../../src/services/project-control-secrets.service", () => ({
  projectControlSecretsService: { readRequiredValue },
}));
mock.module("../../src/services/auth-hook-replay.service", () => ({
  consumeAuthHookWebhookId,
  releaseAuthHookWebhookId: async (ref: string, id: string) => {
    consumed.delete(`${ref}:${id}`);
  },
}));
mock.module("../../src/services", () => ({
  projectService: { getProjectSettings, getProject: async () => ({ ref: projectRef }) },
}));
mock.module("../../src/services/tenant-runtime.service", () => ({ tenantRuntimeService: {} }));
mock.module("../../src/services/auth-runtime.service", () => ({
  getAuthRuntimeManagedError: () => null,
  getAuthRuntimeDescriptor: () => ({}),
}));

const { checkAuth } = await import("../../src/middleware/auth");
const { authSmsRoutes } = await import("../../src/routes/auth-sms");
// Exercise the real management guard before the real SMS route, as index.ts does.
const app = new Elysia()
  .onBeforeHandle(async ({ request, set }) => {
    const failure = await checkAuth(request);
    if (failure) {
      set.status = failure.status;
      return failure.body;
    }
  })
  .use(authSmsRoutes);

const smsBody = JSON.stringify({ user: { phone: "+8613800138000" }, sms: { otp: "123456" } });

function hookRequest(options: {
  path?: string;
  body?: string;
  tamperedBody?: string;
  webhookId?: string;
  timestamp?: number;
  unsigned?: boolean;
} = {}): Request {
  const body = options.body ?? smsBody;
  const headers = options.unsigned
    ? new Headers({ "content-type": "application/json" })
    : buildStandardWebhookHeaders({
      rawBody: Buffer.from(body),
      configuredSecrets: hookSecret,
      webhookId: options.webhookId,
      timestamp: options.timestamp,
    });
  return new Request(`http://localhost${options.path ?? hookPath}`, {
    method: "POST", headers, body: options.tamperedBody ?? body,
  });
}

describe("GoTrue SMS hook authentication through the management guard", () => {
  beforeEach(() => {
    consumed.clear();
    consumeAuthHookWebhookId.mockClear();
    readRequiredValue.mockClear();
    getProjectSettings.mockClear();
    sendTencentSms.mockClear();
  });

  test("delivers a signed GoTrue callback without management credentials", async () => {
    const response = await app.handle(hookRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(readRequiredValue).toHaveBeenCalledWith(projectRef, "auth-hook", "send_sms_hook");
    expect(sendTencentSms).toHaveBeenCalledTimes(1);
    expect(sendTencentSms).toHaveBeenCalledWith(expect.objectContaining({
      phone: "+8613800138000", code: "123456",
    }));
  });

  test("verifies a signed runtime probe without sending SMS", async () => {
    const response = await app.handle(hookRequest({ body: JSON.stringify({
      supaoauth_hook_probe: { version: 1, project_ref: projectRef, hook_name: "send-sms" },
    }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      supaoauth_hook_probe: { verified: true, protocol: "standard-webhooks-v1" },
    });
    expect(getProjectSettings).not.toHaveBeenCalled();
    expect(sendTencentSms).not.toHaveBeenCalled();
  });

  test.each([
    { unsigned: true },
    { tamperedBody: smsBody.replace("123456", "654321") },
    { timestamp: Math.floor(Date.now() / 1000) - 601 },
    { path: "/v1/projects/another-project/auth/sms/tencent" },
  ])("rejects unverified callbacks before consuming or sending: %j", async (options) => {
    const response = await app.handle(hookRequest(options));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "INVALID_AUTH_HOOK" });
    expect(consumeAuthHookWebhookId).not.toHaveBeenCalled();
    expect(sendTencentSms).not.toHaveBeenCalled();
  });

  test("rejects a replay without delivering a second SMS", async () => {
    const options = { webhookId: "sms-hook-replay-fixture" };
    expect((await app.handle(hookRequest(options))).status).toBe(200);
    const replay = await app.handle(hookRequest(options));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: "WEBHOOK_REPLAY" });
    expect(sendTencentSms).toHaveBeenCalledTimes(1);
  });

  test("does not authorize the test-send endpoint with a webhook signature", async () => {
    const response = await app.handle(hookRequest({
      path: `/v1/projects/${projectRef}/auth/sms/test`,
      body: JSON.stringify({ phone: "+8613800138000" }),
    }));
    expect(response.status).toBe(401);
    expect(sendTencentSms).not.toHaveBeenCalled();
  });

  test.each([
    ["GET", hookPath],
    ["PUT", hookPath],
    ["POST", `${hookPath}/extra`],
    ["POST", `/v1/projects/${projectRef}/auth/sms/test`],
    ["PUT", `/v1/projects/${projectRef}/auth/sms`],
    ["GET", `/v1/projects/${projectRef}/auth/sms`],
    ["POST", `/v1/projects/${projectRef}/auth/hooks`],
  ])("keeps management auth on %s %s", async (method, path) => {
    expect(await checkAuth(new Request(`http://localhost${path}`, { method })))
      .toMatchObject({ status: 401 });
  });
});
