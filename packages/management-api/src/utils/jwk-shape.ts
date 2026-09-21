import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { JWK } from "jose";
import { isRecord } from "./project-config";

const optionalString = Type.Optional(Type.String());
const shape = Type.Object({
  kty: Type.String({ minLength: 1 }),
  alg: optionalString,
  kid: optionalString,
  use: optionalString,
  ext: Type.Optional(Type.Boolean()),
  key_ops: Type.Optional(Type.Array(Type.String())),
  x5c: Type.Optional(Type.Array(Type.String())),
  x5t: optionalString,
  "x5t#S256": optionalString,
  x5u: optionalString,
  crv: optionalString,
  d: optionalString,
  dp: optionalString,
  dq: optionalString,
  e: optionalString,
  k: optionalString,
  n: optionalString,
  p: optionalString,
  q: optionalString,
  qi: optionalString,
  x: optionalString,
  y: optionalString,
  pub: optionalString,
  priv: optionalString,
  oth: Type.Optional(Type.Array(Type.Object({
    d: optionalString, r: optionalString, t: optionalString,
  }))),
});

// This validates representation only. jose still imports and verifies actual key material.
export function parseJwkShape(value: unknown): JWK | null {
  if (!isRecord(value)) return null;
  for (const field of Object.keys(shape.properties)) {
    if (field in value && value[field] === undefined) return null;
  }
  if (Array.isArray(value.oth)) {
    for (const prime of value.oth) {
      if (!isRecord(prime)) return null;
      for (const field of ["d", "r", "t"]) {
        if (field in prime && prime[field] === undefined) return null;
      }
    }
  }
  return Value.Check(shape, value) ? value : null;
}

export function parseJwkArray(value: unknown): JWK[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const result: JWK[] = [];
  for (const item of value) {
    const key = parseJwkShape(item);
    if (!key) return null;
    result.push(key);
  }
  return result;
}
