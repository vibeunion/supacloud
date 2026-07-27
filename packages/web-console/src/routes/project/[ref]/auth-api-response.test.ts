import { describe, expect, test } from "bun:test";
import {
  authApiResponseMessage,
  readAuthApiPayload,
  unwrapAuthApiObject,
} from "./auth-api-response";

describe("auth API response helpers", () => {
  test("unwraps direct and enveloped response objects", () => {
    expect(unwrapAuthApiObject({ code: "DIRECT" })).toEqual({ code: "DIRECT" });
    expect(unwrapAuthApiObject({ data: { code: "ENVELOPED" } })).toEqual({ code: "ENVELOPED" });
    expect(authApiResponseMessage({ error: { message: "managed by owner" } }, "fallback"))
      .toBe("managed by owner");
    expect(authApiResponseMessage({ message: "SITE_URL 格式不合法" }, "fallback"))
      .toBe("SITE_URL 格式不合法");
  });

  test("parses JSON and preserves plain-text error bodies", async () => {
    await expect(readAuthApiPayload(new Response('{"persisted":true}')))
      .resolves.toEqual({ persisted: true });
    await expect(readAuthApiPayload(new Response("upstream unavailable")))
      .resolves.toEqual({ message: "upstream unavailable" });
  });
});
