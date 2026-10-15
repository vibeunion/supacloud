import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  createAuthoritativeCommandClient,
  type AuthoritativeCommandContract,
  type AuthoritativeCommandOutcome,
} from "./contract_client";
import { createPendingCommandClient } from "./client";

function input(value: unknown): { id: string } {
  if (!value || typeof value !== "object" || !("id" in value)
    || typeof value.id !== "string" || !value.id.trim()) throw new Error("private input");
  return { id: value.id.trim() };
}

function acknowledgement(value: unknown): { accepted: boolean } {
  if (!value || typeof value !== "object" || !("accepted" in value)
    || value.accepted !== true) throw new Error("private acknowledgement");
  return { accepted: value.accepted };
}

function authority(value: unknown): { id: string; enabled: boolean } {
  const decoded = input(value);
  if (!value || typeof value !== "object" || !("enabled" in value)
    || typeof value.enabled !== "boolean") throw new Error("private authority");
  return { ...decoded, enabled: value.enabled };
}

const contract = {
  input, acknowledgement, authority,
  matches: (request, state) => request.id === state.id && state.enabled,
} satisfies AuthoritativeCommandContract<
  ReturnType<typeof input>, ReturnType<typeof acknowledgement>, ReturnType<typeof authority>
>;

const state = { id: "target", enabled: true };

