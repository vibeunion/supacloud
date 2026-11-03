import { Type } from "typebox";
import { Value } from "typebox/value";

export interface DatabaseContractManifest {
  readonly version: 1;
  readonly role: string;
  readonly fingerprint: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly migrationOrder: readonly string[];
  readonly outputs: Readonly<Record<string, string>>;
}

/** Stable, tool-readable metadata for generated database contracts. */
const databaseContractManifestSchema = Type.Object({
  version: Type.Literal(1),
  role: Type.String({ minLength: 1 }),
  fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  inputs: Type.Record(Type.String({ minLength: 1 }), Type.String({ pattern: "^[a-f0-9]{64}$" })),
  migrationOrder: Type.Array(Type.String({ minLength: 1 })),
  outputs: Type.Record(Type.String({ minLength: 1 }), Type.String({ pattern: "^[a-f0-9]{64}$" })),
});

export function parseDatabaseContractManifest(value: unknown): DatabaseContractManifest {
  if (!Value.Check(databaseContractManifestSchema, value)) {
    throw new TypeError("Invalid database contract manifest");
  }
  return value as DatabaseContractManifest;
}
