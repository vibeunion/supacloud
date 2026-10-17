import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  createAuthoritativeCommandClient,
  type AuthoritativeCommandContract,
  type AuthoritativeCommandOutcome,
} from "./contract_client";
import { createPendingCommandClient, createPendingCommandRecovery } from "./client";

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

  test("send argument mutation cannot confirm a foreign response or clear the original marker", async () => {
    const storage = pendingStorage();
    let writes = 0, reads = 0;
    const foreign = { ...state, id: "foreign" };
    const client = createPendingCommandClient(pendingContract, {
      send: async request => { writes++; request.id = foreign.id; return foreign; },
      lookup: async () => { reads++; return { receipt: foreign }; },
    }, { storage, key, unknownError, confirmation: "response" });
    await expect(client({ id: "target" })).rejects.toThrow("unknown:target");
    expect([writes, reads]).toEqual([1, 1]);
    expect(storage.getItem(key)).toBe(JSON.stringify({ id: "target" }));
  });

  test("send argument mutation before response loss cannot redirect the recovery lookup", async () => {
    const storage = pendingStorage();
    let lookupInput: unknown;
    const client = createPendingCommandClient(pendingContract, {
      send: async request => { request.id = "foreign"; throw new Error("lost response"); },
      lookup: async request => { lookupInput = request; return { receipt: state }; },
    }, { storage, key, unknownError });
    expect(await client({ id: "target" })).toEqual(state);
    expect(lookupInput).toEqual({ id: "target" });
    expect(storage.getItem(key)).toBeNull();
  });

  test("lookup argument mutation cannot confirm a foreign receipt", async () => {
    const storage = pendingStorage();
    let writes = 0, reads = 0;
    const client = createPendingCommandClient(pendingContract, {
      send: async () => { writes++; return state; },
      lookup: async request => {
        reads++;
        request.id = "foreign";
        return { receipt: { ...state, id: request.id } };
      },
    }, { storage, key, unknownError });
    await expect(client({ id: "target" })).rejects.toThrow("unknown:target");
    expect([writes, reads]).toEqual([1, 1]);
    expect(storage.getItem(key)).toBe(JSON.stringify({ id: "target" }));
  });

  test("response matcher mutation cannot redirect the fallback lookup or its matcher", async () => {
    const storage = pendingStorage();
    let matches = 0;
    let lookupInput: unknown;
    const client = createPendingCommandClient({
      ...pendingContract,
      matches: (request, result) => {
        if (++matches === 1) { request.id = "foreign"; return false; }
        return contract.matches(request, result);
      },
    }, {
      send: async () => state,
      lookup: async request => { lookupInput = request; return { receipt: state }; },
    }, { storage, key, unknownError, confirmation: "response" });
    expect(await client({ id: "target" })).toEqual(state);
    expect(lookupInput).toEqual({ id: "target" });
    expect(matches).toBe(2);
    expect(storage.getItem(key)).toBeNull();
  });

  test("nested input is isolated from both decoder aliases and transport arguments", async () => {
    const storage = pendingStorage();
    let decoderAlias: { id: string; details: { version: number } } | undefined;
    let lookupInput: unknown;
    const client = createPendingCommandClient<
      { id: string; details: { version: number } }, typeof state, typeof state
    >({
      ...pendingContract,
      input: raw => {
        const value = input(raw);
        if (!raw || typeof raw !== "object" || !("details" in raw)
          || !raw.details || typeof raw.details !== "object" || !("version" in raw.details)
          || typeof raw.details.version !== "number") throw new Error("Invalid details");
        decoderAlias = { ...value, details: { version: raw.details.version } };
        return decoderAlias;
      },
    }, {
      send: async request => {
        if (decoderAlias) decoderAlias.details.version = 99;
        request.details.version = 42;
        return state;
      },
      lookup: async request => { lookupInput = request; return { receipt: state }; },
    }, { storage, key, unknownError });
    const original = { id: "target", details: { version: 1 } };
    expect(await client(original)).toEqual(state);
    expect(lookupInput).toEqual(original);
    expect(original.details.version).toBe(1);
  });

  test("failed lookup retains the persisted identity and original cause after callback mutation", async () => {
    const storage = pendingStorage();
    const unavailable = new Error("lookup offline");
    let mapped: unknown;
    const client = createPendingCommandClient(pendingContract, {
      send: async request => { request.id = "write-mutated"; throw new Error("lost response"); },
      lookup: async request => { request.id = "read-mutated"; throw unavailable; },
    }, {
      storage, key,
      unknownError: (original, cause) => { mapped = cause; return unknownError(original, cause); },
    });
    await expect(client({ id: "target" })).rejects.toThrow("lookup-unavailable:target");
    expect(mapped).toBe(unavailable);
    expect(storage.getItem(key)).toBe(JSON.stringify({ id: "target" }));
  });

  test("non-cloneable decoded input fails before persistence, send or denial classification", async () => {
    let writes = 0, calls = 0;
    const storage = { ...pendingStorage(), setItem: () => { writes++; } };
    const client = createPendingCommandClient<
      { id: string; callback: () => undefined }, typeof state, typeof state
    >({
      ...pendingContract,
      input: raw => ({ ...input(raw), callback: () => undefined }),
    }, {
      send: async () => { calls++; return state; },
      lookup: async () => { calls++; return { receipt: state }; },
      isDefinitiveWriteFailure: () => { calls++; return true; },
    }, { storage, key, unknownError });
    await expect(client({ id: "target", callback: () => undefined })).rejects.toThrow();
    expect([writes, calls]).toEqual([0, 0]);
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

  test("manual recovery after reload uses the stored input and never sends", async () => {
    const storage = pendingStorage();
    let writes = 0, reads = 0;
    const options = { storage, key, unknownError };
    const client = createPendingCommandClient(pendingContract, {
      send: async () => { writes++; throw new Error("lost response"); },
      lookup: async () => { reads++; return null; },
    }, options);
    await expect(client({ id: "target" })).rejects.toThrow("unknown:target");
    const recoveryTransport = {
      lookup: async (original: { id: string }) => {
        reads++;
        expect(original).toEqual({ id: "target" });
        return { receipt: state };
      },
      send: async () => { writes++; throw new Error("must not send"); },
    };
    const recover = createPendingCommandRecovery(pendingContract, recoveryTransport, options);
    expect(await recover()).toEqual({ input: { id: "target" }, authority: state });
    expect(storage.getItem(key)).toBeNull();
    expect(await recover()).toBeNull();
    expect([writes, reads]).toEqual([1, 2]);
    expectTypeOf<Awaited<ReturnType<typeof recover>>>().toEqualTypeOf<{
      input: { id: string }; authority: typeof state;
    } | null>();
  });

  test("manual recovery has no effects for an absent marker or invalid key", async () => {
    let calls = 0;
    const storage = { getItem: () => null, removeItem: () => { calls++; } };
    const transport = { lookup: async () => { calls++; return { receipt: state }; } };
    expect(await createPendingCommandRecovery(pendingContract, transport, { storage, key, unknownError })()).toBeNull();
    expect(() => createPendingCommandRecovery(pendingContract, transport, {
      storage, key: " ", unknownError,
    })).toThrow("Invalid pending command configuration");
    expect(calls).toBe(0);
  });

  test("manual recovery fails closed on corrupt, invalid or identity-changing stored input", async () => {
    for (const serialized of ["", "{", "null", "{}", '{"id":" target "}', '{"id":"target","extra":true}']) {
      const storage = pendingStorage();
      storage.setItem(key, serialized);
      let reads = 0;
      const recover = createPendingCommandRecovery(pendingContract, {
        lookup: async () => { reads++; return { receipt: state }; },
      }, { storage, key, unknownError });
      await expect(recover()).rejects.toThrow();
      expect(storage.getItem(key)).toBe(serialized);
      expect(reads).toBe(0);
    }
  });

  test("manual recovery compares JSON values without requiring stored whitespace or key order", async () => {
    const storage = pendingStorage();
    storage.setItem(key, ' { "enabled": true, "id": "target" } ');
    const recover = createPendingCommandRecovery({ ...pendingContract, input: authority }, {
      lookup: async original => { expect(original).toEqual(state); return { receipt: state }; },
    }, { storage, key, unknownError });
    expect(await recover()).toEqual({ input: state, authority: state });
    expect(storage.getItem(key)).toBeNull();
  });

  test("manual recovery retains pending on lookup failure, invalid authority or matcher failure", async () => {
    for (const mode of ["offline", "missing", "foreign", "uncommitted", "matcher"] as const) {
      const storage = pendingStorage();
      const serialized = JSON.stringify({ id: "target" });
      storage.setItem(key, serialized);
      let reads = 0;
      const failure = new Error("private lookup failure");
      let mappedCause: unknown;
      const recover = createPendingCommandRecovery({
        ...pendingContract,
        matches: (original, result) => {
          if (mode === "matcher") throw new Error("private matcher failure");
          return contract.matches(original, result);
        },
      }, {
        lookup: async () => {
          reads++;
          if (mode === "offline") throw failure;
          if (mode === "missing") return null;
          return { receipt: { ...state, id: mode === "foreign" ? "other" : "target", enabled: mode !== "uncommitted" } };
        },
      }, {
        storage, key,
        unknownError: (original, cause) => { mappedCause = cause; return unknownError(original, cause); },
      });
      await expect(recover()).rejects.toThrow(mode === "offline" ? "lookup-unavailable:target" : "unknown:target");
      expect(mappedCause).toBe(mode === "offline" ? failure : undefined);
      expect(storage.getItem(key)).toBe(serialized);
      expect(reads).toBe(1);
    }
  });

  test("manual recovery preserves a replacement while an old lookup is in flight", async () => {
    const storage = pendingStorage();
    storage.setItem(key, JSON.stringify({ id: "target" }));
    const response = Promise.withResolvers<unknown>();
    const recover = createPendingCommandRecovery(pendingContract, {
      lookup: () => response.promise,
    }, { storage, key, unknownError });
    const recovery = recover();
    const replacement = JSON.stringify({ id: "replacement" });
    storage.setItem(key, replacement);
    response.resolve({ receipt: state });
    expect(await recovery).toEqual({ input: { id: "target" }, authority: state });
    expect(storage.getItem(key)).toBe(replacement);
  });

  test("manual recovery cannot confirm an identity mutated by lookup", async () => {
    const storage = pendingStorage();
    const serialized = JSON.stringify({ id: "target" });
    storage.setItem(key, serialized);
    const recover = createPendingCommandRecovery(pendingContract, {
      lookup: async original => { original.id = "foreign"; return { receipt: { ...state, id: "foreign" } }; },
    }, { storage, key, unknownError });
    await expect(recover()).rejects.toThrow("unknown:target");
    expect(storage.getItem(key)).toBe(serialized);
  });

  test("manual recovery detaches aliases retained by the input decoder", async () => {
    const storage = pendingStorage();
    const serialized = JSON.stringify({ id: "target" });
    storage.setItem(key, serialized);
    let decoderAlias: { id: string } | undefined;
    const recover = createPendingCommandRecovery({
      ...pendingContract,
      input: raw => { decoderAlias = input(raw); return decoderAlias; },
    }, {
      lookup: async () => {
        if (decoderAlias) decoderAlias.id = "foreign";
        return { receipt: { ...state, id: "foreign" } };
      },
    }, { storage, key, unknownError });
    await expect(recover()).rejects.toThrow("unknown:target");
    expect(storage.getItem(key)).toBe(serialized);
  });

  test("manual recovery storage errors propagate instead of claiming successful cleanup", async () => {
    for (const mode of ["read", "remove", "silent"] as const) {
      const base = pendingStorage();
      const serialized = JSON.stringify({ id: "target" });
      base.setItem(key, serialized);
      const storage = {
        getItem: (name: string) => {
          if (mode === "read") throw new Error("storage read failed");
          return base.getItem(name);
        },
        removeItem: () => { if (mode === "remove") throw new Error("storage remove failed"); },
      };
      let reads = 0;
      const recover = createPendingCommandRecovery(pendingContract, {
        lookup: async () => { reads++; return { receipt: state }; },
      }, { storage, key, unknownError });
      await expect(recover()).rejects.toThrow(mode === "silent" ? "Pending command was not cleared" : `storage ${mode} failed`);
      expect(base.getItem(key)).toBe(serialized);
      expect(reads).toBe(mode === "read" ? 0 : 1);
    }
  });

  test("manual recovery type contracts require lookup and matching, not a write transport", () => {
    const checkTypeContracts = () => {
      const options = { storage: pendingStorage(), key, unknownError };
      const transport = { lookup: async () => ({ receipt: state }) };
      // @ts-expect-error Recovery requires a lookup.
      createPendingCommandRecovery(pendingContract, {}, options);
      const { matches: _matches, ...unbound } = pendingContract;
      // @ts-expect-error Receipt matching is mandatory for recovery.
      createPendingCommandRecovery(unbound, transport, options);
      // @ts-expect-error A fresh recovery transport cannot declare a send capability.
      createPendingCommandRecovery(pendingContract, { ...transport, send: async () => state }, options);
      const recover = createPendingCommandRecovery(pendingContract, transport, options);
      // @ts-expect-error Recovery reads storage; callers cannot substitute request identity.
      recover({ id: "different" });
    };
    expectTypeOf(checkTypeContracts).returns.toEqualTypeOf<void>();
  });

  test("type contracts require recovery transport, matching and compatible response authority", () => {
    const checkTypeContracts = () => {
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
    };
    expectTypeOf(checkTypeContracts).returns.toEqualTypeOf<void>();
  });
});