describe("authoritative command confirmation", () => {
  test("invalid input has no network effects and only sanitized diagnostics", async () => {
    let calls = 0;
    const client = createAuthoritativeCommandClient(contract, {
      send: async () => { calls++; },
      lookup: async () => { calls++; },
    });
    expect(await client(null)).toEqual({
      status: "invalid", diagnostics: [{ stage: "input", code: "INVALID_INPUT" }],
    });
    expect(calls).toBe(0);
  });

  test("valid acknowledgements still require authority by default; decoders transform once", async () => {
    let inputs = 0, acks = 0, authorities = 0, writes = 0, reads = 0;
    const client = createAuthoritativeCommandClient({
      ...contract,
      input: (value) => { inputs++; return input(value); },
      acknowledgement: (value) => { acks++; return acknowledgement(value); },
      authority: (value) => { authorities++; return authority(value); },
    }, {
      send: async (value) => { writes++; expect(value).toEqual({ id: "target" }); return { accepted: true }; },
      lookup: async (value) => { reads++; expect(value).toEqual({ id: "target" }); return state; },
    });
    expect(await client({ id: " target " })).toEqual({
      status: "confirmed", authority: state, source: "lookup",
      acknowledgement: { status: "validated", value: { accepted: true } }, diagnostics: [],
    });
    expect([inputs, acks, authorities, writes, reads]).toEqual([1, 1, 1, 1, 1]);
  });

  test("a failed read is cached by the execution flow, never retried or reclassified", async () => {
    let writes = 0, reads = 0, classifications = 0;
    const client = createAuthoritativeCommandClient(contract, {
      send: async () => { writes++; return { accepted: true }; },
      lookup: async () => { reads++; throw new Error("403 private read"); },
      isDefinitiveWriteFailure: () => { classifications++; return true; },
    });
    expect(await client({ id: "target" })).toEqual({
      status: "unknown", acknowledgement: { status: "validated", value: { accepted: true } },
      diagnostics: [{ stage: "lookup", code: "LOOKUP_FAILED" }],
    });
    expect([writes, reads, classifications]).toEqual([1, 1, 0]);
  });

  for (const status of [401, 403, 409, 500]) {
    test(`post-write ${status} is unknown by default and can be confirmed by lookup`, async () => {
      let writes = 0, reads = 0;
      const client = createAuthoritativeCommandClient(contract, {
        send: async () => { writes++; throw new Error(`${status} private token`); },
        lookup: async () => { reads++; return state; },
      });
      expect(await client({ id: "target" })).toEqual({
        status: "confirmed", authority: state, source: "lookup",
        acknowledgement: { status: "unavailable" },
        diagnostics: [{ stage: "write", code: "WRITE_OUTCOME_UNKNOWN" }],
      });
      expect([writes, reads]).toEqual([1, 1]);
    });
  }

  test("only explicit write denial skips lookup", async () => {
    const denied = new Error("private denial");
    let reads = 0;
    const client = createAuthoritativeCommandClient(contract, {
      send: async () => { throw denied; },
      lookup: async () => { reads++; },
      isDefinitiveWriteFailure: (error) => error === denied,
    });
    expect(await client({ id: "target" })).toEqual({
      status: "denied", diagnostics: [{ stage: "write", code: "WRITE_REJECTED" }],
    });
    expect(reads).toBe(0);
  });

  test("acknowledgement decoder failures cannot masquerade as write denial", async () => {
    let classifications = 0, reads = 0;
    const client = createAuthoritativeCommandClient(contract, {
      send: async () => ({ secret: "private acknowledgement" }),
      lookup: async () => { reads++; return state; },
      isDefinitiveWriteFailure: () => { classifications++; return true; },
    });
    expect(await client({ id: "target" })).toEqual({
      status: "confirmed", authority: state, source: "lookup",
      acknowledgement: { status: "unavailable" },
      diagnostics: [{ stage: "acknowledgement", code: "INVALID_ACKNOWLEDGEMENT" }],
    });
    expect([reads, classifications]).toEqual([1, 0]);
  });

  test("throwing denial classifiers retain uncertainty without leaking errors", async () => {
    const client = createAuthoritativeCommandClient(contract, {
      send: async () => { throw new Error("private write"); },
      lookup: async () => { throw new Error("private read"); },
      isDefinitiveWriteFailure: () => { throw new Error("private classifier"); },
    });
    expect(await client(state)).toEqual({
      status: "unknown", acknowledgement: { status: "unavailable" },
      diagnostics: [
        { stage: "classification", code: "CLASSIFICATION_FAILED" },
        { stage: "write", code: "WRITE_OUTCOME_UNKNOWN" },
        { stage: "lookup", code: "LOOKUP_FAILED" },
      ],
    });
  });

  for (const result of [null, {}, { id: "other", enabled: true }, { id: "target", enabled: false }]) {
    test(`invalid or mismatched authority remains unknown: ${JSON.stringify(result)}`, async () => {
      const client = createAuthoritativeCommandClient(contract, {
        send: async () => ({ accepted: true }), lookup: async () => result,
      });
      expect((await client(state)).status).toBe("unknown");
    });
  }

  test("matcher exceptions are sanitized, do not escape, and never cause another lookup", async () => {
    let reads = 0, classifications = 0;
    const client = createAuthoritativeCommandClient({
      ...contract, matches: () => { throw new Error("private match"); },
    }, {
      send: async () => ({ accepted: true }), lookup: async () => { reads++; return state; },
      isDefinitiveWriteFailure: () => { classifications++; return true; },
    });
    expect((await client(state)).diagnostics).toEqual([{ stage: "authority", code: "AUTHORITY_MISMATCH" }]);
    expect([reads, classifications]).toEqual([1, 0]);
  });

  test("response mode explicitly validates authority against raw response, not transformed acknowledgement", async () => {
    let reads = 0;
    const client = createAuthoritativeCommandClient(contract, {
      send: async () => ({ ...state, accepted: true }),
      lookup: async () => { reads++; },
    }, { confirmation: "response" });
    expect(await client(state)).toMatchObject({
      status: "confirmed", authority: state, source: "response",
      acknowledgement: { status: "validated", value: { accepted: true } },
    });
    expect(reads).toBe(0);
  });

  test("response mode falls back to exactly one lookup on invalid or mismatched responses", async () => {
    for (const response of [{ accepted: true }, { ...state, id: "other", accepted: true }, {}]) {
      let sends = 0, reads = 0;
      const client = createAuthoritativeCommandClient(contract, {
        send: async () => { sends++; return response; },
        lookup: async () => { reads++; return state; },
      }, { confirmation: "response" });
      expect(await client(state)).toMatchObject({ status: "confirmed", source: "lookup", authority: state });
      expect([sends, reads]).toEqual([1, 1]);
    }
  });

  test("concurrent executions never share authority or diagnostics", async () => {
    const client = createAuthoritativeCommandClient(contract, {
      send: async () => ({ accepted: true }),
      lookup: async ({ id }) => ({ id, enabled: true }),
    });
    const outcomes = await Promise.all([client({ id: "first" }), client({ id: "second" })]);
    expect(outcomes[0]).toMatchObject({ authority: { id: "first" } });
    expect(outcomes[1]).toMatchObject({ authority: { id: "second" } });
    expectTypeOf<Awaited<ReturnType<typeof client>>>().toEqualTypeOf<AuthoritativeCommandOutcome<
      ReturnType<typeof acknowledgement>, ReturnType<typeof authority>
    >>();
  });

  test("untyped matcher and classifier results must be literal true", async () => {
    for (const invalid of ["yes", Promise.resolve(true)]) {
      const configuration = {
        ...contract,
        matches: () => invalid,
      };
      const create: unknown = Reflect.apply(createAuthoritativeCommandClient, undefined, [
        configuration,
        { send: async () => ({ accepted: true }), lookup: async () => state },
      ]);
      if (typeof create !== "function") throw new Error("Expected command client");
      const result: unknown = await Reflect.apply(create, undefined, [state]);
      expect(result).toMatchObject({ status: "unknown" });

      const classify: unknown = Reflect.apply(createAuthoritativeCommandClient, undefined, [
        contract,
        {
          send: async () => { throw new Error("write failed"); },
          lookup: async () => state,
          isDefinitiveWriteFailure: () => invalid,
        },
      ]);
      if (typeof classify !== "function") throw new Error("Expected command client");
      const classified: unknown = await Reflect.apply(classify, undefined, [state]);
      expect(classified).toMatchObject({ status: "confirmed", source: "lookup" });
    }
  });

  test("invalid confirmation modes from JavaScript fail before network work", () => {
    let calls = 0;
    expect(() => Reflect.apply(createAuthoritativeCommandClient, undefined, [
      contract,
      { send: async () => { calls++; }, lookup: async () => { calls++; } },
      { confirmation: "truthy" },
    ])).toThrow("Invalid command confirmation mode");
    expect(calls).toBe(0);
  });
});

function pendingStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("pending command recovery", () => {
  const key = "tenant:actor:target";
  const unknownError = ({ id }: { id: string }, cause?: unknown) =>
    new Error(cause === undefined ? `unknown:${id}` : `lookup-unavailable:${id}`);
  const pendingContract = {
    input, acknowledgement: authority, responseAuthority: authority,
    authority: (value: unknown) => {
      if (!value || typeof value !== "object" || !("receipt" in value)) throw new Error("missing receipt");
      return authority(value.receipt);
    },
    matches: contract.matches,
  };

  test("direct responses and lookup receipts decode separately and share mandatory matching", async () => {
    for (const mode of ["response", "lost", "malformed", "foreign"] as const) {
      const storage = pendingStorage();
      let writes = 0, reads = 0;
      const client = createPendingCommandClient(pendingContract, {
        send: async () => {
          writes++;
          expect(storage.getItem(key)).toBe(JSON.stringify({ id: "target" }));
          if (mode === "lost") throw new Error("network");
          return mode === "malformed" ? {} : { ...state, id: mode === "foreign" ? "other" : state.id };
        },
        lookup: async () => { reads++; return { receipt: state }; },
      }, { storage, key, unknownError, confirmation: "response" });
      expect(await client({ id: "target" })).toEqual(state);
      expect([writes, reads]).toEqual([1, mode === "response" ? 0 : 1]);
      expect(storage.getItem(key)).toBeNull();
      expectTypeOf<Awaited<ReturnType<typeof client>>>().toEqualTypeOf<typeof state>();
    }
  });

  test("default confirmation still queries authority even after a valid response", async () => {
    const storage = pendingStorage();
    let reads = 0;
    const client = createPendingCommandClient(pendingContract, {
      send: async () => state,
      lookup: async () => { reads++; return { receipt: state }; },
    }, { storage, key, unknownError });
    expect(await client(state)).toEqual(state);
    expect(reads).toBe(1);
  });

  test("unavailable lookup differs from missing, malformed or foreign receipts; all retain pending", async () => {
    for (const mode of ["unavailable", "missing", "foreign"] as const) {
      const storage = pendingStorage();
      let writes = 0, reads = 0;
      const client = () => createPendingCommandClient(pendingContract, {
        send: async () => { writes++; throw new Error("network"); },
        lookup: async () => {
          reads++;
          if (mode === "unavailable") throw new Error("lookup offline");
          return mode === "missing" ? {} : { receipt: { ...state, id: "other" } };
        },
      }, { storage, key, unknownError });
      await expect(client()(state)).rejects.toThrow(mode === "unavailable" ? "lookup-unavailable:target" : "unknown:target");
      expect(storage.getItem(key)).toBe(JSON.stringify({ id: "target" }));
      // A newly constructed client represents reload; it must not send a new request.
      await expect(client()({ id: "new-request" })).rejects.toThrow("unknown:target");
      expect([writes, reads]).toEqual([1, 1]);
    }
  });

  test("storage write failure, silent loss and corrupt pending block network effects", async () => {
    for (const mode of ["throws", "lost", "corrupt"] as const) {
      const base = pendingStorage();
      if (mode === "corrupt") base.setItem(key, "{");
      const storage = {
        ...base,
        setItem: () => { if (mode === "throws") throw new Error("quota"); },
      };
      let calls = 0;
      const client = createPendingCommandClient(pendingContract, {
        send: async () => { calls++; return state; },
        lookup: async () => { calls++; return { receipt: state }; },
      }, { storage, key, unknownError });
      await expect(client(state)).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });

  test("definitive write denial clears pending and preserves the exact original error", async () => {
    const storage = pendingStorage();
    const denied = new Error("domain denial");
    let reads = 0;
    const client = createPendingCommandClient(pendingContract, {
      send: async () => { throw denied; },
      lookup: async () => { reads++; return { receipt: state }; },
      isDefinitiveWriteFailure: cause => cause === denied,
    }, { storage, key, unknownError });
    await expect(client(state)).rejects.toBe(denied);
    expect(storage.getItem(key)).toBeNull();
    expect(reads).toBe(0);
  });

  test("response decoder failures never enter write-denial classification", async () => {
    const storage = pendingStorage();
    let classifications = 0;
    const client = createPendingCommandClient({
      ...pendingContract, responseAuthority: () => { throw new Error("decoder failed"); },
    }, {
      send: async () => state, lookup: async () => ({ receipt: state }),
      isDefinitiveWriteFailure: () => { classifications++; return true; },
    }, { storage, key, unknownError, confirmation: "response" });
    expect(await client(state)).toEqual(state);
    expect(classifications).toBe(0);
  });

  test("concurrent calls in one context see the first pending marker before another send", async () => {
    const storage = pendingStorage();
    const response = Promise.withResolvers<typeof state>();
    let writes = 0;
    const client = createPendingCommandClient(pendingContract, {
      send: () => { writes++; return response.promise; },
      lookup: async () => ({ receipt: state }),
    }, { storage, key, unknownError, confirmation: "response" });
    const first = client(state);
    await expect(client({ id: "second" })).rejects.toThrow("unknown:target");
    response.resolve(state);
    expect(await first).toEqual(state);
    expect(writes).toBe(1);
  });

  test("late confirmation does not erase a replacement pending marker", async () => {
    const storage = pendingStorage();
    const next = JSON.stringify({ id: "replacement" });
    const client = createPendingCommandClient(pendingContract, {
      send: async () => { storage.setItem(key, next); return state; },
      lookup: async () => ({ receipt: state }),
    }, { storage, key, unknownError, confirmation: "response" });
    expect(await client(state)).toEqual(state);
    expect(storage.getItem(key)).toBe(next);
  });

  test("failed cleanup is observable and never resends a confirmed write", async () => {
    const storage = { ...pendingStorage(), removeItem: () => {} };
    let writes = 0;
    const client = createPendingCommandClient(pendingContract, {
      send: async () => { writes++; return state; },
      lookup: async () => ({ receipt: state }),
    }, { storage, key, unknownError, confirmation: "response" });
    await expect(client(state)).rejects.toThrow("Pending command was not cleared");
    await expect(client(state)).rejects.toThrow("unknown:target");
    expect(writes).toBe(1);
  });

  test("type contracts require recovery transport, matching and compatible response authority", () => {
    if (false) {
      const options = { storage: pendingStorage(), key, unknownError };
      // @ts-expect-error Recovery requires an explicit read-only lookup.
      createPendingCommandClient(pendingContract, { send: async () => state }, options);
      const { matches: _matches, ...unbound } = pendingContract;
      // @ts-expect-error Receipt matching is mandatory.
      createPendingCommandClient(unbound, { send: async () => state, lookup: async () => state }, options);
      createPendingCommandClient({
        ...pendingContract,
        // @ts-expect-error Direct and recovered authority must have the same result type.
        responseAuthority: () => "not an authority",
      }, { send: async () => state, lookup: async () => state }, options);
    }
    expect(true).toBe(true);
  });
});
