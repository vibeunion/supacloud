import { expect, test } from "bun:test";
import {
  RELEASE_EXECUTION_SCHEMA,
  ReleaseExecutionError,
  createReleaseExecution,
} from "../../src/services/application-release-execution.service";

const record = {
  schema: "supacloud.application-release.v1" as const,
  project_ref: "demo",
  application_id: "reviews",
  release_id: "r".repeat(64),
  manifest_sha256: "m".repeat(64),
  created_at: "2026-09-30T00:00:00.000Z",
  targets: [{ name: "api", object_id: "b".repeat(64), kind: "http" as const, entrypoint: "bundle/index.js" as const }],
};

const observed = { observedAt: "2026-09-30T01:00:00.000Z" };

test("verifies a release only when every required component succeeded", () => {
  const document = createReleaseExecution({
    record, target: "api",
    observations: {
      application: { status: "succeeded", version: "b".repeat(64), ...observed },
      migrations: { status: "succeeded", version: "2", ...observed },
      health: { status: "succeeded", ...observed },
      configuration: { status: "succeeded", version: "cfg_x", ...observed },
    },
  });
  expect(document.schema).toBe(RELEASE_EXECUTION_SCHEMA);
  expect(document.correlation).toBe("release-execution-observation");
  expect(document.release_id).toBe("r".repeat(64));
  expect(document.manifestSha256).toBe("m".repeat(64));
  expect(document.deploymentVerified).toBe(true);
  expect(document.components.map((component) => component.status)).toEqual([
    "succeeded", "succeeded", "succeeded", "unknown", "unknown", "succeeded",
  ]);
  expect(document.components.find((component) => component.name === "migrations")).toMatchObject({
    required: true, version: "2", observedAt: "2026-09-30T01:00:00.000Z",
  });
  expect(document.recovery.application).toContain("previous immutable release");
  expect(document.notes.join(" ")).toContain("stays `unknown`");
});

test("keeps unobserved components unknown and never verifies", () => {
  const document = createReleaseExecution({
    record, target: "api",
    observations: {
      application: { status: "succeeded", ...observed },
      migrations: { status: "succeeded", ...observed },
    },
  });
  expect(document.deploymentVerified).toBe(false);
  expect(document.components.find((component) => component.name === "health")).toMatchObject({
    status: "unknown", required: true, observedAt: null,
  });
});

test("a failed non-required component still blocks verification", () => {
  const document = createReleaseExecution({
    record, target: "api",
    observations: {
      application: { status: "succeeded", ...observed },
      migrations: { status: "succeeded", ...observed },
      health: { status: "succeeded", ...observed },
      secrets: { status: "failed", detail: "credential rejected", ...observed },
    },
  });
  expect(document.deploymentVerified).toBe(false);
  expect(document.components.find((component) => component.name === "secrets")).toMatchObject({
    status: "failed", required: false, detail: "credential rejected",
  });
});

test("rejects an unknown target and malformed observations", () => {
  expect(() => createReleaseExecution({ record, target: "worker" }))
    .toThrow(new ReleaseExecutionError("RELEASE_EXECUTION_TARGET_NOT_FOUND"));

  const invalid = { record, target: "api" } as const;
  expect(() => createReleaseExecution({ ...invalid, observations: { application: { status: "succeeded" } } }))
    .toThrow(new ReleaseExecutionError("RELEASE_EXECUTION_INVALID"));
  expect(() => createReleaseExecution({ ...invalid, observations: { application: { status: "succeeded", observedAt: "not-a-date" } } }))
    .toThrow(new ReleaseExecutionError("RELEASE_EXECUTION_INVALID"));
  expect(() => createReleaseExecution({ ...invalid, observations: { health: { status: "unknown", version: "x" } } }))
    .toThrow(new ReleaseExecutionError("RELEASE_EXECUTION_INVALID"));
  expect(() => createReleaseExecution({ ...invalid, observations: { migrations: { status: "succeeded", observedAt: observed.observedAt, version: "" } } }))
    .toThrow(new ReleaseExecutionError("RELEASE_EXECUTION_INVALID"));
});