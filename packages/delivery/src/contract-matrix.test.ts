import { expect, test } from "bun:test";
import {
  FA_CONTRACT_SCENARIOS, parseConsumerContractMatrix, type ConsumerContractMatrix,
} from "./contract-matrix";

function matrixFixture(): ConsumerContractMatrix {
  return {
    schema: "supacloud.consumer-contract-matrix.v1", customer: "xigu-fa",
    baseline_tuple_sha256: "a".repeat(64), candidate_tuple_sha256: "b".repeat(64),
    artifacts: {
      frontend: { old: "c".repeat(64), new: "d".repeat(64) },
      functions: { old: "e".repeat(64), new: "f".repeat(64) },
      database: { old: "1".repeat(64), new: "2".repeat(64) },
    },
    cases: (["old", "new"] as const).flatMap(frontend =>
      (["old", "new"] as const).flatMap(functions =>
        (["old", "new"] as const).map(database => ({
          frontend, functions, database,
          scenarios: FA_CONTRACT_SCENARIOS.map(name => ({
            name, expected: name === "missing-authority-field" ? "blocked-safely" as const : "compatible" as const,
          })),
        })))),
  };
}

test("requires all eight version combinations and all failure scenarios", () => {
  const matrix = matrixFixture();
  expect(parseConsumerContractMatrix(matrix)).toEqual(matrix);
  matrix.cases.pop();
  expect(() => parseConsumerContractMatrix(matrix)).toThrow("Invalid consumer contract matrix.");
});

test("rejects duplicate combinations or scenarios and authorization fallbacks", () => {
  const matrix = matrixFixture();
  matrix.cases[1] = structuredClone(matrix.cases[0]!);
  expect(() => parseConsumerContractMatrix(matrix)).toThrow();
  const duplicate = matrixFixture();
  duplicate.cases[0]!.scenarios[1] = { ...duplicate.cases[0]!.scenarios[0]! };
  expect(() => parseConsumerContractMatrix(duplicate)).toThrow();
  const unsafe = matrixFixture();
  unsafe.cases[0]!.scenarios.find(item => item.name === "missing-authority-field")!.expected = "compatible";
  expect(() => parseConsumerContractMatrix(unsafe)).toThrow();
});
