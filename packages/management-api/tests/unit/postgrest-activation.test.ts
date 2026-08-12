import { describe, expect, mock, test } from "bun:test";
import {
  PostgrestActivationRolledBackError,
  PostgrestActivationRollbackError,
  completePostgrestActivation,
} from "../../src/services/postgrest-activation";

describe("PostgREST generation activation transaction", () => {
  test("returns only after the candidate activation succeeds", async () => {
    const rollback = mock(async () => {});
    const status = await completePostgrestActivation({
      projectRef: "tenant-a",
      previousPointerTarget: "tenant-a_postgrest.d/old.conf",
      activate: async () => "healthy",
      rollback,
    });

    expect(status).toBe("healthy");
    expect(rollback).not.toHaveBeenCalled();
  });

  test("reports failure after restoring and proving the previous generation", async () => {
    const activationError = new Error("candidate restart failed");
    const rollbackSteps: string[] = [];
    const failure = await completePostgrestActivation({
      projectRef: "tenant-a",
      previousPointerTarget: "tenant-a_postgrest.d/old.conf",
      activate: async () => { throw activationError; },
      rollback: async () => {
        rollbackSteps.push("validate-old", "restore-pointer", "restart", "health", "attest-old");
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PostgrestActivationRolledBackError);
    expect((failure as Error).cause).toBe(activationError);
    expect(rollbackSteps).toEqual([
      "validate-old",
      "restore-pointer",
      "restart",
      "health",
      "attest-old",
    ]);
  });

  test("preserves candidate and rollback failures", async () => {
    const activationError = new Error("candidate unhealthy");
    const rollbackError = new Error("previous generation unhealthy");
    const failure = await completePostgrestActivation({
      projectRef: "tenant-a",
      previousPointerTarget: "tenant-a_postgrest.d/old.conf",
      activate: async () => { throw activationError; },
      rollback: async () => { throw rollbackError; },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PostgrestActivationRollbackError);
    expect((failure as PostgrestActivationRollbackError).errors).toEqual([
      activationError,
      rollbackError,
    ]);
  });

  test("fails closed after cleaning a first generation with no rollback target", async () => {
    const activationError = new Error("first start failed");
    const cleanupTargets: Array<string | null> = [];
    const failure = await completePostgrestActivation({
      projectRef: "tenant-a",
      previousPointerTarget: null,
      activate: async () => { throw activationError; },
      rollback: async (previousPointerTarget) => {
        cleanupTargets.push(previousPointerTarget);
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PostgrestActivationRolledBackError);
    expect((failure as Error).cause).toBe(activationError);
    expect(cleanupTargets).toEqual([null]);
  });
});
