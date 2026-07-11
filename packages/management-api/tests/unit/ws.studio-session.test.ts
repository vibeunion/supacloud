import { describe, expect, test } from "bun:test";
import { closeTaskWebSocket, openTaskWebSocket } from "../../src/routes/ws";

describe("task WebSocket Studio session auth", () => {
  test("uses the browser Studio cookie when no query token is present", async () => {
    const sent: string[] = [];
    const closed: Array<{ code: number; reason?: string }> = [];
    const socket = {
      data: {
        request: new Request("https://console.example.com/ws/tasks?project=proj123", {
          headers: {
            cookie: "__Host-supacloud_session=opaque-session",
            origin: "https://console.example.com",
          },
        }),
      },
      send: (value: string) => sent.push(value),
      close: (code: number, reason?: string) => closed.push({ code, reason }),
    };

    await openTaskWebSocket(socket as never, async (request) => {
      expect(request.headers.get("cookie")).toContain("opaque-session");
      expect(new URL(request.url).pathname).toBe("/v1/projects/proj123");
      return { role: "admin", source: "cookie" };
    });

    expect(closed).toHaveLength(0);
    expect(sent.some((value) => value.includes('"type":"connected"'))).toBe(true);
    closeTaskWebSocket(socket as never);
  });

  test("rejects a cross-origin WebSocket that tries to reuse the Studio cookie", async () => {
    const closed: Array<{ code: number; reason?: string }> = [];
    let authCalls = 0;
    const socket = {
      data: {
        request: new Request("https://console.example.com/ws/tasks", {
          headers: {
            cookie: "__Host-supacloud_session=opaque-session",
            origin: "https://attacker.example.net",
          },
        }),
      },
      send: () => {},
      close: (code: number, reason?: string) => closed.push({ code, reason }),
    };

    await openTaskWebSocket(socket as never, async () => {
      authCalls += 1;
      return { role: "admin", source: "cookie" };
    });

    expect(authCalls).toBe(0);
    expect(closed).toEqual([{ code: 1008, reason: "Cross-origin session request denied" }]);
  });
});
