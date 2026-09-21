import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SignedUpload } from "../services/storage-store";

const text = Type.String({ minLength: 1, pattern: "^[^\\u0000]+$" });
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const uploadSchema = Type.Object({
  ref: text,
  bucket: text,
  objectName: text,
  upsert: Type.Boolean(),
  expiresAt: integer,
  auth_token: Type.Optional(Type.String()),
});
const rowSchema = Type.Object({
  token: text,
  ref: text,
  bucket: text,
  object_name: text,
  upsert: Type.Boolean(),
  expires_at: Type.Union([integer, Type.BigInt({ minimum: 0n }), Type.String({ pattern: "^(0|[1-9][0-9]*)$" })]),
  auth_token: Type.Union([Type.String(), Type.Null()]),
});

export class InvalidSignedUploadError extends Error {
  constructor() {
    super("Invalid signed upload record");
    this.name = "InvalidSignedUploadError";
  }
}

export function assertSignedUploadToken(token: unknown): asserts token is string {
  if (!Value.Check(text, token)) throw new InvalidSignedUploadError();
}

export function copySignedUpload(input: unknown): SignedUpload {
  if (!Value.Check(uploadSchema, input)) throw new InvalidSignedUploadError();
  return {
    ref: input.ref,
    bucket: input.bucket,
    objectName: input.objectName,
    upsert: input.upsert,
    expiresAt: input.expiresAt,
    ...(input.auth_token === undefined ? {} : { auth_token: input.auth_token }),
  };
}

export function readSignedUploadRows(rows: unknown, token: string): SignedUpload | null {
  if (!Array.isArray(rows) || rows.length > 1) throw new InvalidSignedUploadError();
  if (rows.length === 0) return null;
  const row: unknown = rows[0];
  if (!Value.Check(rowSchema, row) || row.token !== token) throw new InvalidSignedUploadError();
  const expiresAt = Number(row.expires_at);
  if (!Number.isSafeInteger(expiresAt)) throw new InvalidSignedUploadError();
  return copySignedUpload({
    ref: row.ref,
    bucket: row.bucket,
    objectName: row.object_name,
    upsert: row.upsert,
    expiresAt,
    ...(row.auth_token === null ? {} : { auth_token: row.auth_token }),
  });
}
