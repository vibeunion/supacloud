import { afterEach, describe, expect, test } from "bun:test";
import { chatProvider } from "./provider";

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
