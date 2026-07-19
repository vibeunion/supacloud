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
      expect(lockKeys).toEqual(["supacloud:migrations:branch", "supacloud:migrations:parent"]);
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
});
