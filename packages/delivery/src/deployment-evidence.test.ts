import { expect, test } from "bun:test";
import {
  deriveDeploymentEvidenceStatus,
  formatDeploymentEvidence,
  parseDeploymentEvidence,
  type DeploymentEvidence,
} from "./deployment-evidence";

const confirmed = "2026-10-04T00:00:00.000Z";
const hash = "a".repeat(64);
const release = "b".repeat(64);
const activation = "11111111-1111-4111-8111-111111111111";

function evidence(overrides: Partial<DeploymentEvidence> = {}): DeploymentEvidence {
  const base: DeploymentEvidence = {
    schema: "supacloud.deployment-evidence.v1",
    status: "confirmed",
    recorded_at: confirmed,
    scope: { project_ref: "project-a", application_id: "orders", environment_id: "production" },
    source: {
      commit_sha: "abcdef1234567",
      manifest_sha256: hash,
      contract_schema: "supacloud.application-development.v1",
      environment_binding_version: hash,
    },
    database: {
      provider: "postgresql",
      version: "18.0",
      topology: "single-node",
      migration: { status: "confirmed", inventory_sha256: hash, compatibility: "verified" },
      backup: { status: "confirmed", latest_success_at: confirmed, freshness_seconds: 60 },
      recovery: { status: "confirmed", drill_id: "drill-2026-10-04", rpo_seconds: 60, rto_seconds: 300 },
    },
    components: ([
      "management-api", "web-console", "edge-runtime", "worker", "postgres",
      "postgrest", "gotrue", "storage", "realtime",
    ] as const).map(name => ({ name, version: "1.0.0", status: "confirmed" as const, health_check: "/health", checked_at: confirmed })),
    activation: { release_id: release, configuration_id: activation, activation_id: activation },
    health: { status: "confirmed", checked_at: confirmed, authenticated_smoke: "confirmed" },
    rollback: { release_id: release, configuration_id: activation, status: "ready", result: null },
    notes: [],
  };
  return { ...base, ...overrides };
}

test("derives confirmed only when single-node operational evidence is complete", () => {
  const value = evidence();
  expect(deriveDeploymentEvidenceStatus(value)).toBe("confirmed");
  expect(parseDeploymentEvidence(value)).toEqual(value);
  expect(formatDeploymentEvidence(value)).toContain("status:     confirmed");
});

test("unknown observations cannot become confirmed", () => {
  const base = evidence();
  const value = evidence({
    database: {
      ...base.database,
      backup: { ...base.database.backup, status: "unknown" },
    },
    status: "unknown",
  });
  expect(deriveDeploymentEvidenceStatus(value)).toBe("unknown");
  expect(parseDeploymentEvidence(value)).toEqual(value);
});

test("missing recovery proof is incomplete", () => {
  const base = evidence();
  const value = evidence({
    database: {
      ...base.database,
      recovery: { status: "confirmed", drill_id: null, rpo_seconds: null, rto_seconds: null },
    },
    status: "incomplete",
  });
  expect(deriveDeploymentEvidenceStatus(value)).toBe("incomplete");
  expect(parseDeploymentEvidence(value)).toEqual(value);
});

test("rejects stale or duplicate component evidence", () => {
  const value = evidence({
    components: [
      { name: "management-api", version: "1.0.0", status: "confirmed", health_check: "/health", checked_at: confirmed },
      { name: "management-api", version: "1.0.0", status: "confirmed", health_check: "/health", checked_at: confirmed },
    ],
    status: "incomplete",
  });
  expect(() => parseDeploymentEvidence(value)).toThrow("Invalid deployment evidence.");
});

test("failed evidence has precedence over incomplete evidence", () => {
  const base = evidence();
  const value = evidence({
    database: {
      ...base.database,
      recovery: { status: "failed", drill_id: "drill-failed", rpo_seconds: null, rto_seconds: null },
    },
    status: "failed",
  });
  expect(deriveDeploymentEvidenceStatus(value)).toBe("failed");
  expect(parseDeploymentEvidence(value)).toEqual(value);
});
