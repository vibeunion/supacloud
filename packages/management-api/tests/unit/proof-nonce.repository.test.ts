// @supacloud-test-isolate
import { describe, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import {
  consumeProofNonce,
  parseProofNonceReceipt,
  ProofNonceUnavailableError,
} from "../../src/repositories/proof-nonce.repository";

const nonce = "nonce-0123456789abcdef";
const expiresAt = new Date("2030-01-01T00:00:00Z");
const row = { nonce, expires_at: expiresAt };

describe("proof nonce receipts", () => {
  test("accepts a matching receipt and rejects an already-consumed nonce", () => {
    expect(parseProofNonceReceipt([row], nonce, expiresAt)).toBe(true);
    expect(parseProofNonceReceipt([], nonce, expiresAt)).toBe(false);
  });

  for (const rows of [undefined, null, {}, "rows", [null], [row, row],
    [{ nonce }], [{ ...row, nonce: "other-nonce" }],
    [{ ...row, expires_at: expiresAt.toISOString() }],
    [{ ...row, expires_at: new Date(expiresAt.getTime() + 1) }],
    [{ ...row, expires_at: new Date(NaN) }]]) {
    test(`rejects malformed receipt ${JSON.stringify(rows)}`, () => {
      expect(() => parseProofNonceReceipt(rows, nonce, expiresAt))
        .toThrow(ProofNonceUnavailableError);
    });
  }

  test("invalid keys and expiry dates do not open a database transaction", async () => {
    const database = new SQL("postgres://fixture:synthetic@127.0.0.1:1/unused", { connectionTimeout: 1 });
    const begin = spyOn(database, "begin").mockImplementation(() => {
      throw new Error("Unexpected nonce transaction");
    });
    try {
      for (const invalid of ["", "bad\nkey", "x".repeat(129), "injected';--"]) {
        await expect(consumeProofNonce(invalid, expiresAt, database))
          .rejects.toBeInstanceOf(ProofNonceUnavailableError);
      }
      for (const invalid of [new Date(0), new Date(NaN)]) {
        await expect(consumeProofNonce(nonce, invalid, database))
          .rejects.toBeInstanceOf(ProofNonceUnavailableError);
      }
      expect(begin).not.toHaveBeenCalled();
    } finally {
      begin.mockRestore();
      await database.close();
    }
  });

  test("database failures are sanitized and are not retried", async () => {
    const database = new SQL("postgres://fixture:synthetic@127.0.0.1:1/unused", { connectionTimeout: 1 });
    const begin = spyOn(database, "begin").mockImplementation(() => {
      throw new Error("internal credentials and SQL must not escape");
    });
    try {
      let failure: unknown;
      try {
        await consumeProofNonce(nonce, expiresAt, database);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ProofNonceUnavailableError);
      if (!(failure instanceof ProofNonceUnavailableError)) throw new Error("Expected a safe nonce error");
      expect(failure.toJSON()).toEqual({
        code: "PROOF_NONCE_UNAVAILABLE",
        message: "Delegated proof replay protection unavailable",
      });
      expect(begin).toHaveBeenCalledTimes(1);
    } finally {
      begin.mockRestore();
      await database.close();
    }
  });
});
