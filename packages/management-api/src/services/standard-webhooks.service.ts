import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const MAX_TIMESTAMP_SKEW_SECONDS = 300;
const WEBHOOK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class StandardWebhookVerificationError extends Error {
  readonly kind: "configuration" | "request";
  readonly reasonCode: string;

  constructor(kind: "configuration" | "request", reasonCode: string, message: string) {
    super(message);
    this.name = "StandardWebhookVerificationError";
    this.kind = kind;
    this.reasonCode = reasonCode;
  }
}

type StandardWebhookInput = {
  webhookId: string;
  timestamp: string;
  signature: string;
  rawBody: Uint8Array;
  configuredSecrets: string;
  nowSeconds?: number;
};

type StandardWebhookSigningInput = {
  rawBody: Uint8Array;
  configuredSecrets: string;
  webhookId?: string;
  timestamp?: number;
};

function configurationError(message: string): StandardWebhookVerificationError {
  return new StandardWebhookVerificationError("configuration", "standard_webhook_secret_invalid", message);
}

function requestError(reasonCode: string, message: string): StandardWebhookVerificationError {
  return new StandardWebhookVerificationError("request", reasonCode, message);
}

function decodeSigningKey(secret: string): Buffer {
  if (!secret.startsWith("v1,whsec_")) {
    throw configurationError("GoTrue HTTP Hook secret must use v1,whsec_ format");
  }
  const encodedKey = secret.slice("v1,whsec_".length);
  if (
    encodedKey.length < 32
    || encodedKey.length > 88
    || encodedKey.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedKey)
  ) throw configurationError("GoTrue HTTP Hook secret is not canonical base64");
  const key = Buffer.from(encodedKey, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64") !== encodedKey) {
    throw configurationError("GoTrue HTTP Hook secret is not canonical base64");
  }
  return key;
}

export function standardWebhookSigningKeys(configuredSecrets: string): Buffer[] {
  const secrets = configuredSecrets.split("|").filter(Boolean);
  if (secrets.length === 0) throw configurationError("GoTrue HTTP Hook secret is missing");
  return secrets.map(decodeSigningKey);
}

function parsedTimestamp(value: string, nowSeconds: number): number {
  if (!/^[+-]?\d+$/.test(value)) {
    throw requestError("standard_webhook_headers_invalid", "Invalid webhook timestamp");
  }
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp)) {
    throw requestError("standard_webhook_headers_invalid", "Invalid webhook timestamp");
  }
  if (nowSeconds - timestamp > MAX_TIMESTAMP_SKEW_SECONDS) {
    throw requestError("standard_webhook_timestamp_too_old", "Webhook timestamp is too old");
  }
  if (timestamp > nowSeconds + MAX_TIMESTAMP_SKEW_SECONDS) {
    throw requestError("standard_webhook_timestamp_too_new", "Webhook timestamp is too new");
  }
  return timestamp;
}

function signatureCandidates(signature: string): Buffer[] {
  return signature.split(" ").flatMap((versionedSignature) => {
    const parts = versionedSignature.split(",");
    return parts.length >= 2 && parts[0] === "v1" ? [Buffer.from(parts[1])] : [];
  });
}

function signedContent(webhookId: string, timestamp: number, rawBody: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${webhookId}.${timestamp}.`), Buffer.from(rawBody)]);
}

function signaturesMatch(keys: Buffer[], candidates: Buffer[], content: Buffer): boolean {
  let matched = false;
  for (const key of keys) {
    const expected = Buffer.from(createHmac("sha256", key).update(content).digest("base64"));
    for (const candidate of candidates) {
      const equal = candidate.length === expected.length && timingSafeEqual(candidate, expected);
      matched = equal || matched;
    }
  }
  return matched;
}

export function verifyStandardWebhook(input: StandardWebhookInput): void {
  if (!WEBHOOK_ID_PATTERN.test(input.webhookId) || !input.timestamp || !input.signature) {
    throw requestError("standard_webhook_headers_invalid", "Missing or duplicate Standard Webhooks headers");
  }
  const timestamp = parsedTimestamp(input.timestamp, input.nowSeconds ?? Date.now() / 1000);
  const candidates = signatureCandidates(input.signature);
  if (candidates.length === 0) {
    throw requestError("standard_webhook_signature_invalid", "No supported webhook signature was provided");
  }
  const content = signedContent(input.webhookId, timestamp, input.rawBody);
  if (!signaturesMatch(standardWebhookSigningKeys(input.configuredSecrets), candidates, content)) {
    throw requestError("standard_webhook_signature_invalid", "Webhook signature did not match");
  }
}

export function buildStandardWebhookHeaders(input: StandardWebhookSigningInput): Headers {
  const webhookId = input.webhookId || randomUUID();
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const content = signedContent(webhookId, timestamp, input.rawBody);
  const signatures = standardWebhookSigningKeys(input.configuredSecrets).map((key) => (
    `v1,${createHmac("sha256", key).update(content).digest("base64")}`
  ));
  return new Headers({
    "Accept-Encoding": "identity",
    "Content-Type": "application/json",
    "webhook-id": webhookId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signatures.join(", "),
  });
}
