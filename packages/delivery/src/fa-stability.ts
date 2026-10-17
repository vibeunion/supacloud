import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { canonical, digest } from "./delivery-files";
import { parseConsumerContractMatrix } from "./contract-matrix";
import { isFaDeliveryTupleActive, parseFaDeliveryTuple } from "./delivery-tuple";

const closed = { additionalProperties: false } as const;
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const label = Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" });
const timestamp = Type.String({ minLength: 24, maxLength: 24 });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const environment = Type.Union([Type.Literal("test"), Type.Literal("production")]);

export const FA_REQUIRED_ACCEPTANCE = {
  login: "real-browser",
  permissions: "real-http",
  upload: "real-http",
  "async-task": "real-worker",
  deploy: "real-http",
  "database-migration": "real-database",
  schedule: "real-worker",
  rollback: "real-drill",
  "error-policy": "real-http",
  "alert-delivery": "real-drill",
} as const;

export const FA_BUSINESS_OPERATIONS = ["login", "permissions", "upload", "async-task", "report", "deploy"] as const;
const operation = Type.Enum(FA_BUSINESS_OPERATIONS);
const proof = Type.Object({
  path: Type.String({ pattern: "^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,255}$" }),
  sha256: hash,
}, closed);

export const FaBusinessObservationSchema = Type.Object({
  id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" }),
  tuple_sha256: hash,
  operation,
  started_at: timestamp,
  finished_at: timestamp,
  outcome: Type.Enum(["success", "failure", "timeout", "unknown"]),
  attempts: Type.Integer({ minimum: 1, maximum: 1000 }),
  rollbacks: count,
}, closed);
export type FaBusinessObservation = Static<typeof FaBusinessObservationSchema>;

