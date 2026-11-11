import { createHash, createHmac, randomBytes } from "node:crypto";

const TENCENT_SMS_ENDPOINT = "https://sms.tencentcloudapi.com/";
const TENCENT_SMS_SERVICE = "sms";
const TENCENT_SMS_ACTION = "SendSms";
const TENCENT_SMS_VERSION = "2021-01-11";
const TENCENT_SMS_TIMEOUT_MS = 5_000;
const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
const OTP_PATTERN = /^\d{4,8}$/;

export type TencentSmsConfig = {
  provider: "tencent_cloud";
  region: string;
  sms_sdk_app_id: string;
  sign_name: string;
  template_id: string;
};

export type TencentSmsCredentials = {
  secretId: string;
  secretKey: string;
};

export type TencentSmsHookPayload = {
  phone: string;
  code: string;
};

type RecordValue = Record<string, unknown>;

function recordValue(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return hmacSha256(key, value).toString("hex");
}

export function buildTencentSmsAuthorization(input: {
  secretId: string;
  secretKey: string;
  payload: string;
  timestamp: number;
}): { authorization: string; headers: Record<string, string> } {
  const host = new URL(TENCENT_SMS_ENDPOINT).host;
  const contentType = "application/json; charset=utf-8";
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const canonical = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256(input.payload),
  ].join("\n");
  const credentialScope = `${date}/${TENCENT_SMS_SERVICE}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(input.timestamp),
    credentialScope,
    sha256(canonical),
  ].join("\n");
  const secretDate = hmacSha256(`TC3${input.secretKey}`, date);
  const secretService = hmacSha256(secretDate, TENCENT_SMS_SERVICE);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = hmacHex(secretSigning, stringToSign);
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${input.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers: {
      "Content-Type": contentType,
      Host: host,
      "X-TC-Action": TENCENT_SMS_ACTION,
      "X-TC-Version": TENCENT_SMS_VERSION,
      "X-TC-Timestamp": String(input.timestamp),
      "X-TC-Region": "",
    },
  };
}

export function createTencentSmsHookSecret(): string {
  return `v1,whsec_${randomBytes(32).toString("base64")}`;
}

function extractCode(value: unknown): string | null {
  const explicit = stringValue(value);
  return explicit && OTP_PATTERN.test(explicit) ? explicit : null;
}

function codeFromContent(value: unknown): string | null {
  const content = stringValue(value);
  if (!content) return null;
  const labelled = content.match(/(?:验证码|verification\s*code|otp|code)\D{0,12}(\d{4,8})/i)?.[1];
  if (labelled && OTP_PATTERN.test(labelled)) return labelled;
  const candidates = content.match(/\b\d{4,8}\b/g) ?? [];
  return candidates.length === 1 && OTP_PATTERN.test(candidates[0] ?? "") ? candidates[0] ?? null : null;
}

export function parseTencentSmsHookPayload(payload: unknown): TencentSmsHookPayload {
  const root = recordValue(payload);
  const user = recordValue(root.user);
  const sms = recordValue(root.sms);
  const phone = stringValue(sms.phone) ?? stringValue(user.phone) ?? stringValue(root.phone);
  const code = extractCode(sms.otp)
    ?? extractCode(sms.code)
    ?? extractCode(root.otp)
    ?? extractCode(root.code)
    ?? codeFromContent(sms.content)
    ?? codeFromContent(sms.message)
    ?? codeFromContent(root.content);
  if (!phone || !E164_PHONE_PATTERN.test(phone)) {
    throw new Error("Tencent SMS hook payload must contain an E.164 phone number");
  }
  if (!code) throw new Error("Tencent SMS hook payload must contain a numeric OTP");
  return { phone, code };
}

export function validateTencentSmsConfig(config: Partial<TencentSmsConfig>): TencentSmsConfig {
  const region = stringValue(config.region);
  const smsSdkAppId = stringValue(config.sms_sdk_app_id);
  const signName = stringValue(config.sign_name);
  const templateId = stringValue(config.template_id);
  if (!region || !smsSdkAppId || !signName || !templateId) {
    throw new Error("Tencent SMS requires region, SMS SDK App ID, sign name, and template ID");
  }
  return {
    provider: "tencent_cloud",
    region,
    sms_sdk_app_id: smsSdkAppId,
    sign_name: signName,
    template_id: templateId,
  };
}

export async function sendTencentSms(input: {
  config: TencentSmsConfig;
  credentials: TencentSmsCredentials;
  phone: string;
  code: string;
  fetcher?: typeof fetch;
  now?: number;
}): Promise<{ requestId?: string }> {
  if (!E164_PHONE_PATTERN.test(input.phone)) throw new Error("Phone number must use E.164 format");
  if (!OTP_PATTERN.test(input.code)) throw new Error("OTP must contain 4 to 8 digits");
  if (!input.credentials.secretId || !input.credentials.secretKey) throw new Error("Tencent SMS credentials are missing");

  const payload = JSON.stringify({
    SmsSdkAppId: input.config.sms_sdk_app_id,
    SignName: input.config.sign_name,
    TemplateId: input.config.template_id,
    TemplateParamSet: [input.code],
    PhoneNumberSet: [input.phone],
  });
  const timestamp = input.now ?? Math.floor(Date.now() / 1000);
  const signed = buildTencentSmsAuthorization({
    secretId: input.credentials.secretId,
    secretKey: input.credentials.secretKey,
    payload,
    timestamp,
  });
  signed.headers["X-TC-Region"] = input.config.region;
  signed.headers.Authorization = signed.authorization;

  const response = await (input.fetcher ?? fetch)(TENCENT_SMS_ENDPOINT, {
    method: "POST",
    headers: signed.headers,
    body: payload,
    signal: AbortSignal.timeout(TENCENT_SMS_TIMEOUT_MS),
  });
  const responseBody = await response.json().catch(() => null) as unknown;
  const responseRecord = recordValue(responseBody);
  const responseData = recordValue(responseRecord.Response);
  const error = recordValue(responseData.Error);
  if (!response.ok || Object.keys(error).length > 0 || responseData.SendStatusSet && !Array.isArray(responseData.SendStatusSet)) {
    throw new Error("Tencent SMS provider rejected the request");
  }
  const sendStatus = Array.isArray(responseData.SendStatusSet)
    ? recordValue(responseData.SendStatusSet[0])
    : {};
  if (sendStatus.Code && sendStatus.Code !== "Ok") throw new Error("Tencent SMS provider rejected the request");
  return typeof responseData.RequestId === "string" ? { requestId: responseData.RequestId } : {};
}
