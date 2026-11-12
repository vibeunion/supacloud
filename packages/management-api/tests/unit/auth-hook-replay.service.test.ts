import { beforeEach, describe, expect, mock, test } from "bun:test";

const consumedKeys = new Set<string>();
const transaction = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?");
  if (query.includes("DELETE FROM supaoauth_bff_proof_nonces")) return Promise.resolve([]);
  if (query.includes("INSERT INTO supaoauth_bff_proof_nonces")) {
    const replayKey = String(values[0]);
    if (consumedKeys.has(replayKey)) return Promise.resolve([]);
    consumedKeys.add(replayKey);
    return Promise.resolve([{ nonce: replayKey }]);
  }
  return Promise.resolve([]);
});

const sql = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?");
  if (query.includes("DELETE FROM supaoauth_bff_proof_nonces") && query.includes("WHERE nonce")) {
    consumedKeys.delete(String(values[0]));
  }
  return Promise.resolve([]);
});

mock.module("../../src/db", () => ({
  sql: Object.assign(sql, {
    begin: async (command: (database: typeof transaction) => Promise<unknown>) => command(transaction),
  }),
}));

const { consumeAuthHookWebhookId, releaseAuthHookWebhookId } = await import("../../src/services/auth-hook-replay.service");

describe("auth hook replay guard", () => {
  beforeEach(() => {
    consumedKeys.clear();
    transaction.mockClear();
  });

  test("atomically consumes a project-scoped webhook ID once", async () => {
    const webhookId = "cf25da76-84af-4dca-8b75-b96ad5531d8a";
    expect(await consumeAuthHookWebhookId("proj_1", webhookId)).toBe(true);
    expect(await consumeAuthHookWebhookId("proj_1", webhookId)).toBe(false);
    expect(await consumeAuthHookWebhookId("proj_2", webhookId)).toBe(true);
  });

  test("rejects malformed webhook IDs before touching storage", async () => {
    expect(await consumeAuthHookWebhookId("proj_1", "id with spaces")).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  test("releases a reserved webhook ID after a failed delivery", async () => {
    const webhookId = "cf25da76-84af-4dca-8b75-b96ad5531d8a";
    expect(await consumeAuthHookWebhookId("proj_1", webhookId)).toBe(true);
    await releaseAuthHookWebhookId("proj_1", webhookId);
    expect(await consumeAuthHookWebhookId("proj_1", webhookId)).toBe(true);
  });
});
