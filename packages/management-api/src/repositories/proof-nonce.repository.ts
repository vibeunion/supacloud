import type { SQL } from "bun";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sql } from "../db";
import { AppError } from "../utils/errors";

export class ProofNonceUnavailableError extends AppError {
  constructor() {
    super("Delegated proof replay protection unavailable", 503, "PROOF_NONCE_UNAVAILABLE");
    this.name = "ProofNonceUnavailableError";
  }
}

const receiptSchema = Type.Array(Type.Object({
  nonce: Type.String({ minLength: 1, maxLength: 128 }),
  expires_at: Type.Date(),
}), { maxItems: 1 });

export function parseProofNonceReceipt(value: unknown, nonce: string, expiresAt: Date): boolean {
  if (!Value.Check(receiptSchema, value)) throw new ProofNonceUnavailableError();
  if (value.length === 0) return false;
  const row = value[0];
  if (!row || row.nonce !== nonce || row.expires_at.getTime() !== expiresAt.getTime()) {
    throw new ProofNonceUnavailableError();
  }
  return true;
}

export async function consumeProofNonce(
  nonce: string,
  expiresAt: Date,
  database: SQL = sql,
): Promise<boolean> {
  if (typeof nonce !== "string" || nonce.length < 1 || nonce.length > 128
    || /[^A-Za-z0-9._:-]/.test(nonce)
    || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= Date.now()) {
    throw new ProofNonceUnavailableError();
  }
  const expiry = new Date(expiresAt.getTime());
  try {
    return await database.begin(async transaction => {
      await transaction`
        DELETE FROM supaoauth_bff_proof_nonces
        WHERE expires_at <= NOW()
      `;
      const rows: unknown = await transaction`
        INSERT INTO supaoauth_bff_proof_nonces (nonce, expires_at)
        SELECT ${nonce}, ${expiry}
        WHERE ${expiry} > clock_timestamp()
        ON CONFLICT (nonce) DO NOTHING
        RETURNING nonce, expires_at
      `;
      return parseProofNonceReceipt(rows, nonce, expiry);
    });
  } catch {
    throw new ProofNonceUnavailableError();
  }
}

export const proofNonceRepository = { consume: consumeProofNonce };
