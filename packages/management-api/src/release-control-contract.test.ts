import { describe, expect, test } from "bun:test";
import {
  assertReleaseReceiptTransition,
  parseReleaseReceipt,
  parseReleaseScope,
  releaseScopeSha256,
} from "./release-control-contract";

const scope = {
  schema: "supacloud.release-control.v2",
  releaseId: "release-20260906-001",
  sourceCommit: "a".repeat(40),
  targetEnvironmentId: "production",
  targetProjectRef: "a".repeat(20),
  components: [
    { kind: "function", slug: "fa-api", artifactSha256: "b".repeat(64) },
    { kind: "migration", name: "20260906120000_feedback_assignee_name_fallback" },
    { kind: "web", artifactSha256: "c".repeat(64) },
  ],
} as const;

describe("release control contract", () => {
  test("parses a deterministic cross-surface scope and hashes its canonical form", () => {
    const parsed = parseReleaseScope(scope);
    expect(releaseScopeSha256(parsed)).toHaveLength(64);
    expect(releaseScopeSha256(parsed)).toBe(releaseScopeSha256(parseReleaseScope({
      schema: scope.schema,
      releaseId: scope.releaseId,
      sourceCommit: scope.sourceCommit,
      targetEnvironmentId: scope.targetEnvironmentId,
      targetProjectRef: scope.targetProjectRef,
      components: scope.components.map((component) => ({ ...component })),
    })));
  });

  test("rejects duplicate or unsorted release components", () => {
    expect(() => parseReleaseScope({
      ...scope,
      components: [scope.components[1], scope.components[0], scope.components[2]],
    })).toThrow("unique and sorted");
  });

  test("rejects a scope without a concrete target environment", () => {
    const { targetEnvironmentId: _targetEnvironmentId, ...legacyScope } = scope;
    expect(() => parseReleaseScope(legacyScope)).toThrow("unsupported or missing fields");
    expect(() => parseReleaseScope({ ...scope, targetEnvironmentId: " " })).toThrow(
      "targetEnvironmentId is invalid",
    );
  });

  test("requires read-back payloads for applied and reconciled receipts", () => {
    const receipt = parseReleaseReceipt({
      schema: "supacloud.release-control.v2",
      releaseId: scope.releaseId,
      scopeSha256: "d".repeat(64),
      phase: "reconciled",
      beforeReadBack: { functions: [] },
      afterReadBack: { functions: [{ slug: "fa-api", artifactSha256: "b".repeat(64) }] },
    });
    expect(receipt.phase).toBe("reconciled");
    expect(() => parseReleaseReceipt({
      ...receipt,
      afterReadBack: null,
    })).toThrow("requires before and after read-back");
  });

  test("allows recovery from unknown mutation outcomes but rejects terminal rewrites", () => {
    expect(() => assertReleaseReceiptTransition("mutating", "rollback-required")).not.toThrow();
    expect(() => assertReleaseReceiptTransition("rollback-required", "reconciled")).not.toThrow();
    expect(() => assertReleaseReceiptTransition("reconciled", "mutating")).toThrow("Invalid release receipt transition");
    expect(() => assertReleaseReceiptTransition("rolled-back", "reconciled")).toThrow("Invalid release receipt transition");
  });
});
