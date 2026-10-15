import { test } from "bun:test";
import assert from "node:assert/strict";
import { createPendingCommandClient } from "./pending_command.js";

interface Input { id: string; amount: number }
function decode(value: unknown): Input {
  if (!value || typeof value !== "object" || !("id" in value) || !("amount" in value)
    || typeof value.id !== "string" || typeof value.amount !== "number") {
    throw new TypeError("Invalid input");
  }
  return { id: value.id, amount: value.amount };
}
function storageFixture() {
  const values = new Map<string, string>();
  let writes = 0;
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { writes++; values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
    writes: () => writes,
  };
}
const key = "tenant:actor:command:target";
const value = { id: "private-operation", amount: 1 };
const unknownError = () => new Error("Outcome unknown");
const contract = {
  input: decode, acknowledgement: decode, authority: decode,
  matches: (input: Input, receipt: Input) => input.id === receipt.id && input.amount === receipt.amount,
};

for (const confirmation of ["lookup", "response"] as const) {
  for (const [name, transform] of [
    ["identity", (input: Input): Input => ({ ...input, id: input.id + "-again" })],
    ["business value", (input: Input): Input => ({ ...input, amount: input.amount + 1 })],
    ["both", (input: Input): Input => ({ id: input.id + "-again", amount: input.amount + 1 })],
  ] as const) {
    test(`pending ${confirmation} rejects ${name} decoder drift before persistence or transport`, async () => {
      const fixture = storageFixture();
      let sends = 0, reads = 0;
      const client = createPendingCommandClient({
        ...contract, input: raw => transform(decode(raw)),
      }, {
        send: async input => { sends++; return input; },
        lookup: async input => { reads++; return input; },
      }, { storage: fixture.storage, key, confirmation, unknownError });
      await assert.rejects(client(value), {
        name: "TypeError", message: "Pending command input changes after serialization",
      });
      assert.deepEqual([fixture.writes(), sends, reads], [0, 0, 0]);
      assert.equal(fixture.storage.getItem(key), null);
    });
  }

  test(`pending ${confirmation} sends the persisted canonical input after stable normalization`, async () => {
    const fixture = storageFixture();
    let sends = 0, reads = 0;
    const canonical = { id: "private-operation", amount: 1 };
    const client = createPendingCommandClient({
      ...contract, input: raw => { const input = decode(raw); return { ...input, id: input.id.trim() }; },
    }, {
      send: async input => {
        sends++;
        assert.deepEqual(input, canonical);
        assert.equal(fixture.storage.getItem(key), JSON.stringify(input));
        return input;
      },
      lookup: async input => { reads++; assert.deepEqual(input, canonical); return input; },
    }, { storage: fixture.storage, key, confirmation, unknownError });
    assert.deepEqual(await client({ ...value, id: " private-operation " }), canonical);
    assert.deepEqual([sends, reads], [1, confirmation === "lookup" ? 1 : 0]);
    assert.equal(fixture.storage.getItem(key), null);
  });
}

test("pending preserves the persisted input after response loss and blocks a replacement write", async () => {
  const fixture = storageFixture();
  let sends = 0, reads = 0;
  const options = { storage: fixture.storage, key, unknownError };
  const transport = {
    send: async () => { sends++; throw new Error("Lost response"); },
    lookup: async () => { reads++; return null; },
  };
  const client = createPendingCommandClient(contract, transport, options);
  await assert.rejects(client(value), /Outcome unknown/);
  assert.equal(fixture.storage.getItem(key), JSON.stringify(value));
  const reloaded = createPendingCommandClient(contract, transport, options);
  await assert.rejects(reloaded({ id: "replacement", amount: 2 }), /Outcome unknown/);
  assert.deepEqual([sends, reads], [1, 1]);
  assert.equal(fixture.storage.getItem(key), JSON.stringify(value));
});

test("pending validation failure during JSON readback neither persists nor sends", async () => {
  const fixture = storageFixture();
  let decodes = 0, calls = 0;
  const client = createPendingCommandClient({
    ...contract, input: raw => { if (++decodes === 2) throw new Error("private decoder detail"); return decode(raw); },
  }, {
    send: async () => { calls++; return value; },
    lookup: async () => { calls++; return value; },
  }, { storage: fixture.storage, key, unknownError });
  await assert.rejects(client(value), { message: "HTTP request contract invalid" });
  assert.deepEqual([fixture.writes(), calls], [0, 0]);
});
