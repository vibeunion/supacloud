import { expect, test } from "bun:test";
import { FA_CONTRACT_SCENARIOS, type ConsumerContractMatrix } from "./contract-matrix";
import type { FaDeliveryTuple } from "./delivery-tuple";
import {
  checkFaStability, faEvidenceDigest, FA_BUSINESS_OPERATIONS, FA_REQUIRED_ACCEPTANCE,
  measureFaBusinessObservations, parseFaStabilityEvidence,
  type FaBusinessObservation, type FaServiceObjectives, type FaStabilityEvidence,
} from "./fa-stability";

// Deliberately synthetic. These fixtures never become release evidence.
function fixture() {
  const tuple: FaDeliveryTuple = {
    schema: "supacloud.fa-delivery-tuple.v1", customer: "xigu-fa",
    fa_commit: "a".repeat(40), platform_commit: "b".repeat(40), cli: { version: "0.96.1" },
    edge_runtime: { version: "test-only", artifact_sha256: "c".repeat(64) },
    compatibility_window: {
      contract_schema: "test-only", starts_at: "2026-10-14T00:00:00.000Z",
      ends_at: "2026-10-16T00:00:00.000Z", old_client_supported: true, partial_deployment_supported: true,
    },
  };
  const tupleSha = faEvidenceDigest(tuple);
  const matrix: ConsumerContractMatrix = {
    schema: "supacloud.consumer-contract-matrix.v1", customer: "xigu-fa",
    baseline_tuple_sha256: "d".repeat(64), candidate_tuple_sha256: tupleSha,
    artifacts: {
      frontend: { old: "1".repeat(64), new: "2".repeat(64) },
      functions: { old: "3".repeat(64), new: "4".repeat(64) },
      database: { old: "5".repeat(64), new: "6".repeat(64) },
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
  const objectives: FaServiceObjectives = {
    status: "approved", owner: "fixture-owner", approval_reference: "test-only",
    approved_at: "2026-10-14T00:00:00.000Z", project_ref: "fixture", environment: "test",
    alert_route: "fixture-route", window_hours: 1, max_evidence_age_hours: 24,
    operations: FA_BUSINESS_OPERATIONS.map(operation => ({
      operation, minimum_samples: 1, availability_percent: 99, p95_ms: 1000,
    })),
  };
  const proof = { path: "test-only.json", sha256: "d".repeat(64) };
  const measured_at = "2026-10-14T01:00:00.000Z";
  const evidence: FaStabilityEvidence = {
    schema: "supacloud.fa-stability-evidence.v1",
    project_ref: "fixture", environment: "test", tuple_sha256: tupleSha,
    matrix_sha256: faEvidenceDigest(matrix), objectives_sha256: faEvidenceDigest(objectives),
    recorded_at: measured_at, window_start: "2026-10-14T00:00:00.000Z", window_end: measured_at,
    reviewed_by: "fixture-owner", review_reference: "test-only",
    acceptance: (Object.keys(FA_REQUIRED_ACCEPTANCE) as Array<keyof typeof FA_REQUIRED_ACCEPTANCE>).map(id => ({
      id, execution: FA_REQUIRED_ACCEPTANCE[id], passed: true, measured_at, proof,
    })),
    matrix: matrix.cases.flatMap(row => row.scenarios.map(scenario => ({
      combination: `${row.frontend}/${row.functions}/${row.database}`, scenario: scenario.name,
      outcome: scenario.expected, execution: "real-http-and-database", passed: true, measured_at, proof,
    }))),
    observation: { path: "observations.json", sha256: "e".repeat(64) },
    alert: { route: "fixture-route", acknowledged_by: "fixture-owner", delivered_at: measured_at },
  };
  const observations: FaBusinessObservation[] = FA_BUSINESS_OPERATIONS.map(operation => ({
    id: operation, tuple_sha256: tupleSha, operation,
    started_at: "2026-10-14T00:00:00.000Z", finished_at: "2026-10-14T00:00:00.100Z",
    outcome: "success", attempts: 1, rollbacks: 0,
  }));
  return {
    tuple, matrix, objectives, evidence, observations,
    expectedProjectRef: "fixture", expectedEnvironment: "test" as const,
    now: Date.parse("2026-10-14T02:00:00.000Z"),
  };
}

test("complete synthetic data validates, without attesting the provenance of a JSON file", () => {
  const result = checkFaStability(fixture());
  expect(result.ready).toBe(true);
  expect(result.metrics.map(item => item.samples)).toEqual([1, 1, 1, 1, 1, 1]);
});

test("pending business objectives cannot be treated as approved", () => {
  expect(checkFaStability({ ...fixture(), objectives: { status: "pending" } }).blockers)
    .toContain("SLO_OBJECTIVES_NOT_APPROVED_OR_INVALID");
});

test("a test result cannot establish production acceptance", () => {
  expect(checkFaStability({ ...fixture(), expectedEnvironment: "production" }).blockers).toContain("ENVIRONMENT_MISMATCH");
});

test("tuple, matrix, policy and platform artifact changes invalidate evidence", () => {
  for (const change of ["platform", "edge", "matrix", "objectives"] as const) {
    const input = fixture();
    if (change === "platform") input.tuple.platform_commit = "f".repeat(40);
    if (change === "edge") input.tuple.edge_runtime.artifact_sha256 = "f".repeat(64);
    if (change === "matrix") input.matrix.artifacts.database.new = "f".repeat(64);
    if (change === "objectives") input.objectives.window_hours = 2;
    // Keep observation binding independent so the specific aggregate blocker is visible.
    for (const observation of input.observations) observation.tuple_sha256 = faEvidenceDigest(input.tuple);
    expect(checkFaStability(input).blockers).toContain("ARTIFACT_BINDING_MISMATCH");
  }
});

test("every missing or fake acceptance scenario blocks", () => {
  for (const id of Object.keys(FA_REQUIRED_ACCEPTANCE)) {
    const input = fixture();
    input.evidence.acceptance.find(item => item.id === id)!.execution = "local-fake";
    expect(checkFaStability(input).blockers).toContain(`ACCEPTANCE_REQUIRED:${id}`);
  }
});

test("a rollback plan or unknown result is not a successful drill", () => {
  const input = fixture();
  input.evidence.acceptance.find(item => item.id === "rollback")!.passed = false;
  expect(checkFaStability(input).blockers).toContain("ACCEPTANCE_REQUIRED:rollback");
});

test("duplicates cannot substitute for missing checks", () => {
  const input = fixture();
  input.evidence.acceptance[0] = { ...input.evidence.acceptance[1]! };
  input.evidence.matrix[0] = { ...input.evidence.matrix[1]! };
  const result = checkFaStability(input);
  expect(result.blockers).toContain("DUPLICATE_ACCEPTANCE");
  expect(result.blockers).toContain("DUPLICATE_MATRIX_CHECK");
  expect(result.ready).toBe(false);
});

test("local compatibility simulations cannot pass the real database matrix gate", () => {
  const input = fixture();
  input.evidence.matrix[0]!.execution = "local-fake";
  expect(checkFaStability(input).blockers).toContain("MATRIX_REQUIRED:old/old/old:missing-display-field");
});

test("malformed and omitted evidence fails closed", () => {
  for (const raw of [null, {}, { schema: "supacloud.fa-stability-evidence.v1" }]) {
    expect(() => parseFaStabilityEvidence(raw)).toThrow();
  }
  const input = fixture();
  input.evidence.acceptance.pop();
  expect(() => checkFaStability(input)).toThrow();
});

test("expired, future and invalid timestamps cannot pass", () => {
  for (const stamp of ["2026-10-12T00:00:00.000Z", "2026-10-17T00:00:00.000Z", "2026-13-14T00:00:00.000Z"]) {
    const input = fixture();
    input.evidence.acceptance[0]!.measured_at = stamp;
    expect(checkFaStability(input).blockers).toContain("ACCEPTANCE_REQUIRED:login");
  }
});

test("owner and alert route need to match the approved objective", () => {
  const input = fixture();
  input.evidence.reviewed_by = "somebody-else";
  input.evidence.alert.route = "undelivered-route";
  const result = checkFaStability(input);
  expect(result.blockers).toContain("EVIDENCE_OWNER_MISMATCH");
  expect(result.blockers).toContain("ALERT_DELIVERY_NOT_VERIFIED");
});

test("unknown/timeout logical operations count as failures and p95 includes all outcomes", () => {
  const input = fixture();
  const first = input.observations[0]!;
  first.outcome = "unknown";
  first.attempts = 3;
  first.rollbacks = 1;
  input.observations.push({ ...first, id: "login-timeout", outcome: "timeout", finished_at: "2026-10-14T00:00:05.000Z" });
  const result = checkFaStability(input);
  expect(result.metrics[0]).toMatchObject({
    samples: 2, availability_percent: 0, p95_ms: 5000, timeouts: 1, unknown: 1, retries: 4, rollbacks: 2,
  });
  expect(result.blockers).toContain("AVAILABILITY_BREACHED:login");
  expect(result.blockers).toContain("LATENCY_BREACHED:login");
});

test("missing business traffic is not a healthy zero-error rate", () => {
  const input = fixture();
  input.observations.pop();
  expect(checkFaStability(input).blockers).toContain("INSUFFICIENT_SAMPLES:deploy");
});

test("rejects duplicate operations and evidence from another artifact or outside the window", () => {
  for (const change of ["duplicate", "artifact", "timestamp"] as const) {
    const input = fixture();
    if (change === "duplicate") input.observations.push({ ...input.observations[0]! });
    if (change === "artifact") input.observations[0]!.tuple_sha256 = "f".repeat(64);
    if (change === "timestamp") input.observations[0]!.finished_at = "2026-10-15T01:00:00.000Z";
    expect(() => checkFaStability(input)).toThrow("Invalid FA business observation binding.");
  }
});

test("no export operation can enter this acceptance scope", () => {
  expect(() => measureFaBusinessObservations([{ ...fixture().observations[0]!, operation: "report-export" }], {
    tupleSha256: "a".repeat(64), start: 0, end: Date.now(),
  })).toThrow();
});
