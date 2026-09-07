import { describe, expect, test } from "bun:test";
import { HttpClient } from "./http_client";
import { HttpContractError, type HttpContract } from "./http_contract";

const contract: HttpContract<{ name: string }, { version: number }> = {
  input(value) {
    if (!value || typeof value !== "object" || !("name" in value)
      || typeof value.name !== "string" || !value.name.trim()) throw new Error("private input");
    return { name: value.name.trim() };
  },
  result(value) {
    if (!value || typeof value !== "object" || !("version" in value)
      || !Number.isSafeInteger(value.version) || Number(value.version) < 1) throw new Error("private result");
    return value as { version: number };
  },
  request: (input) => ({ method: "POST", url: "/items", body: input }),
};

describe("HttpClient contract execution", () => {
  test("validates before transport and preserves interceptors and headers", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new HttpClient({
      baseUrl: "https://example.test",
      fetch: (async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ version: 2 });
      }) as typeof fetch,
    }, [async (req, next) => next({ ...req, headers: { ...req.headers, traced: "yes" } })]);
    await expect(client.execute(contract, { name: "" })).rejects.toMatchObject({ boundary: "request" });
    expect(calls).toHaveLength(0);
    expect(await client.execute(contract, { name: " item " }, { headers: { "Idempotency-Key": "same" } }))
      .toEqual({ version: 2 });
    expect(calls[0]?.url).toBe("https://example.test/items");
    expect(calls[0]?.init?.body).toBe('{"name":"item"}');
    expect(calls[0]?.init?.headers).toMatchObject({ "Idempotency-Key": "same", traced: "yes" });
  });

  test("invalid receipts are sanitized and never replayed", async () => {
    let calls = 0;
    const client = new HttpClient({ fetch: (async () => {
      calls++;
      return Response.json({ version: "private result" });
    }) as unknown as typeof fetch });
    const error = await client.execute(contract, { name: "item" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HttpContractError);
    expect(error).toMatchObject({ boundary: "response" });
    expect(String(error)).not.toContain("private result");
    expect(calls).toBe(1);
  });

  test("HTTP failures are not reclassified as schema errors", async () => {
    const client = new HttpClient({ fetch: (async () => Response.json({ code: "denied" }, { status: 403 })) as unknown as typeof fetch });
    await expect(client.execute(contract, { name: "item" })).rejects.toMatchObject({ status: 403 });
  });

  test("JSON receipts reject empty and malformed bodies without replay", async () => {
    for (const response of [
      new Response(null, { status: 204 }),
      new Response("{broken", { headers: { "content-type": "application/json" } }),
    ]) {
      let calls = 0;
      const client = new HttpClient({ fetch: (async () => { calls++; return response; }) as unknown as typeof fetch });
      await expect(client.execute(contract, { name: "item" })).rejects.toMatchObject({ boundary: "response" });
      expect(calls).toBe(1);
    }
  });
});

// Checked by typecheck:test; never executed at runtime.
function contractTypes(client: HttpClient) {
  const result: Promise<{ version: number }> = client.execute(contract, { name: "item" });
  // @ts-expect-error Input must be inferred from the contract, not widened by the argument.
  client.execute(contract, { name: 1 });
  // @ts-expect-error Contract owns the request body.
  client.execute(contract, { name: "item" }, { body: {} });
  return result;
}
