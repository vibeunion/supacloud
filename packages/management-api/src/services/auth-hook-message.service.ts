import { consumeAuthHookWebhookId } from "./auth-hook-replay.service";
import {
  StandardWebhookVerificationError,
  verifyStandardWebhook,
} from "./standard-webhooks.service";
import { projectControlSecretsService } from "./project-control-secrets.service";
import type { GoTrueHttpHookName } from "./gotrue-auth-hook-runtime.service";

const MAX_HOOK_BODY_BYTES = 512 * 1024;
const SECRET_NAME_BY_HOOK: Record<GoTrueHttpHookName, string> = {
  "before-user-created": "before_user_created_hook",
  "custom-access-token": "custom_access_token_hook",
};

export type AuthHookMessage = {
  webhook_id: string;
  webhook_timestamp: string;
  webhook_signature: string;
  body_base64: string;
};

export type AuthHookMessageVerification = {
  verified: boolean;
  consumed: boolean;
  reason_code: string | null;
};

function decodedBody(encodedBody: string): Buffer | null {
  if (encodedBody.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedBody)) return null;
  const body = Buffer.from(encodedBody, "base64");
  if (body.length > MAX_HOOK_BODY_BYTES || body.toString("base64") !== encodedBody) return null;
  return body;
}

function rejected(reasonCode: string): AuthHookMessageVerification {
  return { verified: false, consumed: false, reason_code: reasonCode };
}

export async function verifyAuthHookMessage(
  projectRef: string,
  hookName: GoTrueHttpHookName,
  message: AuthHookMessage,
): Promise<AuthHookMessageVerification> {
  const rawBody = decodedBody(message.body_base64);
  if (!rawBody) return rejected("standard_webhook_body_invalid");
  const configuredSecrets = await projectControlSecretsService.readRequiredValue(
    projectRef,
    "auth-hook",
    SECRET_NAME_BY_HOOK[hookName],
  );
  try {
    verifyStandardWebhook({
      webhookId: message.webhook_id,
      timestamp: message.webhook_timestamp,
      signature: message.webhook_signature,
      rawBody,
      configuredSecrets,
    });
  } catch (error) {
    if (error instanceof StandardWebhookVerificationError && error.kind === "request") {
      return rejected(error.reasonCode);
    }
    throw error;
  }
  const consumed = await consumeAuthHookWebhookId(projectRef, message.webhook_id);
  return {
    verified: true,
    consumed,
    reason_code: consumed ? null : "standard_webhook_replay_detected",
  };
}
