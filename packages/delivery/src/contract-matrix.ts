import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const closed = { additionalProperties: false } as const;
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const generation = Type.Union([Type.Literal("old"), Type.Literal("new")]);
const versions = Type.Object({ old: sha256, new: sha256 }, closed);

export const CONTRACT_MATRIX_SCHEMA = "supacloud.consumer-contract-matrix.v1";
export const FA_CONTRACT_SCENARIOS = [
  "missing-display-field", "missing-authority-field", "added-field",
  "legacy-envelope", "lost-write-response", "downgrade",
] as const;
export const FA_CONTRACT_COMBINATIONS = [
  "old/old/old", "old/old/new", "old/new/old", "old/new/new",
  "new/old/old", "new/old/new", "new/new/old", "new/new/new",
] as const;

export const ConsumerContractMatrixSchema = Type.Object({
  schema: Type.Literal(CONTRACT_MATRIX_SCHEMA),
  customer: Type.Literal("xigu-fa"),
  baseline_tuple_sha256: sha256,
  candidate_tuple_sha256: sha256,
  // Values are artifact/inventory digests, not invented semantic version labels.
  artifacts: Type.Object({ frontend: versions, functions: versions, database: versions }, closed),
  cases: Type.Array(Type.Object({
    frontend: generation,
    functions: generation,
    database: generation,
    scenarios: Type.Array(Type.Object({
      name: Type.Enum(FA_CONTRACT_SCENARIOS),
      expected: Type.Union([Type.Literal("compatible"), Type.Literal("blocked-safely")]),
    }, closed), { minItems: FA_CONTRACT_SCENARIOS.length, maxItems: FA_CONTRACT_SCENARIOS.length }),
  }, closed), { minItems: 8, maxItems: 8 }),
}, closed);

export type ConsumerContractMatrix = Static<typeof ConsumerContractMatrixSchema>;

/** This is a test plan, never a claim that a producer/consumer pair was exercised. */
export function parseConsumerContractMatrix(value: unknown): ConsumerContractMatrix {
  if (!Value.Check(ConsumerContractMatrixSchema, value)) throw new Error("Invalid consumer contract matrix.");
  const combinations = value.cases.map(row => `${row.frontend}/${row.functions}/${row.database}`);
  if (new Set(combinations).size !== 8
    || value.cases.some(row => new Set(row.scenarios.map(scenario => scenario.name)).size !== FA_CONTRACT_SCENARIOS.length)
    || value.cases.some(row => row.scenarios.some(scenario =>
      scenario.name === "missing-authority-field" && scenario.expected !== "blocked-safely"))) {
    throw new Error("Invalid consumer contract matrix.");
  }
  return structuredClone(value);
}
