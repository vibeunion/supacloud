import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { Elysia } from "elysia";
import { resolveMaxBodySizeBytes, resolveMaxHttpBodySizeBytes } from "./worker-pool";

const mebibyte = 1024 * 1024;

test("default and invalid settings preserve worker and listener limits", () => {
  for (const value of ["", "invalid", "0", "-1", "Infinity"]) {
    expect(resolveMaxBodySizeBytes(value)).toBe(30 * mebibyte);
    expect(resolveMaxHttpBodySizeBytes(value)).toBe(128 * mebibyte);
  }
  expect(resolveMaxBodySizeBytes("16")).toBe(16 * mebibyte);
  expect(resolveMaxHttpBodySizeBytes("16")).toBe(128 * mebibyte);
});

test("configured 501 MiB reaches both worker and listener", () => {
  expect(resolveMaxBodySizeBytes("501")).toBe(501 * mebibyte);
  expect(resolveMaxHttpBodySizeBytes("501")).toBe(501 * mebibyte);
  const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  expect(source).toContain("maxRequestBodySize: resolveMaxHttpBodySizeBytes()");
});

function probe(port: number, bytes: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1", port, path: "/upload", method: "POST",
      headers: { "content-length": String(bytes), "content-type": "application/octet-stream" },
    }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body });
        outgoing.destroy();
      });
      response.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error("listener did not respond")));
    outgoing.flushHeaders();
  });
}

test("real HTTP listener accepts large headers through 501 MiB and rejects one byte over", async () => {
  const app = new Elysia()
    .post("/upload", () => new Response("application gate reached", { status: 401 }), { parse: "none" })
    .listen({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: resolveMaxHttpBodySizeBytes("501") });
  try {
    const port = app.server?.port;
    if (!port) throw new Error("missing test listener");
    for (const size of [129 * mebibyte, 215 * mebibyte, 500 * mebibyte, 501 * mebibyte]) {
      expect(await probe(port, size)).toEqual({ status: 401, body: "application gate reached" });
    }
    expect((await probe(port, 501 * mebibyte + 1)).status).toBe(413);
  } finally {
    await app.stop(true);
  }
});
