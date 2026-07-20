import { beforeEach, describe, expect, mock, test } from "bun:test";
import { buildStandardWebhookHeaders } from "../../src/services/standard-webhooks.service";

const signingKey = Buffer.from("standard-webhooks-test-key");
const configuredSecret = `v1,whsec_${signingKey.toString("base64")}`;
const readRequiredValue = mock(async () => configuredSecret);
const consumeAuthHookWebhookId = mock(async () => true);

mock.module("../../src/services/project-control-secrets.service", () => ({
  projectControlSecretsService: { readRequiredValue },
}));
mock.module("../../src/services/auth-hook-replay.service", () => ({ consumeAuthHookWebhookId }));

const { verifyAuthHookMessage } = await import("../../src/services/auth-hook-message.service");

function signedMessage(body: Buffer) {
  const headers = buildStandardWebhookHeaders({ rawBody: body, configuredSecrets: configuredSecret });
  return {
    webhook_id: headers.get("webhook-id") || "",
    webhook_timestamp: headers.get("webhook-timestamp") || "",
    webhook_signature: headers.get("webhook-signature") || "",
    body_base64: body.toString("base64"),
  };
}

describe("auth hook message verification", () => {
  beforeEach(() => {
    readRequiredValue.mockClear();
    readRequiredValue.mockResolvedValue(configuredSecret);
    consumeAuthHookWebhookId.mockClear();
    consumeAuthHookWebhookId.mockResolvedValue(true);
  });

  test("reads the hook secret internally and consumes a valid message once", async () => {
    const message = signedMessage(Buffer.from('{"user_id":"user-one"}'));
    await expect(verifyAuthHookMessage("proj_1", "custom-access-token", message)).resolves.toEqual({
      verified: true,
      consumed: true,
      reason_code: null,
    });
    expect(readRequiredValue).toHaveBeenCalledWith(
      "proj_1",
      "auth-hook",
      "custom_access_token_hook",
    );
    expect(consumeAuthHookWebhookId).toHaveBeenCalledWith("proj_1", message.webhook_id);
  });

  test("rejects a tampered body before consuming the webhook ID", async () => {
    const message = signedMessage(Buffer.from('{"user_id":"user-one"}'));
    message.body_base64 = Buffer.from('{"user_id":"user-two"}').toString("base64");

    await expect(verifyAuthHookMessage("proj_1", "custom-access-token", message)).resolves.toMatchObject({
      verified: false,
      consumed: false,
      reason_code: "standard_webhook_signature_invalid",
    });
    expect(consumeAuthHookWebhookId).not.toHaveBeenCalled();
  });

  test("reports a replay without treating it as a verified fresh message", async () => {
    consumeAuthHookWebhookId.mockResolvedValueOnce(false);
    await expect(verifyAuthHookMessage(
      "proj_1",
      "before-user-created",
      signedMessage(Buffer.from("{}")),
    )).resolves.toEqual({
      verified: true,
      consumed: false,
      reason_code: "standard_webhook_replay_detected",
    });
  });
});
