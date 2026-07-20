import { describe, expect, test } from "bun:test";
import {
  StandardWebhookVerificationError,
  buildStandardWebhookHeaders,
  verifyStandardWebhook,
} from "../../src/services/standard-webhooks.service";

const officialMessageId = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const officialTimestamp = 1_614_265_330;
const officialBody = Buffer.from('{"test": 2432232314}');
const officialSecret = "v1,whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const officialSignature = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

function verify(overrides: Partial<Parameters<typeof verifyStandardWebhook>[0]> = {}) {
  return verifyStandardWebhook({
    webhookId: officialMessageId,
    timestamp: String(officialTimestamp),
    signature: officialSignature,
    rawBody: officialBody,
    configuredSecrets: officialSecret,
    nowSeconds: officialTimestamp,
    ...overrides,
  });
}

describe("Standard Webhooks v1", () => {
  test("matches the locked official Go library signing vector", () => {
    expect(() => verify()).not.toThrow();
  });

  test("rejects missing or duplicated identity headers", () => {
    expect(() => verify({ webhookId: "" })).toThrow(StandardWebhookVerificationError);
    expect(() => verify({ webhookId: `${officialMessageId}, duplicate` })).toThrow("duplicate");
    expect(() => verify({ timestamp: `${officialTimestamp}, ${officialTimestamp}` })).toThrow("timestamp");
  });

  test("rejects body tampering and swapped signatures", () => {
    expect(() => verify({ rawBody: Buffer.from('{"test": 2432232315}') })).toThrow("did not match");
    expect(() => verify({ signature: `v1,${"A".repeat(44)}` })).toThrow("did not match");
  });

  test("rejects timestamps outside the five-minute window", () => {
    expect(() => verify({ nowSeconds: officialTimestamp + 301 })).toThrow("too old");
    expect(() => verify({ nowSeconds: officialTimestamp - 301 })).toThrow("too new");
  });

  test("emits and verifies GoTrue multi-secret rotation headers", () => {
    const rotatedSecrets = [
      Buffer.from("standard-webhooks-first-key"),
      Buffer.from("standard-webhooks-second-key"),
    ].map((key) => `v1,whsec_${key.toString("base64")}`).join("|");
    const headers = buildStandardWebhookHeaders({
      rawBody: officialBody,
      configuredSecrets: rotatedSecrets,
      webhookId: officialMessageId,
      timestamp: officialTimestamp,
    });

    expect(headers.get("webhook-signature")?.split(", ")).toHaveLength(2);
    expect(() => verifyStandardWebhook({
      webhookId: officialMessageId,
      timestamp: String(officialTimestamp),
      signature: headers.get("webhook-signature") || "",
      rawBody: officialBody,
      configuredSecrets: rotatedSecrets,
      nowSeconds: officialTimestamp,
    })).not.toThrow();
  });
});
