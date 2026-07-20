import { describe, expect, spyOn, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import {
  isBlockedOutboundAddress,
  MAX_OUTBOUND_RESPONSE_BYTES,
  responseFromIncoming,
  validateOutboundHttpUrl,
} from "../../src/utils/outbound-http";

describe("outbound HTTP SSRF boundary", () => {
  test("rejects private IPv4 and IPv6 URL literals", () => {
    for (const value of [
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
    ]) {
      expect(validateOutboundHttpUrl(value).ok).toBe(false);
    }
  });

  test("recognizes mapped IPv4 and documentation IPv6 as blocked", () => {
    expect(isBlockedOutboundAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedOutboundAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedOutboundAddress("2001:db8::1")).toBe(true);
  });

  test("accepts a public HTTPS destination for DNS pinning at send time", () => {
    expect(validateOutboundHttpUrl("https://hooks.example.com/events")).toEqual({
      ok: true,
      url: "https://hooks.example.com/events",
    });
  });

  test("destroys the response socket as soon as the 64KiB limit is exceeded", async () => {
    const stream = new PassThrough();
    Object.assign(stream, { statusCode: 200, headers: { "content-type": "text/plain" } });
    const destroy = spyOn(stream, "destroy");
    const response = responseFromIncoming(stream as unknown as IncomingMessage);

    stream.write(Buffer.alloc(MAX_OUTBOUND_RESPONSE_BYTES + 1));

    await expect(response).rejects.toThrow(`exceeds ${MAX_OUTBOUND_RESPONSE_BYTES} bytes`);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("accepts a response exactly at the 64KiB boundary", async () => {
    const stream = new PassThrough();
    Object.assign(stream, { statusCode: 200, headers: {} });
    const response = responseFromIncoming(stream as unknown as IncomingMessage);
    stream.end(Buffer.alloc(MAX_OUTBOUND_RESPONSE_BYTES, "a"));

    const body = await (await response).arrayBuffer();
    expect(body.byteLength).toBe(MAX_OUTBOUND_RESPONSE_BYTES);
  });
});
