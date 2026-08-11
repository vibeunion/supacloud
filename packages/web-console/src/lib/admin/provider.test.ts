import { afterEach, describe, expect, test } from "bun:test";
import { chatProvider, dataProvider } from "./provider";

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

async function getList(payload: unknown, input: {
  resource: string;
  current?: number;
  pageSize?: number;
  meta?: Record<string, unknown>;
}) {
  let requestedUrl = "";
  globalThis.fetch = async (request) => {
    requestedUrl = String(request);
    return Response.json(payload);
  };

  const result = await dataProvider.getList({
    resource: input.resource,
    pagination: { current: input.current ?? 1, pageSize: input.pageSize ?? 10 },
    meta: input.meta,
  });
  return { requestedUrl, result };
}

describe("dataProvider resource adapters", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("normalizes GoTrue user lists through the public provider", async () => {
    const { result } = await getList(
      { users: [{ id: "user-1" }], total: 9 },
      { resource: "auth/users" },
    );

    expect(result).toEqual({
      data: [{ id: "user-1" }],
      total: 9,
    });
  });

  test("normalizes frontend deployment lists", async () => {
    const { result } = await getList(
      { deployments: [{ id: "site-1" }] },
      { resource: "frontend/deployments" },
    );

    expect(result).toEqual({
      data: [{ id: "site-1" }],
      total: 1,
    });
  });

  test("uses the function-log envelope and preserves cursor metadata", async () => {
    const { result } = await getList(
      {
        logs: [{ id: "log-1" }],
        total: 7,
        nextCursor: "cursor-2",
        backend: "vector",
      },
      { resource: "v1/projects/project-a/functions/send-email/logs" },
    );

    expect(result).toEqual({
      data: [{ id: "log-1" }],
      total: 7,
      nextCursor: "cursor-2",
      backend: "vector",
    });
  });

  test("injects stable page identities for table rows without mutating the API payload", async () => {
    const payload = {
      data: [{ value: "first" }, { value: "second" }],
      total: 12,
      snapshot: "page-2",
    };
    const { requestedUrl, result } = await getList(payload, {
      resource: "v1/projects/alpha/database/tables/public/events/rows",
      current: 2,
      pageSize: 2,
      meta: { tableRowIdentityKey: "__svadmin_row_id", tenantId: "alpha" },
    });

    expect(new URL(requestedUrl).searchParams.get("_page")).toBe("2");
    expect(new URL(requestedUrl).searchParams.get("_limit")).toBe("2");
    expect(result).toEqual({
      data: [
        { value: "first", __svadmin_row_id: "v1/projects/alpha/database/tables/public/events/rows:2" },
        { value: "second", __svadmin_row_id: "v1/projects/alpha/database/tables/public/events/rows:3" },
      ],
      total: 12,
      snapshot: "page-2",
    });
    expect(payload.data).toEqual([{ value: "first" }, { value: "second" }]);
  });

  test("rejects malformed table-row envelopes instead of rendering ambiguous records", async () => {
    await expect(getList(
      { rows: [{ value: "wrong-key" }] },
      {
        resource: "v1/projects/alpha/database/tables/public/events/rows",
        meta: { tableRowIdentityKey: "__svadmin_row_id" },
      },
    )).rejects.toThrow("Expected an object containing data");

    await expect(getList(
      { data: [null], total: 1 },
      {
        resource: "v1/projects/alpha/database/tables/public/events/rows",
        meta: { tableRowIdentityKey: "__svadmin_row_id" },
      },
    )).rejects.toThrow("Expected object records");
  });
});
