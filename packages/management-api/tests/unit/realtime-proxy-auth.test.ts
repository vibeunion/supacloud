import { describe, expect, test } from "bun:test";
import { translateRealtimeProxyCredentials } from "../../src/utils/realtime-proxy-auth";

describe("Realtime opaque API key proxy translation", () => {
  test("rewrites query, header, and matching bearer key", () => {
    const translated = translateRealtimeProxyCredentials({
      url: new URL("https://project.example/realtime/v1/websocket?apikey=sb_publishable_client&vsn=2.0.0"),
      requestHeaders: new Headers({
        apikey: "sb_publishable_client",
        authorization: "Bearer sb_publishable_client",
        "sec-websocket-protocol": "phoenix",
      }),
      candidateKey: "sb_publishable_client",
      resolved: {
        ref: "project",
        kind: "publishable",
        role: "anon",
        upstreamKey: "legacy-anon-jwt",
      },
    });

    expect(translated.search).toContain("apikey=legacy-anon-jwt");
    expect(translated.search).toContain("vsn=2.0.0");
    expect(translated.forwardHeaders.apikey).toBe("legacy-anon-jwt");
    expect(translated.forwardHeaders.authorization).toBe("Bearer legacy-anon-jwt");
    expect(translated.forwardHeaders["sec-websocket-protocol"]).toBe("phoenix");
  });

  test("preserves a user JWT while translating an opaque apikey", () => {
    const translated = translateRealtimeProxyCredentials({
      url: new URL("https://project.example/realtime/v1/websocket?apikey=sb_secret_client"),
      requestHeaders: new Headers({
        apikey: "sb_secret_client",
        authorization: "Bearer user.session.jwt",
      }),
      candidateKey: "sb_secret_client",
      resolved: {
        ref: "project",
        kind: "secret",
        role: "service_role",
        upstreamKey: "legacy-service-jwt",
      },
    });

    expect(translated.search).toContain("apikey=legacy-service-jwt");
    expect(translated.forwardHeaders.apikey).toBe("legacy-service-jwt");
    expect(translated.forwardHeaders.authorization).toBe("Bearer user.session.jwt");
  });
});
