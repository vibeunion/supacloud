import { describe, expect, test } from "bun:test";
import { resolveProxyClientIp } from "../../src/utils/client-ip";

describe("resolveProxyClientIp", () => {
  test("uses the proxy-appended right-most IP instead of a spoofed prefix", () => {
    const request = new Request("https://console.example.com/auth/login", {
      headers: {
        "x-forwarded-for": "198.51.100.99, 203.0.113.10",
        "x-real-ip": "192.0.2.50",
      },
    });
    expect(resolveProxyClientIp(request, "127.0.0.1")).toBe("203.0.113.10");
  });

  test("rejects arbitrary header values and falls back to a valid real IP", () => {
    const request = new Request("https://console.example.com/auth/login", {
      headers: {
        "x-forwarded-for": "attacker-controlled-value",
        "x-real-ip": "2001:db8::10",
      },
    });
    expect(resolveProxyClientIp(request, "::1")).toBe("2001:db8::10");
  });

  test("ignores spoofed forwarding headers from a direct untrusted peer", () => {
    const request = new Request("http://server.example.com/auth/login", {
      headers: {
        "x-forwarded-for": "198.51.100.99",
        "x-real-ip": "198.51.100.100",
      },
    });
    expect(resolveProxyClientIp(request, "203.0.113.25")).toBe("203.0.113.25");
  });

  test("does not trust forwarding headers when the direct peer is unavailable", () => {
    const request = new Request("http://server.example.com/auth/login", {
      headers: { "x-forwarded-for": "198.51.100.99" },
    });
    expect(resolveProxyClientIp(request)).toBe("unknown");
  });
});
