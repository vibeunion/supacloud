import { expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  ensurePlatformV2Schema,
  ensurePlatformV2SchemaInTransaction,
} from "../../src/db/platform-v2";
import { splitSqlStatements } from "../../src/db/sql-statements";

type FakeTransaction = {
  (strings: TemplateStringsArray): Promise<unknown[]>;
  unsafe: (statement: string) => Promise<void>;
};

function fakeControlPool(options: { failAt?: number } = {}) {
  const transactionalStatements: string[] = [];
  let beginCalls = 0;
  let taggedCalls = 0;
  let rolledBack = false;

  const transaction = Object.assign(
    async () => {
      taggedCalls += 1;
      return [];
    },
    {
      unsafe: async (statement: string) => {
        transactionalStatements.push(statement);
        if (transactionalStatements.length === options.failAt) {
          throw new Error("platform bootstrap fixture failure");
        }
      },
    },
  ) as FakeTransaction;
  const database = {
    begin: async (callback: (activeTransaction: FakeTransaction) => Promise<void>) => {
      beginCalls += 1;
      try {
        await callback(transaction);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  } as unknown as SQL;

  return {
    database,
    transactionalStatements,
    observations: () => ({ beginCalls, taggedCalls, rolledBack }),
  };
}

test("platform v2 bootstrap executes canonical DDL as individual statements in one transaction", async () => {
  const fixture = fakeControlPool();
  await ensurePlatformV2SchemaInTransaction(fixture.database);

  const observations = fixture.observations();
  expect(observations.beginCalls).toBe(1);
  expect(observations.rolledBack).toBe(false);
  expect(observations.taggedCalls).toBeGreaterThan(1);
  expect(fixture.transactionalStatements.length).toBeGreaterThan(30);
  expect(fixture.transactionalStatements).toContainEqual(expect.stringContaining(
    "ALTER COLUMN recovery_not_before DROP DEFAULT",
  ));
  for (const statement of fixture.transactionalStatements) {
    expect(splitSqlStatements(statement)).toHaveLength(1);
  }
});

test("canonical init reuses its outer transaction without nesting begin", async () => {
  const fixture = fakeControlPool();
  await fixture.database.begin(async (transaction) => ensurePlatformV2Schema(transaction));

  expect(fixture.observations()).toEqual({ beginCalls: 1, taggedCalls: 1, rolledBack: false });
});

test("canonical init rolls back and stops before owner backfill when DDL fails", async () => {
  const fixture = fakeControlPool({ failAt: 3 });
  await expect(
    fixture.database.begin(async (transaction) => ensurePlatformV2Schema(transaction)),
  ).rejects.toThrow("platform bootstrap fixture failure");

  expect(fixture.observations()).toEqual({ beginCalls: 1, taggedCalls: 0, rolledBack: true });
  expect(fixture.transactionalStatements).toHaveLength(3);
});
