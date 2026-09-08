import { expect, test } from "bun:test";
import { createContractCommandClient } from "./contract_client";

const decode = (value: unknown): { id: string } => {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") throw Error("bad");
  return { id: value.id };
};
test("invalid input never sends or looks up", async () => {
  let calls = 0;
  const client = createContractCommandClient({ input: decode, result: decode }, {
    send: async () => { calls++; }, lookup: async () => { calls++; }, matches: () => true,
  });
  // @ts-expect-error Invalid input is rejected by both TypeScript and the decoder.
  await expect(client({})).rejects.toMatchObject({ code: "HTTP_CONTRACT_INVALID" });
  expect(calls).toBe(0);
});
test("lost or malformed response confirms with one read, never another write", async () => {
  for (const response of ["throw", {}, { id: "wrong" }]) {
    let sends = 0, reads = 0;
    const client = createContractCommandClient({ input: decode, result: decode }, {
      send: async () => { sends++; if (response === "throw") throw Error("lost"); return response; },
      lookup: async () => { reads++; return { id: "request" }; },
      matches: (input, result) => input.id === result.id,
    });
    expect(await client({ id: "request" })).toMatchObject({ status: "confirmed", source: "lookup" });
    expect([sends, reads]).toEqual([1, 1]);
  }
});
test("mismatched lookup remains unknown; successful response does not look up", async () => {
  let sends = 0, reads = 0;
  const client = createContractCommandClient({ input: decode, result: decode }, {
    send: async (input) => { sends++; return input.id === "ok" ? input : {}; },
    lookup: async () => { reads++; return { id: "other-request" }; },
    matches: (input, result) => input.id === result.id,
  });
  expect(await client({ id: "unknown" })).toEqual({ status: "unknown" });
  expect(await client({ id: "ok" })).toMatchObject({ status: "confirmed", source: "response" });
  expect([sends, reads]).toEqual([2, 1]);
});

test("explicit domain denial is preserved without receipt lookup", async () => {
  const denied = new Error("denied");
  let reads = 0;
  const client = createContractCommandClient({ input: decode, result: decode }, {
    send: async () => { throw denied; }, lookup: async () => { reads++; },
    matches: () => true, isDefinitiveFailure: (error) => error === denied,
  });
  await expect(client({ id: "request" })).rejects.toBe(denied);
  expect(reads).toBe(0);
});

test("runtime matchers must return literal true, not truthy strings or promises", async () => {
  for (const invalid of ["false", Promise.resolve(false)]) {
    const client = createContractCommandClient({ input: decode, result: decode }, {
      send: async (input) => input,
      lookup: async (input) => input,
      // @ts-expect-error JavaScript callers can violate the matcher return type.
      matches: () => invalid,
    });
    expect(await client({ id: "request" })).toEqual({ status: "unknown" });
  }
});
