import { describe, expect, mock, spyOn, test } from "bun:test";
import { sql } from "../../src/db";
import {
  ProjectMigrationLockError,
  withProjectMigrationLocks,
} from "../../src/services/migration-lock";

function fakeLockConnection(lockResults: boolean[]) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const release = mock(() => {});
  const connection = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join("?");
      calls.push({ sql: statement, values });
      if (statement.includes("pg_try_advisory_lock")) {
        return [{ locked: lockResults.shift() ?? false }];
      }
      return [];
    },
    { release },
  );
  return { connection, calls, release };
}

describe("project migration locks", () => {
  test("backup and migration nesting reuses the acquired project lock", async () => {
    const fake = fakeLockConnection([true]);
    const reserveSpy = spyOn(sql, "reserve").mockResolvedValue(fake.connection as never);
    try {
      const result = await withProjectMigrationLocks({ projectRefs: ["project"] }, async () => {
        expect(await withProjectMigrationLocks({ projectRefs: ["project"] }, async () => "backup")).toBe("backup");
        expect(fake.release).not.toHaveBeenCalled();
        return withProjectMigrationLocks({ projectRefs: ["project"] }, async () => "migration");
      });
      expect(result).toBe("migration");
      expect(reserveSpy).toHaveBeenCalledTimes(1);
      expect(fake.calls.filter(call => call.sql.includes("pg_try_advisory_lock"))).toHaveLength(1);
      expect(fake.release).toHaveBeenCalledTimes(1);
    } finally { reserveSpy.mockRestore(); }
  });

  test("nested lock expansion is rejected before reserving another connection", async () => {
    const fake = fakeLockConnection([true]);
    const reserveSpy = spyOn(sql, "reserve").mockResolvedValue(fake.connection as never);
    try {
      await expect(withProjectMigrationLocks({ projectRefs: ["project"] }, () =>
        withProjectMigrationLocks({ projectRefs: ["other", "project"] }, async () => "unexpected"),
      )).rejects.toThrow("NESTED_LOCK_SCOPE_MISMATCH");
      expect(reserveSpy).toHaveBeenCalledTimes(1);
      expect(fake.release).toHaveBeenCalledTimes(1);
    } finally { reserveSpy.mockRestore(); }
  });

  test("independent operations never inherit another caller's acquired lock", async () => {
    const fake = fakeLockConnection([true, false]);
    const reserveSpy = spyOn(sql, "reserve").mockResolvedValue(fake.connection as never);
    let finish: (() => void) | undefined;
    try {
      const first = withProjectMigrationLocks({ projectRefs: ["project"] },
        () => new Promise<void>(resolve => { finish = resolve; }));
      while (!finish) await Bun.sleep(0);
      await expect(withProjectMigrationLocks({ projectRefs: ["project"] }, async () => undefined))
        .rejects.toBeInstanceOf(ProjectMigrationLockError);
      expect(reserveSpy).toHaveBeenCalledTimes(2);
      finish();
      await first;
    } finally { finish?.(); reserveSpy.mockRestore(); }
  });

  test("a detached nested operation is drained before the outer lock is released", async () => {
    const fake = fakeLockConnection([true]);
    const reserveSpy = spyOn(sql, "reserve").mockResolvedValue(fake.connection as never);
    let finish: (() => void) | undefined;
    try {
      const outer = withProjectMigrationLocks({ projectRefs: ["project"] }, async () => {
        void withProjectMigrationLocks({ projectRefs: ["project"] }, () => new Promise<void>(resolve => { finish = resolve; }));
      });
      while (!finish) await Bun.sleep(0);
      expect(fake.release).not.toHaveBeenCalled();
      finish();
      await outer;
      expect(fake.release).toHaveBeenCalledTimes(1);
    } finally { reserveSpy.mockRestore(); }
  });

  test("an inherited scope after release acquires a fresh lock", async () => {
    const fake = fakeLockConnection([true, true]);
    const reserveSpy = spyOn(sql, "reserve").mockResolvedValue(fake.connection as never);
    let deferred: (() => Promise<void>) | undefined;
    try {
      await withProjectMigrationLocks({ projectRefs: ["project"] }, async () => {
        const { AsyncResource } = await import("node:async_hooks");
        const resource = new AsyncResource("after-migration-lock");
        deferred = () => resource.runInAsyncScope(() =>
          withProjectMigrationLocks({ projectRefs: ["project"] }, async () => undefined));
      });
      await deferred!();
      expect(reserveSpy).toHaveBeenCalledTimes(2);
      expect(fake.release).toHaveBeenCalledTimes(2);
    } finally { reserveSpy.mockRestore(); }
  });

  test("holds sorted project locks on the control connection", async () => {
    const fake = fakeLockConnection([true, true]);
    const reserveSpy = spyOn(sql, "reserve").mockResolvedValue(fake.connection as never);
    const operation = mock(async () => "done");
    try {
      expect(await withProjectMigrationLocks({ projectRefs: ["branch", "parent", "branch"] }, operation)).toBe("done");
      expect(operation).toHaveBeenCalledTimes(1);
      const lockKeys = fake.calls
        .filter((call) => call.sql.includes("pg_try_advisory_lock"))
        .map((call) => call.values[0]);
      expect(lockKeys).toEqual([
        "supacloud:project-database:branch",
        "supacloud:project-database:parent",
      ]);
      expect(fake.calls.filter((call) => call.sql.includes("pg_advisory_unlock(")).length).toBe(2);
      expect(fake.release).toHaveBeenCalledTimes(1);
    } finally {
      reserveSpy.mockRestore();
    }
  });

  test("releases earlier locks when a later project is busy", async () => {
    const fake = fakeLockConnection([true, false]);
    const reserveSpy = spyOn(sql, "reserve").mockResolvedValue(fake.connection as never);
    const operation = mock(async () => "unexpected");
    try {
      await expect(withProjectMigrationLocks({ projectRefs: ["parent", "branch"] }, operation))
        .rejects.toBeInstanceOf(ProjectMigrationLockError);
      expect(operation).not.toHaveBeenCalled();
      expect(fake.calls.filter((call) => call.sql.includes("pg_advisory_unlock(")).length).toBe(1);
      expect(fake.release).toHaveBeenCalledTimes(1);
    } finally {
      reserveSpy.mockRestore();
    }
  });

  test("keeps the session lock until an asynchronous operation completes", async () => {
    const fake = fakeLockConnection([true]);
    const reserveSpy = spyOn(sql, "reserve").mockResolvedValue(fake.connection as never);
    let finishOperation: (() => void) | undefined;
    const operation = mock(() => new Promise<string>((resolve) => {
      finishOperation = () => resolve("done");
    }));
    try {
      const lockedOperation = withProjectMigrationLocks({ projectRefs: ["project"] }, operation);
      for (let attempt = 0; attempt < 10 && operation.mock.calls.length === 0; attempt += 1) {
        await Bun.sleep(0);
      }

      expect(operation).toHaveBeenCalledTimes(1);
      expect(fake.calls.some((call) => call.sql.includes("pg_advisory_unlock("))).toBe(false);
      finishOperation?.();
      await expect(lockedOperation).resolves.toBe("done");
      expect(fake.calls.filter((call) => call.sql.includes("pg_advisory_unlock(")).length).toBe(1);
      expect(fake.release).toHaveBeenCalledTimes(1);
    } finally {
      reserveSpy.mockRestore();
    }
  });
});
