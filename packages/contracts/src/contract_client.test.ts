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

test("legacy decoder and matcher errors never enter write-denial classification", async () => {
  for (const failDecode of [true, false]) {
    let classifications = 0, reads = 0;
    const client = createContractCommandClient({
      input: decode,
      result: (value) => {
        if (failDecode) throw new Error("decoder denial");
        return decode(value);
      },
    }, {
      send: async (value) => value,
      lookup: async () => { reads++; return { id: "request" }; },
      matches: () => { throw new Error("matcher denial"); },
      isDefinitiveFailure: () => { classifications++; return true; },
    });
    expect(await client({ id: "request" })).toEqual({ status: "unknown" });
    expect([classifications, reads]).toEqual([0, 1]);
  }
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

test("server metadata overrides a legacy status-code denial classifier", async () => {
  let writes = 0, reads = 0;
  const client = createContractCommandClient({ input: decode, result: decode }, {
    send: async () => { writes++; throw new Error("private transport details"); },
    lookup: async input => { reads++; return input; },
    matches: (input, result) => input.id === result.id,
    failureMetadata: () => ({
      retryability: "read-only", idempotency: "required", deadlineAt: null, outcome: "unknown",
    }),
    isDefinitiveFailure: () => true,
  });
  expect(await client({ id: "same-key" })).toMatchObject({ status: "confirmed", source: "lookup" });
  expect([writes, reads]).toEqual([1, 1]);
});

test("invalid metadata or a broken classifier never makes an unknown write a denial", async () => {
  for (const mode of ["invalid", "throws"] as const) {
    const client = createContractCommandClient({ input: decode, result: decode }, {
      send: async () => { throw Error("private"); },
      lookup: async input => input,
      matches: (input, result) => input.id === result.id,
      failureMetadata: () => {
        if (mode === "throws") throw Error("classifier");
        return { outcome: "confirmed-failure" };
      },
      isDefinitiveFailure: () => true,
    });
    expect(await client({ id: "key" })).toMatchObject({ status: "confirmed", source: "lookup" });
  }
});

test("one deadline bounds an uncooperative write and never starts a second write or expired lookup", async () => {
  let writes = 0, reads = 0;
  let signal: AbortSignal | undefined;
  const client = createContractCommandClient({ input: decode, result: decode }, {
    send: async (_input, requestSignal) => {
      writes++; signal = requestSignal;
      return new Promise<never>(() => {});
    },
    lookup: async input => { reads++; return input; },
    matches: (input, result) => input.id === result.id,
  }, { timeoutMs: 20 });
  expect(await client({ id: "key" })).toEqual({ status: "unknown" });
  expect(signal?.aborted).toBe(true);
  expect([writes, reads]).toEqual([1, 0]);
});

test("lookup shares the original deadline and receives the same abort signal", async () => {
  let writeSignal: AbortSignal | undefined, lookupSignal: AbortSignal | undefined;
  const client = createContractCommandClient({ input: decode, result: decode }, {
    send: async (_input, signal) => { writeSignal = signal; throw Error("lost response"); },
    lookup: async (_input, signal) => { lookupSignal = signal; return new Promise<never>(() => {}); },
    matches: () => true,
  }, { timeoutMs: 20 });
  expect(await client({ id: "key" })).toEqual({ status: "unknown" });
  expect(writeSignal).toBe(lookupSignal);
  expect(lookupSignal?.aborted).toBe(true);
});

test("rejects invalid command deadline configuration before dispatch", () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
    expect(() => createContractCommandClient({ input: decode, result: decode }, {
      send: async value => value, matches: () => true,
    }, { timeoutMs })).toThrow("Invalid command deadline");
  }
});
