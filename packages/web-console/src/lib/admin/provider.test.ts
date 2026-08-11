import { afterEach, describe, expect, test } from "bun:test";
import { chatProvider, parseListResponse } from "./provider";

const originalFetch = globalThis.fetch;

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("chatProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("buffers SSE lines split across chunks", async () => {
    globalThis.fetch = async () => new Response(streamFrom([
      'data: {"choices":[{"delta":{"content":"hel',
      'lo"}}]}\n',
      'data: [DONE]\n',
    ]), { status: 200 });

    const chunks: string[] = [];
    for await (const chunk of chatProvider.sendMessage([{ role: "user", content: "hi" } as any])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hello"]);
  });
});

describe("parseListResponse", () => {
  test("normalizes GoTrue user lists", () => {
    expect(parseListResponse({ users: [{ id: "user-1" }], total: 9 }, "auth/users")).toEqual({
      data: [{ id: "user-1" }],
      total: 9,
    });
  });

  test("normalizes frontend deployment lists", () => {
    expect(parseListResponse({ deployments: [{ id: "site-1" }] }, "frontend/deployments")).toEqual({
      data: [{ id: "site-1" }],
      total: 1,
    });
  });

  test("uses the function-log envelope and preserves cursor metadata", () => {
    expect(parseListResponse({
      logs: [{ id: "log-1" }],
      total: 7,
      nextCursor: "cursor-2",
      backend: "vector",
    }, "v1/projects/project-a/functions/send-email/logs")).toEqual({
      data: [{ id: "log-1" }],
      total: 7,
      nextCursor: "cursor-2",
      backend: "vector",
    });
  });
});
