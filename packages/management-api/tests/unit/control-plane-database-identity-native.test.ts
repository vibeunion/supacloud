// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
  assertExpectedControlPlaneDatabaseIdentity,
  controlPlaneDatabaseFingerprint,
  inspectControlPlaneDatabaseIdentity,
  withExpectedControlPlaneDatabaseTransaction,
} from "../../src/db/control-plane-database-identity";
import { fixtureRow, fixtureRows } from "../helpers/fixture-rows";
import { withNativePostgres } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native upgrade guard binds live snapshots, identity and writes to one transaction",
  async () => withNativePostgres(async database => {
    await database`CREATE TABLE guard_probe (id integer PRIMARY KEY)`;
    await database`INSERT INTO guard_probe VALUES (1)`;
    const identity = await inspectControlPlaneDatabaseIdentity(database);
    expect(identity.databaseName).toBe("fixture");
    expect(identity.databaseOwner).toBe("fixture");
    const fingerprint = controlPlaneDatabaseFingerprint(identity);
    const exporter = await database.reserve();
    let started = false;
    let snapshot: string;
    try {
      await exporter.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ");
      started = true;
      snapshot = fixtureRow(Type.Object({ snapshot: Type.String() }),
        await exporter`SELECT pg_export_snapshot() AS snapshot`).snapshot;
      await database`INSERT INTO guard_probe VALUES (2)`;

      await expect(assertExpectedControlPlaneDatabaseIdentity(database, fingerprint, snapshot))
        .resolves.toBeUndefined();
      let writesStarted = 0;
      await expect(withExpectedControlPlaneDatabaseTransaction(database, async transaction => {
        writesStarted += 1;
        await transaction`INSERT INTO guard_probe VALUES (99)`;
      }, controlPlaneDatabaseFingerprint({ ...identity, databaseName: "wrong_database" }), snapshot))
        .rejects.toThrow("does not match the verified upgrade backup");
      expect(writesStarted).toBe(0);
      expect(await database`SELECT id FROM guard_probe WHERE id = 99`).toHaveLength(0);

      await withExpectedControlPlaneDatabaseTransaction(database, async transaction => {
        expect(fixtureRow(Type.Object({ transaction_isolation: Type.String() }),
          await transaction`SHOW transaction_isolation`))
          .toEqual({ transaction_isolation: "repeatable read" });
        expect(fixtureRows(Type.Object({ id: Type.Integer() }),
          await transaction`SELECT id FROM guard_probe ORDER BY id`)).toEqual([{ id: 1 }]);
        await transaction`INSERT INTO guard_probe VALUES (3)`;
      }, fingerprint, snapshot);
      expect(fixtureRows(Type.Object({ id: Type.Integer() }),
        await database`SELECT id FROM guard_probe ORDER BY id`))
        .toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

      await expect(withExpectedControlPlaneDatabaseTransaction(database, async transaction => {
        await transaction`INSERT INTO guard_probe VALUES (4)`;
        throw new Error("fixture migration failed");
      }, fingerprint, snapshot)).rejects.toThrow("fixture migration failed");
      expect(await database`SELECT id FROM guard_probe WHERE id = 4`).toHaveLength(0);
    } finally {
      try {
        if (started) await exporter.unsafe("ROLLBACK");
      } finally {
        exporter.release();
      }
    }
    await expect(assertExpectedControlPlaneDatabaseIdentity(database, fingerprint, snapshot))
      .rejects.toThrow("could not verify the live backup snapshot");
  }),
  40_000,
);
