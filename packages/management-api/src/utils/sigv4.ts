/**
 * AWS Signature Version 4 (SigV4) verification utility.
 *
 * Verifies the `Authorization: AWS4-HMAC-SHA256 ...` header on incoming S3
 * requests against the secret key known to the platform, using Web Crypto
 * (crypto.subtle) so the module runs in Bun without external native deps.
 *
 * Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 */
import { logger } from "./logger";

export interface SigV4Credential {
  accessKeyId: string;
  date: string; // yyyymmdd
  region: string;
  service: string;
}

export interface ParsedSigV4 {
  algorithm: string;
  credential: SigV4Credential;
  signedHeaders: string;
  signature: string;
}

/**
 * Parse the AWS SigV4 Authorization header into its structured fields.
 * Returns null if the header is not a valid SigV4 header.
 */
export function parseSigV4Header(authHeader: string | null): ParsedSigV4 | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (!trimmed.startsWith("AWS4-HMAC-SHA256")) return null;

  const rest = trimmed.slice("AWS4-HMAC-SHA256".length).trim();
  const parts: Record<string, string> = {};
  for (const segment of rest.split(",")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim();
    const val = segment.slice(eq + 1).trim();
    parts[key] = val;
  }

  const credentialPart = parts["Credential"];
  const signedHeadersPart = parts["SignedHeaders"];
  const signaturePart = parts["Signature"];

  if (!credentialPart || !signedHeadersPart || !signaturePart) return null;

  const [accessKeyId, date, region, service] = credentialPart.split("/");
  if (!accessKeyId || !date || !region || !service) return null;

  return {
    algorithm: "AWS4-HMAC-SHA256",
    credential: { accessKeyId, date, region, service },
    signedHeaders: signedHeadersPart,
    signature: signaturePart,
  };
}

function hexEncode(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const keyData = key instanceof Uint8Array ? key : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData.buffer.slice(keyData.byteOffset, keyData.byteOffset + keyData.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

/**
 * Derive the SigV4 signing key for the given credential scope.
 * signingKey = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")
 */
async function deriveSigningKey(
  secretKey: string,
  date: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kSecret = new TextEncoder().encode(`AWS4${secretKey}`) as unknown as ArrayBuffer;
  const kDate = await hmacSha256(kSecret, date);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function buildCanonicalHeaders(
  signedHeadersList: string[],
  headers: Headers,
  host: string,
): string {
  // signedHeadersList is already lowercased and semicolon-separated by the client.
  const canonical: string[] = [];
  for (const h of signedHeadersList) {
    const val = h === "host" ? host : headers.get(h) || "";
    canonical.push(`${h}:${(val || "").trim().replace(/\s+/g, " ")}\n`);
  }
  return canonical.join("");
}

function buildCanonicalUri(pathname: string): string {
  // S3 uses path-style requests; each path segment should be URI-encoded but "/" kept.
  return pathname
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/");
}

function buildCanonicalQueryString(query: string): string {
  if (!query) return "";
  const params = new URLSearchParams(query);
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  return sorted
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * Verify an incoming request's AWS SigV4 signature.
 *
 * @param request - The incoming Request object
 * @param bodyHash - SHA-256 hex of the request body (for streaming bodies the caller must compute this)
 * @param secretKey - The secret access key that corresponds to the accessKeyId in the credential
 * @param hostOverride - If provided, use this as the Host header value (useful when behind a proxy)
 * @returns true if the signature matches, false otherwise
 */
export async function verifySigV4Signature(
  request: Request,
  bodyHash: string,
  secretKey: string,
  hostOverride?: string,
): Promise<boolean> {
  const authHeader = request.headers.get("authorization");
  const parsed = parseSigV4Header(authHeader);
  if (!parsed) return false;

  const { credential, signedHeaders, signature } = parsed;
  const signedHeadersList = signedHeaders.split(";");

  const url = new URL(request.url);
  const host = hostOverride || request.headers.get("host") || url.host;

  const canonicalUri = buildCanonicalUri(url.pathname);
  const canonicalQueryString = buildCanonicalQueryString(url.search.replace(/^\?/, ""));
  const canonicalHeaders = buildCanonicalHeaders(signedHeadersList, request.headers, host);

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const canonicalHash = hexEncode(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest)),
  );

  const scope = `${credential.date}/${credential.region}/${credential.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    request.headers.get("x-amz-date") || "",
    scope,
    canonicalHash,
  ].join("\n");

  const signingKey = await deriveSigningKey(
    secretKey,
    credential.date,
    credential.region,
    credential.service,
  );
  const hmacKey = await crypto.subtle.importKey(
      "raw",
      signingKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expectedSignature = hexEncode(
      await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(stringToSign)),
    );

  if (expectedSignature === signature) return true;

  logger.debug("[sigv4] signature mismatch", {
    expected: expectedSignature.slice(0, 16),
    received: signature.slice(0, 16),
  });
  return false;
}

/**
 * Compute the SHA-256 hex hash of a request body.
 * For empty bodies returns the well-known empty-string hash.
 */
export async function hashBody(body: ArrayBuffer | Uint8Array | string): Promise<string> {
  const data =
    typeof body === "string"
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? body
        : new Uint8Array(body);
  return hexEncode(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

export const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
