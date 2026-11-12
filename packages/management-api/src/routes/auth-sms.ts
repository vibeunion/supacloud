import { Elysia, status, t } from "elysia";
import { config } from "../config";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { projectService } from "../services";
import { projectControlSecretsService } from "../services/project-control-secrets.service";
import { tenantRuntimeService } from "../services/tenant-runtime.service";
import { consumeAuthHookWebhookId, releaseAuthHookWebhookId } from "../services/auth-hook-replay.service";
import { StandardWebhookVerificationError, verifyStandardWebhook } from "../services/standard-webhooks.service";
import {
  createTencentSmsHookSecret,
  parseTencentSmsHookPayload,
  sendTencentSms,
  validateTencentSmsConfig,
} from "../services/tencent-sms.service";
import { requireAuthRuntimeManagement } from "./auth-runtime";

const SMS_PROVIDER_VALUES = ["none", "tencent_cloud"] as const;
type SmsProvider = (typeof SMS_PROVIDER_VALUES)[number];

type RecordValue = Record<string, unknown>;

function recordValue(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function otpValidityMinutes(value: unknown, fallback: number | null = null): number | null {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return Number.NaN;
}

function providerValue(value: unknown, strict = false): SmsProvider {
  if (value === undefined || value === null || value === "") return "none";
  if (value === "none" || value === "tencent_cloud") return value;
  if (strict) throw new Error("Unsupported SMS provider");
  return "none";
}

function readSmsConfig(auth: RecordValue): {
  provider: SmsProvider;
  region: string;
  sms_sdk_app_id: string;
  sign_name: string;
  template_id: string;
  otp_validity_minutes: number | null;
} {
  const sms = recordValue(auth.sms);
  return {
    provider: providerValue(sms.provider ?? auth.sms_provider),
    region: stringValue(sms.region) ?? "ap-guangzhou",
    sms_sdk_app_id: stringValue(sms.sms_sdk_app_id) ?? "",
    sign_name: stringValue(sms.sign_name) ?? "",
    template_id: stringValue(sms.template_id) ?? "",
    otp_validity_minutes: otpValidityMinutes(sms.otp_validity_minutes),
  };
}

function configResponse(input: {
  sms: ReturnType<typeof readSmsConfig>;
  secretIdConfigured: boolean;
  secretKeyConfigured: boolean;
  hookConfigured: boolean;
}) {
  const metadataConfigured = Boolean(
    input.sms.region &&
    input.sms.sms_sdk_app_id &&
    input.sms.sign_name &&
    input.sms.template_id,
  );
  return {
    provider: input.sms.provider,
    enabled: input.sms.provider === "tencent_cloud"
      && metadataConfigured
      && input.secretIdConfigured
      && input.secretKeyConfigured
      && input.hookConfigured,
    region: input.sms.region,
    sms_sdk_app_id: input.sms.sms_sdk_app_id,
    sign_name: input.sms.sign_name,
    template_id: input.sms.template_id,
    secret_id_configured: input.secretIdConfigured,
    secret_key_configured: input.secretKeyConfigured,
    hook_configured: input.hookConfigured,
  };
}

async function projectSettings(ref: string) {
  const settings = await projectService.getProjectSettings(ref);
  return settings ? settings as RecordValue : null;
}

async function readConfigResponse(ref: string) {
  const settings = await projectSettings(ref);
  if (!settings) return null;
  const auth = recordValue(settings.auth);
  const sms = readSmsConfig(auth);
  const [secretId, secretKey, hook] = await Promise.all([
    projectControlSecretsService.getStatus(ref, "sms-provider", "tencent_secret_id"),
    projectControlSecretsService.getStatus(ref, "sms-provider", "tencent_secret_key"),
    projectControlSecretsService.getStatus(ref, "auth-hook", "send_sms_hook"),
  ]);
  return configResponse({
    sms,
    secretIdConfigured: secretId.configured,
    secretKeyConfigured: secretKey.configured,
    hookConfigured: hook.configured,
  });
}

function hookUri(ref: string): string {
  return `${config.supacloudApiUrl.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(ref)}/auth/sms/tencent`;
}

async function requireSmsProject(request: Request, ref: string) {
  const authError = await requireProjectOrAdminAuth(request, ref);
  if (authError) return authError;
  if (!(await projectService.getProject(ref))) return status(404, { code: "NOT_FOUND", message: "Project not found" });
  return null;
}

async function saveTencentConfig(
  ref: string,
  settings: RecordValue,
  body: RecordValue,
): Promise<Record<string, unknown>> {
  const currentAuth = recordValue(settings.auth);
  const currentSms = readSmsConfig(currentAuth);
  const provider = providerValue(body.provider ?? currentSms.provider, body.provider !== undefined);
  const sms = {
    provider,
    region: stringValue(body.region) ?? currentSms.region,
    sms_sdk_app_id: stringValue(body.sms_sdk_app_id) ?? currentSms.sms_sdk_app_id,
    sign_name: stringValue(body.sign_name) ?? currentSms.sign_name,
    template_id: stringValue(body.template_id) ?? currentSms.template_id,
    otp_validity_minutes: otpValidityMinutes(body.otp_validity_minutes, currentSms.otp_validity_minutes),
  };

  if (!SMS_PROVIDER_VALUES.includes(provider)) throw new Error("Unsupported SMS provider");
  if (provider === "tencent_cloud") {
    const normalizedSms = validateTencentSmsConfig({ ...sms, provider: "tencent_cloud" });
    const existingSecretId = await projectControlSecretsService.readValue(ref, "sms-provider", "tencent_secret_id");
    const existingSecretKey = await projectControlSecretsService.readValue(ref, "sms-provider", "tencent_secret_key");
    const secretId = stringValue(body.secret_id) ?? existingSecretId;
    const secretKey = stringValue(body.secret_key) ?? existingSecretKey;
    if (!secretId || !secretKey) throw new Error("Tencent SMS SecretId and SecretKey are required");
    if (stringValue(body.secret_id)) await projectControlSecretsService.upsert(ref, "sms-provider", "tencent_secret_id", stringValue(body.secret_id)!);
    if (stringValue(body.secret_key)) await projectControlSecretsService.upsert(ref, "sms-provider", "tencent_secret_key", stringValue(body.secret_key)!);
    const hookSecret = await projectControlSecretsService.readValue(ref, "auth-hook", "send_sms_hook")
      ?? createTencentSmsHookSecret();
    if (!await projectControlSecretsService.readValue(ref, "auth-hook", "send_sms_hook")) {
      await projectControlSecretsService.upsert(ref, "auth-hook", "send_sms_hook", hookSecret);
    }
    const currentHooks = recordValue(currentAuth.hooks);
    const updatedAuth = {
      ...currentAuth,
      sms: normalizedSms,
      external_phone_enabled: true,
      hooks: {
        ...currentHooks,
        send_sms_hook: { ...recordValue(currentHooks.send_sms_hook), enabled: true, uri: hookUri(ref) },
      },
    };
    await projectService.updateProjectSettings(ref, { ...settings, auth: updatedAuth });
    await tenantRuntimeService.applyAuthConfig(ref, currentAuth, updatedAuth);
  } else {
    const currentHooks = recordValue(currentAuth.hooks);
    const updatedAuth = {
      ...currentAuth,
      sms,
      external_phone_enabled: false,
      hooks: {
        ...currentHooks,
        send_sms_hook: { ...recordValue(currentHooks.send_sms_hook), enabled: false },
      },
    };
    await projectService.updateProjectSettings(ref, { ...settings, auth: updatedAuth });
    await tenantRuntimeService.applyAuthConfig(ref, currentAuth, updatedAuth);
  }
  return await readConfigResponse(ref) ?? {};
}

const managementRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth/sms" })
  .onBeforeHandle(requireAuthRuntimeManagement("configuration"))
  .get("/", {
    params: t.Object({ ref: t.String() }),
    detail: { tags: ["auth"], summary: "Get project SMS provider configuration" },
  }, async ({ params, request }) => {
    const authError = await requireSmsProject(request, params.ref);
    if (authError) return authError;
    return await readConfigResponse(params.ref);
  })
  .put("/", {
    params: t.Object({ ref: t.String() }),
    body: t.Record(t.String(), t.Unknown()),
    detail: { tags: ["auth"], summary: "Configure project SMS provider" },
  }, async ({ params, body, request, set }) => {
    const authError = await requireSmsProject(request, params.ref);
    if (authError) return authError;
    try {
      const settings = await projectSettings(params.ref);
      if (!settings) return status(404, { code: "NOT_FOUND", message: "Project not found" });
      return await saveTencentConfig(params.ref, settings, body as RecordValue);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Invalid SMS configuration";
      set.status = /requires|Unsupported|missing/i.test(message) ? 400 : 503;
      return {
        code: set.status === 400 ? "INVALID_SMS_CONFIG" : "SMS_RUNTIME_APPLY_FAILED",
        message: set.status === 400 ? message : "SMS configuration was saved but could not be applied to GoTrue",
      };
    }
  })
  .post("/test", {
    params: t.Object({ ref: t.String() }),
    body: t.Object({ phone: t.String({ minLength: 8, maxLength: 20 }) }),
    detail: { tags: ["auth"], summary: "Send a Tencent Cloud SMS test message" },
  }, async ({ params, body, request, set }) => {
    const authError = await requireSmsProject(request, params.ref);
    if (authError) return authError;
    try {
      const settings = await projectSettings(params.ref);
      if (!settings) return status(404, { code: "NOT_FOUND", message: "Project not found" });
      const sms = validateTencentSmsConfig({ ...readSmsConfig(recordValue(settings.auth)), provider: "tencent_cloud" });
      const secretId = await projectControlSecretsService.readRequiredValue(params.ref, "sms-provider", "tencent_secret_id");
      const secretKey = await projectControlSecretsService.readRequiredValue(params.ref, "sms-provider", "tencent_secret_key");
      const result = await sendTencentSms({ config: sms, credentials: { secretId, secretKey }, phone: body.phone, code: "123456" });
      return { ok: true, request_id: result.requestId ?? null };
    } catch (error: unknown) {
      set.status = 502;
      return { code: "SMS_PROVIDER_FAILED", message: "Tencent Cloud SMS test failed" };
    }
  });

const runtimeRoute = new Elysia({ prefix: "/v1/projects/:ref/auth/sms" })
  .post("/tencent", {
    params: t.Object({ ref: t.String() }),
    detail: { tags: ["auth"], summary: "Deliver a Tencent Cloud SMS Auth Hook" },
  }, async ({ params, request, set }) => {
    const rawBody = Buffer.from(await request.arrayBuffer());
    if (rawBody.length > 512 * 1024) return status(413, { code: "PAYLOAD_TOO_LARGE", message: "SMS hook payload is too large" });
    const webhookId = request.headers.get("webhook-id") ?? "";
    const webhookTimestamp = request.headers.get("webhook-timestamp") ?? "";
    const webhookSignature = request.headers.get("webhook-signature") ?? "";
    let replayReserved = false;
    try {
      const secret = await projectControlSecretsService.readRequiredValue(params.ref, "auth-hook", "send_sms_hook");
      verifyStandardWebhook({
        webhookId,
        timestamp: webhookTimestamp,
        signature: webhookSignature,
        rawBody,
        configuredSecrets: secret,
      });
      if (!await consumeAuthHookWebhookId(params.ref, webhookId)) {
        return status(409, { code: "WEBHOOK_REPLAY", message: "SMS hook replay detected" });
      }
      replayReserved = true;
      const payload = JSON.parse(rawBody.toString("utf8")) as unknown;
      const probe = recordValue(recordValue(payload).supaoauth_hook_probe);
      if (Object.keys(probe).length > 0) {
        return { supaoauth_hook_probe: { ...probe, verified: true, protocol: "standard-webhooks-v1" } };
      }
      const settings = await projectSettings(params.ref);
      if (!settings) return status(404, { code: "NOT_FOUND", message: "Project not found" });
      const sms = validateTencentSmsConfig({ ...readSmsConfig(recordValue(settings.auth)), provider: "tencent_cloud" });
      const credentials = {
        secretId: await projectControlSecretsService.readRequiredValue(params.ref, "sms-provider", "tencent_secret_id"),
        secretKey: await projectControlSecretsService.readRequiredValue(params.ref, "sms-provider", "tencent_secret_key"),
      };
      const message = parseTencentSmsHookPayload(payload);
      await sendTencentSms({ config: sms, credentials, phone: message.phone, code: message.code });
      replayReserved = false;
      return {};
    } catch (error: unknown) {
      if (replayReserved) {
        await releaseAuthHookWebhookId(params.ref, webhookId).catch(() => {});
      }
      if (error instanceof StandardWebhookVerificationError) {
        set.status = 401;
        return { code: "INVALID_AUTH_HOOK", message: "Invalid SMS hook signature" };
      }
      set.status = 502;
      return { code: "SMS_PROVIDER_FAILED", message: "Unable to send the verification code" };
    }
  });

export const authSmsRoutes = new Elysia({ name: "auth-sms-routes" })
  .use(managementRoutes)
  .use(runtimeRoute);
