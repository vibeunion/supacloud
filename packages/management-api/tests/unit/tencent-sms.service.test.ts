import { describe, expect, test } from "bun:test";
import {
  buildTencentSmsAuthorization,
  parseTencentSmsHookPayload,
  sendTencentSms,
  validateTencentSmsConfig,
} from "../../src/services/tencent-sms.service";

const config = validateTencentSmsConfig({
  provider: "tencent_cloud",
  region: "ap-guangzhou",
  sms_sdk_app_id: "1400000000",
  sign_name: "SupaCloud",
  template_id: "1000001",
});

describe("Tencent Cloud SMS adapter", () => {
  test("parses a structured GoTrue SMS hook payload", () => {
    expect(parseTencentSmsHookPayload({
      user: { phone: "+8613800138000" },
      sms: { action: "signup", otp: "123456" },
    })).toEqual({ phone: "+8613800138000", code: "123456" });
  });

  test("parses an OTP from a rendered SMS body", () => {
    expect(parseTencentSmsHookPayload({
      user: { phone: "+8613800138000" },
      sms: { content: "Your verification code is 654321" },
    })).toEqual({ phone: "+8613800138000", code: "654321" });
  });

  test("rejects malformed phone numbers and missing OTPs", () => {
    expect(() => parseTencentSmsHookPayload({ user: { phone: "13800138000" }, sms: { otp: "123456" } })).toThrow("E.164");
    expect(() => parseTencentSmsHookPayload({ user: { phone: "+8613800138000" }, sms: { content: "No code" } })).toThrow("numeric OTP");
  });

  test("builds TC3 authorization headers", () => {
    const signed = buildTencentSmsAuthorization({
      secretId: "AKIDexample",
      secretKey: "secret-key",
      payload: JSON.stringify({ test: true }),
      timestamp: 1_700_000_000,
    });
    expect(signed.authorization).toMatch(/^TC3-HMAC-SHA256 Credential=AKIDexample\/2023-11-14\/sms\/tc3_request/);
    expect(signed.headers["X-TC-Action"]).toBe("SendSms");
    expect(signed.headers["X-TC-Version"]).toBe("2021-01-11");
  });

  test("sends the OTP as the Tencent template parameter", async () => {
    let request: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      request = init;
      return new Response(JSON.stringify({ Response: { RequestId: "request-1", SendStatusSet: [{ Code: "Ok" }] } }), { status: 200 });
    };
    await expect(sendTencentSms({
      config,
      credentials: { secretId: "AKIDexample", secretKey: "secret-key" },
      phone: "+8613800138000",
      code: "123456",
      fetcher,
      now: 1_700_000_000,
    })).resolves.toEqual({ requestId: "request-1" });
    expect(JSON.parse(String(request?.body))).toEqual({
      SmsSdkAppId: "1400000000",
      SignName: "SupaCloud",
      TemplateId: "1000001",
      TemplateParamSet: ["123456"],
      PhoneNumberSet: ["+8613800138000"],
    });
  });

  test("adds the configured validity minutes as a second template parameter", async () => {
    let request: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      request = init;
      return new Response(JSON.stringify({ Response: { RequestId: "request-2", SendStatusSet: [{ Code: "Ok" }] } }), { status: 200 });
    };
    await expect(sendTencentSms({
      config: validateTencentSmsConfig({ ...config, otp_validity_minutes: 5 }),
      credentials: { secretId: "AKIDexample", secretKey: "secret-key" },
      phone: "+8613800138000",
      code: "123456",
      fetcher,
      now: 1_700_000_000,
    })).resolves.toEqual({ requestId: "request-2" });
    expect(JSON.parse(String(request?.body)).TemplateParamSet).toEqual(["123456", "5"]);
  });

  test("rejects an invalid validity-minute value", () => {
    expect(() => validateTencentSmsConfig({ ...config, otp_validity_minutes: 0 })).toThrow("validity minutes");
    expect(() => validateTencentSmsConfig({ ...config, otp_validity_minutes: 61 })).toThrow("validity minutes");
  });

  test("rejects a successful HTTP response without a send status", async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ Response: {} }), { status: 200 });
    await expect(sendTencentSms({
      config,
      credentials: { secretId: "AKIDexample", secretKey: "secret-key" },
      phone: "+8613800138000",
      code: "123456",
      fetcher,
      now: 1_700_000_000,
    })).rejects.toThrow("provider rejected");
  });
});