export const FaServiceObjectivesSchema = Type.Object({
  status: Type.Literal("approved"),
  owner: label, approval_reference: label, approved_at: timestamp,
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  environment,
  alert_route: label,
  window_hours: Type.Number({ exclusiveMinimum: 0, maximum: 8760 }),
  max_evidence_age_hours: Type.Number({ exclusiveMinimum: 0, maximum: 168 }),
  operations: Type.Array(Type.Object({
    operation,
    minimum_samples: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    availability_percent: Type.Number({ exclusiveMinimum: 0, maximum: 100 }),
    p95_ms: Type.Number({ exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }, closed), { minItems: FA_BUSINESS_OPERATIONS.length, maxItems: FA_BUSINESS_OPERATIONS.length }),
}, closed);
export type FaServiceObjectives = Static<typeof FaServiceObjectivesSchema>;

export const FaStabilityEvidenceSchema = Type.Object({
  schema: Type.Literal("supacloud.fa-stability-evidence.v1"),
  environment,
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  tuple_sha256: hash, matrix_sha256: hash, objectives_sha256: hash,
  recorded_at: timestamp, window_start: timestamp, window_end: timestamp,
  reviewed_by: label, review_reference: label,
  acceptance: Type.Array(Type.Object({
    id: Type.Enum(Object.keys(FA_REQUIRED_ACCEPTANCE) as Array<keyof typeof FA_REQUIRED_ACCEPTANCE>),
    execution: Type.Enum([
      "real-browser", "real-http", "real-worker", "real-database", "real-drill", "local-fake",
    ]),
    passed: Type.Boolean(), measured_at: timestamp, proof,
  }, closed), { minItems: 10, maxItems: 10 }),
  matrix: Type.Array(Type.Object({
    combination: label, scenario: label,
    outcome: Type.Union([Type.Literal("compatible"), Type.Literal("blocked-safely")]),
    execution: Type.Union([Type.Literal("real-http-and-database"), Type.Literal("local-fake")]),
    passed: Type.Boolean(), measured_at: timestamp, proof,
  }, closed), { minItems: 48, maxItems: 48 }),
  observation: proof,
  alert: Type.Object({ route: label, acknowledged_by: label, delivered_at: timestamp }, closed),
}, closed);
export type FaStabilityEvidence = Static<typeof FaStabilityEvidenceSchema>;
export type FaProof = Static<typeof proof>;

export const faEvidenceDigest = (value: unknown): string => digest(canonical(value));
export function faEvidenceTime(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}

export function parseFaStabilityEvidence(value: unknown): FaStabilityEvidence {
  if (!Value.Check(FaStabilityEvidenceSchema, value)) throw new Error("Invalid FA stability evidence.");
  return structuredClone(value);
}

export function faEvidenceProofs(evidence: FaStabilityEvidence): FaProof[] {
  return [...evidence.acceptance.map(item => item.proof), ...evidence.matrix.map(item => item.proof), evidence.observation];
}

/** Terminal logical operations, not attempts. Failed/unknown outcomes stay in the denominator. */
export function measureFaBusinessObservations(value: unknown, options: {
  tupleSha256: string; start: number; end: number;
}) {
  if (!Number.isFinite(options.start) || !Number.isFinite(options.end) || options.start >= options.end) {
    throw new Error("Invalid FA business observation window.");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 100_000
    || !value.every(item => Value.Check(FaBusinessObservationSchema, item))) {
    throw new Error("Invalid FA business observations.");
  }
  const observations = value as FaBusinessObservation[];
  const ids = new Set<string>();
  for (const item of observations) {
    const start = faEvidenceTime(item.started_at), end = faEvidenceTime(item.finished_at);
    if (ids.has(item.id) || item.tuple_sha256 !== options.tupleSha256
      || !Number.isFinite(start) || !Number.isFinite(end)
      || start < options.start || end > options.end || start > end) {
      throw new Error("Invalid FA business observation binding.");
    }
    ids.add(item.id);
  }
  return FA_BUSINESS_OPERATIONS.map(operation => {
    const items = observations.filter(item => item.operation === operation);
    const durations = items.map(item => faEvidenceTime(item.finished_at) - faEvidenceTime(item.started_at)).sort((a, b) => a - b);
    return {
      operation, samples: items.length,
      availability_percent: items.length ? 100 * items.filter(item => item.outcome === "success").length / items.length : null,
      p95_ms: durations[Math.ceil(durations.length * 0.95) - 1] ?? null,
      timeouts: items.filter(item => item.outcome === "timeout").length,
      unknown: items.filter(item => item.outcome === "unknown").length,
      retries: items.reduce((sum, item) => sum + item.attempts - 1, 0),
      rollbacks: items.reduce((sum, item) => sum + item.rollbacks, 0),
    };
  });
}

export function checkFaStability(input: {
  tuple: unknown; matrix: unknown; objectives: unknown; evidence: unknown; observations: unknown;
  expectedProjectRef: string; expectedEnvironment: "test" | "production"; now?: number;
}) {
  const tuple = parseFaDeliveryTuple(input.tuple);
  const matrix = parseConsumerContractMatrix(input.matrix);
  const evidence = parseFaStabilityEvidence(input.evidence);
  const now = input.now ?? Date.now();
  const blockers: string[] = [];
  if (!Value.Check(FaServiceObjectivesSchema, input.objectives)) {
    return { ready: false, blockers: ["SLO_OBJECTIVES_NOT_APPROVED_OR_INVALID"], metrics: [] };
  }
  const objectives = input.objectives;
  const tupleSha = faEvidenceDigest(tuple);
  const start = faEvidenceTime(evidence.window_start), end = faEvidenceTime(evidence.window_end);
  const approved = faEvidenceTime(objectives.approved_at);
  const recent = (stamp: string) => {
    const time = faEvidenceTime(stamp);
    return Number.isFinite(time) && time <= now && time >= approved
      && now - time <= objectives.max_evidence_age_hours * 3_600_000;
  };
  if (!Number.isFinite(now) || !isFaDeliveryTupleActive(tuple, now)) blockers.push("COMPATIBILITY_WINDOW_INVALID");
  if (!tuple.compatibility_window.old_client_supported || !tuple.compatibility_window.partial_deployment_supported) {
    blockers.push("COMPATIBILITY_WINDOW_REQUIRED");
  }
  if (evidence.project_ref !== input.expectedProjectRef || objectives.project_ref !== input.expectedProjectRef
    || evidence.environment !== input.expectedEnvironment || objectives.environment !== input.expectedEnvironment) {
    blockers.push("ENVIRONMENT_MISMATCH");
  }
  if (evidence.tuple_sha256 !== tupleSha || matrix.candidate_tuple_sha256 !== tupleSha
    || evidence.matrix_sha256 !== faEvidenceDigest(matrix)
    || evidence.objectives_sha256 !== faEvidenceDigest(objectives)) blockers.push("ARTIFACT_BINDING_MISMATCH");
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(approved) || approved > start
    || end - start < objectives.window_hours * 3_600_000 || !recent(evidence.window_end)
    || !recent(evidence.recorded_at) || faEvidenceTime(evidence.recorded_at) < end
    || start < faEvidenceTime(tuple.compatibility_window.starts_at)) blockers.push("OBSERVATION_WINDOW_INVALID");
  if (evidence.reviewed_by !== objectives.owner) blockers.push("EVIDENCE_OWNER_MISMATCH");
  const checks = new Map(evidence.acceptance.map(item => [item.id, item]));
  if (checks.size !== evidence.acceptance.length) blockers.push("DUPLICATE_ACCEPTANCE");
  for (const id of Object.keys(FA_REQUIRED_ACCEPTANCE) as Array<keyof typeof FA_REQUIRED_ACCEPTANCE>) {
    const execution = FA_REQUIRED_ACCEPTANCE[id];
    const item = checks.get(id);
    if (!item || item.execution !== execution || !item.passed || !recent(item.measured_at)) blockers.push(`ACCEPTANCE_REQUIRED:${id}`);
  }
  const matrixChecks = new Map(evidence.matrix.map(item => [`${item.combination}:${item.scenario}`, item]));
  if (matrixChecks.size !== evidence.matrix.length) blockers.push("DUPLICATE_MATRIX_CHECK");
  for (const row of matrix.cases) {
    for (const scenario of row.scenarios) {
      const key = `${row.frontend}/${row.functions}/${row.database}:${scenario.name}`;
      const item = matrixChecks.get(key);
      if (!item || item.execution !== "real-http-and-database" || !item.passed || item.outcome !== scenario.expected
        || !recent(item.measured_at)) blockers.push(`MATRIX_REQUIRED:${key}`);
    }
  }
  if (evidence.alert.route !== objectives.alert_route || !recent(evidence.alert.delivered_at)) {
    blockers.push("ALERT_DELIVERY_NOT_VERIFIED");
  }
  const metrics = measureFaBusinessObservations(input.observations, { tupleSha256: tupleSha, start, end });
  if (new Set(objectives.operations.map(item => item.operation)).size !== FA_BUSINESS_OPERATIONS.length) {
    blockers.push("DUPLICATE_SLO_OBJECTIVE");
  }
  for (const target of objectives.operations) {
    const measured = metrics.find(item => item.operation === target.operation)!;
    if (measured.samples < target.minimum_samples) blockers.push(`INSUFFICIENT_SAMPLES:${target.operation}`);
    if (measured.availability_percent === null || measured.availability_percent < target.availability_percent) {
      blockers.push(`AVAILABILITY_BREACHED:${target.operation}`);
    }
    if (measured.p95_ms === null || measured.p95_ms > target.p95_ms) blockers.push(`LATENCY_BREACHED:${target.operation}`);
  }
  return { ready: blockers.length === 0, blockers, metrics };
}
