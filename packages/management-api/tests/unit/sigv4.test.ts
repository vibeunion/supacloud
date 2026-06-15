import { describe, expect, test } from "bun:test";
import {
  parseSigV4Header,
  verifySigV4Signature,
  hashBody,
  EMPTY_BODY_HASH,
} from "../../src/utils/sigv4";

const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const REGION = "us-east-1";
const SERVICE = "s3";
const DATE = "20130524";

describe("parseSigV4Header", () => {
  test("parses a valid SigV4 Authorization header", () => {
    const header =
      `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${DATE}/${REGION}/${SERVICE}/aws4_request, SignedHeaders=host;range;x-amz-date, Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024`;
    const parsed = parseSigV4Header(header);
    expect(parsed).not.toBeNull();
    expect(parsed!.algorithm).toBe("AWS4-HMAC-SHA256");
    expect(parsed!.credential.accessKeyId).toBe(ACCESS_KEY);
    expect(parsed!.credential.date).toBe(DATE);
    expect(parsed!.credential.region).toBe(REGION);
    expect(parsed!.credential.service).toBe(SERVICE);
    expect(parsed!.signedHeaders).toBe("host;range;x-amz-date");
    expect(parsed!.signature).toBe(
      "fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024",
    );
  });

  test("returns null for non-SigV4 header", () => {
    expect(parseSigV4Header("Bearer some-token")).toBeNull();
    expect(parseSigV4Header(null)).toBeNull();
    expect(parseSigV4Header("")).toBeNull();
  });

  test("returns null for malformed SigV4 header (missing fields)", () => {
    expect(
      parseSigV4Header("AWS4-HMAC-SHA256 Credential=incomplete"),
    ).toBeNull();
  });

  test("returns null for credential with insufficient path segments", () => {
    expect(
      parseSigV4Header(
        "AWS4-HMAC-SHA256 Credential=AKIA/short, SignedHeaders=host, Signature=abc",
      ),
    ).toBeNull();
  });
});

describe("verifySigV4Signature", () => {
  /**
   * Build a signed request using the same algorithm, then verify it.
   * This is a self-consistency test: if sign and verify agree, the
   * implementation is internally consistent.
   */
  async function signRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    bodyHash: string,
    secretKey: string,
    accessKey: string,
    date: string,
    region: string,
    service: string,
  ): Promise<string> {
    // Canonical request
    const u = new URL(url);
    const signedHeadersList = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort()
      .join(";");

    const canonicalHeaders = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort()
      .map((h) => `${h}:${headers[h].trim()}\n`)
      .join("");

    const canonicalUri = u.pathname;
    const canonicalQuery = u.searchParams
      ? [...u.searchParams.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : "";

    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeadersList,
      bodyHash,
    ].join("\n");

    const canonicalHash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest)),
    ).toString("hex");

    const scope = `${date}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      headers["x-amz-date"] || "",
      scope,
      canonicalHash,
    ].join("\n");

    // Derive signing key
    const kSecret = new TextEncoder().encode(`AWS4${secretKey}`);
    const kDate = await hmac(kSecret, date);
    const kRegion = await hmac(kDate, region);
    const kService = await hmac(kRegion, service);
    const kSigning = await hmac(kService, "aws4_request");

    return Buffer.from(
      await crypto.subtle.sign("HMAC", await crypto.subtle.importKey(
        "raw", kSigning, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
      ), new TextEncoder().encode(stringToSign)),
    ).toString("hex");
  }

  async function hmac(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
      "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  }

  test("verifies a correctly signed GET request", async () => {
    const url = "http://testproj.s3.supacloud.local/v1/storage/testproj/s3/mybucket";
    const xAmzDate = "20130524T000000Z";
    const headers = {
      host: "testproj.s3.supacloud.local",
      "x-amz-date": xAmzDate,
      "x-amz-content-sha256": EMPTY_BODY_HASH,
    };

    const bodyHash = EMPTY_BODY_HASH;
    const signature = await signRequest(
      "GET", url, headers, bodyHash,
      SECRET_KEY, ACCESS_KEY, DATE, REGION, SERVICE,
    );

    const request = new Request(url, {
      method: "GET",
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${DATE}/${REGION}/${SERVICE}/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
      },
    });

    const valid = await verifySigV4Signature(request, bodyHash, SECRET_KEY);
    expect(valid).toBe(true);
  });

  test("rejects a request with wrong secret key", async () => {
    const url = "http://testproj.s3.supacloud.local/v1/storage/testproj/s3/mybucket";
    const headers = {
      host: "testproj.s3.supacloud.local",
      "x-amz-date": "20130524T000000Z",
      "x-amz-content-sha256": EMPTY_BODY_HASH,
    };

    const signature = await signRequest(
      "GET", url, headers, EMPTY_BODY_HASH,
      SECRET_KEY, ACCESS_KEY, DATE, REGION, SERVICE,
    );

    const request = new Request(url, {
      method: "GET",
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${DATE}/${REGION}/${SERVICE}/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
      },
    });

    const valid = await verifySigV4Signature(request, EMPTY_BODY_HASH, "wrong-secret-key");
    expect(valid).toBe(false);
  });

  test("rejects a request with tampered signature", async () => {
    const url = "http://testproj.s3.supacloud.local/v1/storage/testproj/s3/mybucket";
    const headers = {
      host: "testproj.s3.supacloud.local",
      "x-amz-date": "20130524T000000Z",
      "x-amz-content-sha256": EMPTY_BODY_HASH,
    };

    const request = new Request(url, {
      method: "GET",
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${DATE}/${REGION}/${SERVICE}/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=0000000000000000000000000000000000000000000000000000000000000000`,
      },
    });

    const valid = await verifySigV4Signature(request, EMPTY_BODY_HASH, SECRET_KEY);
    expect(valid).toBe(false);
  });
});

describe("hashBody", () => {
  test("hashes a string body", async () => {
    const hash = await hashBody("hello world");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("empty string produces the standard empty hash", async () => {
    const hash = await hashBody("");
    expect(hash).toBe(EMPTY_BODY_HASH);
  });

  test("hashes a Uint8Array body", async () => {
    const hash = await hashBody(new TextEncoder().encode("test"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
